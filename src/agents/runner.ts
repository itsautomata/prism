/**
 * subagent runner.
 * executes a focused task with its own message history.
 * shares the provider and tools but gets a fresh conversation.
 */

import type { ProviderBridge, Message, ToolSchema } from '../types/index.js'
import type { Tool } from '../tools/Tool.js'
import { toolToSchema } from '../tools/Tool.js'
import { runToolCalls, type PermissionResolver } from '../tools/orchestration.js'
import type { Agent, PermissionPolicy } from './definition.js'

/**
 * read-only floor for subagents. used when an Agent declares
 * permissions: 'deny-writes', and as the safe fallback when an agent declares
 * 'inherit' but the caller did not pass an askPermission resolver through.
 * surfaces 'deny' for any tool that needs permission; the orchestration layer
 * still auto-allows read-only tools before consulting the resolver.
 */
const denySubagentWrites: PermissionResolver = async () => 'deny'

export type AgentProgressEvent =
  | { type: 'thinking'; agent: string; text: string }
  | { type: 'tool_call'; agent: string; tool: string }
  | { type: 'tool_result'; agent: string; result: string; isError?: boolean }

/**
 * per-call inputs that the runtime needs but the Agent definition does not
 * carry. provider/model/tools belong to the parent; askPermission flows
 * through when permissions: 'inherit'.
 */
export interface AgentTask {
  description: string
  prompt: string
  provider: ProviderBridge
  /** parent's model. used as fallback when agent.model is undefined. */
  model: string
  /** parent's tool pool. filtered by agent.tools field; Agent itself is always excluded (no nesting). */
  tools: Tool[]
  signal?: AbortSignal
  onProgress?: (event: AgentProgressEvent) => void
  /** the parent's permission resolver, threaded through when agent.permissions is 'inherit'. */
  askPermission?: PermissionResolver
  /** the parent's working directory. subagents run in the same project tree as
   *  the parent so read confinement (in-project vs outside) matches. */
  cwd?: string
}

export interface AgentResult {
  description: string
  output: string
  turnCount: number
  success: boolean
}

/**
 * pick the resolver wrapping a subagent's tool calls.
 * 'inherit' falls back to deny-writes when the parent did not pass a resolver
 * through, so a misuse defaults to the safer floor rather than auto-allow.
 */
function pickResolver(policy: PermissionPolicy, parent?: PermissionResolver): PermissionResolver {
  if (policy === 'inherit') return parent ?? denySubagentWrites
  return denySubagentWrites
}

/**
 * filter the parent's tool pool by the agent's declared exposure axis.
 * 'Agent' is always excluded (no nested subagents). unknown names in the
 * declared list silently fall away here; the registry is responsible for
 * surfacing the warning at load time.
 */
function selectTools(agent: Agent, parentTools: Tool[]): Tool[] {
  const noAgent = parentTools.filter(t => t.name !== 'Agent')
  if (agent.tools === '*') return noAgent
  const allowed = new Set(agent.tools)
  return noAgent.filter(t => allowed.has(t.name))
}

/**
 * run a subagent with its own conversation.
 * returns the final text output.
 */
export async function runAgent(agent: Agent, task: AgentTask): Promise<AgentResult> {
  const {
    description,
    prompt,
    provider,
    signal,
    onProgress,
  } = task

  const emit = onProgress || (() => {})

  const model = agent.model ?? task.model
  const tools = selectTools(agent, task.tools)
  const resolver = pickResolver(agent.permissions, task.askPermission)
  const maxTurns = agent.maxTurns

  const capabilities = provider.getCapabilities()
  const maxTools = capabilities.maxTools
  const toolSchemas: ToolSchema[] = tools.slice(0, maxTools).map(t => toolToSchema(t))

  const messages: Message[] = [
    { role: 'user', content: [{ type: 'text', text: prompt }] },
  ]

  const context = { cwd: task.cwd ?? process.cwd(), signal }
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
        system: agent.systemPrompt,
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
              try {
                toolBlock.input = JSON.parse(event.inputJson)
                toolBlock.invalidArgs = false
              } catch {
                if (event.inputJson.trim().length > 0) toolBlock.invalidArgs = true
              }
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

    // execute tools through the agent-derived resolver.
    // 'deny-writes' floors writes; 'inherit' threads the parent's prompt through.
    const toolResults: import('../types/index.js').ToolResultBlock[] = []
    // respectSessionRules: false — the subagent's resolver is the floor; a
    // main-conversation session-allow must not let a tool skip it.
    for await (const result of runToolCalls(toolUseBlocks, tools, context, resolver, false)) {
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
export async function runAgentsParallel(runs: { agent: Agent; task: AgentTask }[]): Promise<AgentResult[]> {
  return Promise.all(runs.map(({ agent, task }) => runAgent(agent, task)))
}
