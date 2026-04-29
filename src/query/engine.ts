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
import { runAgent } from '../agents/runner.js'
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
  let consecutiveErrors = 0
  let consecutiveEmptyTurns = 0

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

    const hasText = assistantContent.some(
      b => b.type === 'text' && b.text.trim().length > 0
    )

    // empty-turn nudge: the model returned nothing (no text, no tool calls).
    // common after weaker models run tools but fail to synthesize on the next
    // turn. nudge them once or twice; cap to prevent infinite loops.
    if (toolUseBlocks.length === 0 && !hasText) {
      if (consecutiveEmptyTurns >= 2) {
        yield { type: 'done', reason: 'empty_turn_cap', turnCount }
        return
      }
      consecutiveEmptyTurns++
      messages.push({
        role: 'user',
        content: [{
          type: 'text',
          text: `using the tool results above, answer the user's previous request directly. no apology, no preamble.`,
        }],
      })
      turnCount++
      continue
    }
    // any content → reset the empty counter
    consecutiveEmptyTurns = 0

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
    const hasEmptyResults = toolResults.some(r => {
      if (r.isError) return false
      const content = typeof r.content === 'string' ? r.content : ''
      return content.includes('no files matching') || content.includes('no matches for')
    })

    // track consecutive errors across turns. reset on success.
    if (hasErrors) {
      consecutiveErrors++
    } else {
      consecutiveErrors = 0
    }

    if (hasEmptyResults && !hasErrors) {
      messages.push({
        role: 'user',
        content: [
          ...toolResults,
          { type: 'text' as const, text: `the search returned no results. try a different pattern, path, or tool.` },
        ],
      })
    } else if (hasErrors && !signal?.aborted) {
      const errorDetails = toolResults
        .filter(r => r.isError)
        .map(r => typeof r.content === 'string' ? r.content : JSON.stringify(r.content))
        .join('\n')

      const failedTools = toolUseBlocks
        .map(b => `${b.name}(${JSON.stringify(b.input).slice(0, 200)})`)
        .join(', ')

      // first error: simple nudge. second consecutive error: spawn recovery agent.
      if (consecutiveErrors >= 2) {
        // RECOVERY AGENT: fresh context, no bias from the failed attempt
        yield { type: 'tool_start', name: 'recovery agent', id: 'recovery' }

        const diagnosis = await runRecoveryAgent({
          provider,
          model,
          tools,
          signal,
          failedCommand: failedTools,
          errorOutput: errorDetails,
          cwd: context.cwd,
        })

        yield { type: 'tool_end', name: 'recovery agent', id: 'recovery', result: diagnosis }

        messages.push({
          role: 'user',
          content: [
            ...toolResults,
            { type: 'text' as const, text: `[recovery agent diagnosis]\n${diagnosis}\n[end diagnosis]\napply the fix suggested above.` },
          ],
        })
      } else {
        // SIMPLE RECOVERY: structured internal recovery, no narration.
        // the three-step procedure happens silently. user only sees the next
        // tool call (or a result, or a blocking question).
        messages.push({
          role: 'user',
          content: [
            ...toolResults,
            { type: 'text' as const, text: `the previous tool call in this turn errored. recover silently. first, identify the failure: read the error message and note which tool, which arguments, and what went wrong. then infer the cause (bad argument shape, missing permission, wrong path, stale state, tool unavailable, or the result is no longer needed) and settle on the most plausible one. finally, select the next action: retry the same tool with corrected inputs, switch to a different tool that achieves the goal, or skip the call entirely if the result is no longer needed for the user's request.

no apology, no narration, no preamble. the user wants progress, not status reports. speak only when you have a result or a blocking question.` },
          ],
        })
      }

      // continue the loop
      // the model's next turn will have tools and can act on its diagnosis.
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

/**
 * spawn a recovery agent to diagnose a tool failure.
 * fresh context, can read files and check paths.
 * returns a diagnosis string.
 */
async function runRecoveryAgent(opts: {
  provider: ProviderBridge
  model: string
  tools: Tool[]
  signal?: AbortSignal
  failedCommand: string
  errorOutput: string
  cwd: string
}): Promise<string> {
  const result = await runAgent({
    description: 'diagnose error',
    prompt: `a tool call failed. diagnose why and suggest a specific fix.

failed command: ${opts.failedCommand}
error output: ${opts.errorOutput}
working directory: ${opts.cwd}

check if relevant files/paths exist. then report:
1. what went wrong (one sentence)
2. the fix (one actionable step)`,
    provider: opts.provider,
    model: opts.model,
    tools: opts.tools.filter(t => t.name !== 'Agent'),
    maxTurns: 3,
    signal: opts.signal,
  })

  return result.output || 'recovery agent could not diagnose the error'
}

