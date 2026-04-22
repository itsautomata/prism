/**
 * subagent runner.
 * executes a focused task with its own message history.
 * shares the provider and tools but gets a fresh conversation.
 */

import type { ProviderBridge, Message, ToolSchema } from '../types/index.js'
import type { Tool } from '../tools/Tool.js'
import { toolToSchema } from '../tools/Tool.js'
import { runToolCalls } from '../tools/orchestration.js'

export type AgentProgressEvent =
  | { type: 'thinking'; agent: string; text: string }
  | { type: 'tool_call'; agent: string; tool: string }
  | { type: 'tool_result'; agent: string; result: string; isError?: boolean }

interface AgentTask {
  prompt: string
  description: string
  provider: ProviderBridge
  model: string
  tools: Tool[]
  maxTurns?: number
  signal?: AbortSignal
  onProgress?: (event: AgentProgressEvent) => void
}

interface AgentResult {
  description: string
  output: string
  turnCount: number
  success: boolean
}

const AGENT_SYSTEM = `you are a focused subagent. you have one task. complete it and report your findings.
be concise. report facts, not process. no preamble.`

/**
 * run a subagent with its own conversation.
 * returns the final text output.
 */
export async function runAgent(task: AgentTask): Promise<AgentResult> {
  const {
    prompt,
    description,
    provider,
    model,
    tools,
    maxTurns = 5,
    signal,
    onProgress,
  } = task

  const emit = onProgress || (() => {})

  const capabilities = provider.getCapabilities()
  const maxTools = capabilities.maxTools
  const toolSchemas: ToolSchema[] = tools.slice(0, maxTools).map(t => toolToSchema(t))

  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ]

  const context = { cwd: process.cwd(), signal }
  let turnCount = 0
  let finalOutput = ''

  while (turnCount < maxTurns) {
    if (signal?.aborted) {
      return { description, output: 'interrupted', turnCount, success: false }
    }

    // call model
    const assistantContent: import('../types/index.js').ContentBlock[] = []

    try {
      for await (const event of provider.streamMessage({
        model,
        messages,
        system: AGENT_SYSTEM,
        tools: toolSchemas,
        signal,
      })) {
        switch (event.type) {
          case 'text_delta': {
            const last = assistantContent[assistantContent.length - 1]
            if (last?.type === 'text') {
              last.text += event.text
            } else {
              assistantContent.push({ type: 'text', text: event.text })
            }
            emit({ type: 'thinking', agent: description, text: event.text })
            break
          }
          case 'tool_call_start':
            assistantContent.push({
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: {},
            })
            emit({ type: 'tool_call', agent: description, tool: event.name })
            break
          case 'tool_call_delta': {
            const toolBlock = assistantContent.find(
              (b): b is import('../types/index.js').ToolUseBlock => b.type === 'tool_use' && b.id === event.id
            )
            if (toolBlock) {
              try { toolBlock.input = JSON.parse(event.inputJson) } catch {}
            }
            break
          }
        }
      }
    } catch (error) {
      return {
        description,
        output: `error: ${(error as Error).message}`,
        turnCount,
        success: false,
      }
    }

    messages.push({ role: 'assistant', content: assistantContent })

    // collect text output
    const textBlocks = assistantContent.filter(b => b.type === 'text')
    if (textBlocks.length > 0) {
      finalOutput = textBlocks.map(b => b.type === 'text' ? b.text : '').join('\n')
    }

    // extract tool calls
    const toolUseBlocks = assistantContent.filter(
      (b): b is import('../types/index.js').ToolUseBlock => b.type === 'tool_use'
    )

    // no tool calls — agent is done
    if (toolUseBlocks.length === 0) {
      return { description, output: finalOutput, turnCount, success: true }
    }

    // execute tools (no permission prompts for subagents — auto-allow)
    const toolResults: import('../types/index.js').ToolResultBlock[] = []
    for await (const result of runToolCalls(toolUseBlocks, tools, context)) {
      const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content)
      emit({
        type: 'tool_result',
        agent: description,
        result: content.length > 200 ? content.slice(0, 200) + '...' : content,
        isError: result.isError,
      })
      toolResults.push(result)
    }

    messages.push({ role: 'user', content: toolResults })
    turnCount++
  }

  return { description, output: finalOutput || 'max turns reached', turnCount, success: false }
}

/**
 * run multiple agents in parallel.
 * on OpenRouter: truly concurrent API calls.
 * on Ollama: sequential (one model at a time).
 */
export async function runAgentsParallel(tasks: AgentTask[]): Promise<AgentResult[]> {
  return Promise.all(tasks.map(task => runAgent(task)))
}
