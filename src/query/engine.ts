/**
 * query engine — the heart of prism.
 * the while(true) loop with recovery paths.
 *
 * while (true)
 *   assemble context → call model → execute tools → repeat
 *   if no tool calls → done
 */

import type {
  ProviderBridge,
  Message,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  StreamEvent,
  ToolSchema,
} from '../types/index.js'
import type { Tool, ToolContext } from '../tools/Tool.js'
import { toolToSchema } from '../tools/Tool.js'
import { runToolCalls, findTool, type PermissionResolver } from '../tools/orchestration.js'
import { countConversationTokens, formatTokens } from '../compact/tokens.js'
import { trimOldToolResults } from '../compact/trimmer.js'
import { snipOldTurns } from '../compact/snip.js'
import { summarizeOldTurns } from '../compact/summarize.js'

export type QueryEvent =
  | { type: 'text'; text: string }
  | { type: 'token_update'; used: number; max: number; formatted: string }
  | { type: 'tool_start'; name: string; id: string }
  | { type: 'tool_end'; name: string; id: string; result: string; isError?: boolean }
  | { type: 'thinking'; text: string }
  | { type: 'error'; error: string }
  | { type: 'done'; reason: string; turnCount: number }

export interface QueryOptions {
  provider: ProviderBridge
  model: string
  systemPrompt: string
  tools: Tool[]
  messages: Message[]
  maxTurns?: number
  signal?: AbortSignal
  askPermission?: PermissionResolver
}

/**
 * the main agentic loop.
 * yields events as they happen — streaming to the UI.
 * modifies messages in place (appends assistant + tool results).
 */
export async function* query(options: QueryOptions): AsyncGenerator<QueryEvent> {
  const {
    provider,
    model,
    systemPrompt,
    tools,
    messages,
    maxTurns = 50,
    signal,
    askPermission,
  } = options

  const capabilities = provider.getCapabilities()
  const toolSchemas = budgetTools(tools, capabilities.maxTools)

  const context: ToolContext = {
    cwd: process.cwd(),
    signal,
  }

  let turnCount = 0

  while (true) {
    // check abort
    if (signal?.aborted) {
      yield { type: 'done', reason: 'aborted', turnCount }
      return
    }

    // check max turns
    if (turnCount >= maxTurns) {
      yield { type: 'done', reason: 'max_turns', turnCount }
      return
    }

    // compression pipeline: trim → snip → summarize
    messages.splice(0, messages.length, ...trimOldToolResults(messages))

    const tokenCount = countConversationTokens(messages)
    yield { type: 'token_update', used: tokenCount, max: capabilities.maxContextTokens, formatted: `${formatTokens(tokenCount)} / ${formatTokens(capabilities.maxContextTokens)}` }

    if (tokenCount > capabilities.maxContextTokens * 0.8) {
      const compressed = await summarizeOldTurns(messages, provider, model)
      messages.splice(0, messages.length, ...compressed)
    } else if (tokenCount > capabilities.maxContextTokens * 0.6) {
      const snipped = snipOldTurns(messages)
      messages.splice(0, messages.length, ...snipped)
    }

    // call model
    const assistantContent: ContentBlock[] = []
    let stopReason = 'end_turn'

    try {
      for await (const event of provider.streamMessage({
        model,
        messages,
        system: systemPrompt,
        tools: toolSchemas,
        signal,
      })) {
        switch (event.type) {
          case 'text_delta':
            yield { type: 'text', text: event.text }
            break

          case 'tool_call_start':
            yield { type: 'tool_start', name: event.name, id: event.id }
            break

          case 'thinking_delta':
            yield { type: 'thinking', text: event.text }
            break

          case 'error':
            yield { type: 'error', error: event.error }
            yield { type: 'done', reason: 'error', turnCount }
            return

          case 'message_end':
            stopReason = event.stopReason
            break
        }

        // collect content blocks from stream
        collectContentBlock(event, assistantContent)
      }
    } catch (error) {
      yield {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
      yield { type: 'done', reason: 'error', turnCount }
      return
    }

    // append assistant message
    messages.push({ role: 'assistant', content: assistantContent })

    // extract tool calls
    const toolUseBlocks = assistantContent.filter(
      (b): b is ToolUseBlock => b.type === 'tool_use'
    )

    // no tool calls → done
    if (toolUseBlocks.length === 0 || stopReason !== 'tool_use') {
      yield { type: 'done', reason: 'completed', turnCount }
      return
    }

    // execute tools
    const toolResults: ToolResultBlock[] = []

    for await (const result of runToolCalls(toolUseBlocks, tools, context, askPermission)) {
      const toolName = toolUseBlocks.find(b => b.id === result.toolUseId)?.name || '?'
      yield {
        type: 'tool_end',
        name: toolName,
        id: result.toolUseId,
        result: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
        isError: result.isError,
      }
      toolResults.push(result)
    }

    // append tool results as user message
    const hasErrors = toolResults.some(r => r.isError)

    if (hasErrors) {
      messages.push({
        role: 'user',
        content: [
          ...toolResults,
          { type: 'text' as const, text: `the command failed. diagnose before acting:
1. list the possible causes, most likely first.
2. tell the user what you think went wrong and why.
3. decide:
   - if the command itself was wrong (bad path, bad args, typo): fix the command.
   - if the command was right but something is missing (package, file, service): fix what is missing, then run the same command again.
   - if the approach is wrong: try a different approach entirely.` },
        ],
      })
    } else {
      messages.push({ role: 'user', content: toolResults })
    }

    turnCount++
  }
}

/**
 * select tools based on model capability.
 */
function budgetTools(tools: Tool[], maxTools: number): ToolSchema[] {
  const selected = tools.slice(0, maxTools)
  return selected.map(t => toolToSchema(t))
}

/**
 * collect content blocks from streaming events.
 * builds up the assistant message as events arrive.
 */
function collectContentBlock(event: StreamEvent, content: ContentBlock[]): void {
  switch (event.type) {
    case 'text_delta': {
      const last = content[content.length - 1]
      if (last?.type === 'text') {
        last.text += event.text
      } else {
        content.push({ type: 'text', text: event.text })
      }
      break
    }

    case 'tool_call_start':
      content.push({
        type: 'tool_use',
        id: event.id,
        name: event.name,
        input: {},
      })
      break

    case 'tool_call_delta': {
      const toolBlock = content.find(
        (b): b is ToolUseBlock => b.type === 'tool_use' && b.id === event.id
      )
      if (toolBlock) {
        try {
          toolBlock.input = JSON.parse(event.inputJson)
        } catch {
          // partial JSON, accumulate
        }
      }
      break
    }

    case 'thinking_delta': {
      const last = content[content.length - 1]
      if (last?.type === 'thinking') {
        last.text += event.text
      } else {
        content.push({ type: 'thinking', text: event.text })
      }
      break
    }
  }
}

