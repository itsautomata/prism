/**
 * Agent tool.
 * spawn subagents for parallel or isolated work.
 * each agent gets its own conversation, shares tools and provider.
 * agents can't spawn more agents (no nesting).
 */

import { z } from 'zod'
import { buildTool, type ToolResult, type ToolContext } from './Tool.js'
import { runAgent, type AgentProgressEvent } from '../agents/runner.js'
import { resolveAgent, AgentNotFoundError, AgentValidationError } from '../agents/registry.js'
import { RECOVERY_AGENT } from '../agents/definition.js'
import type { ProviderBridge } from '../types/index.js'
import type { Tool } from './Tool.js'

const inputSchema = z.object({
  description: z.string().describe('short description of what this agent should do (3-5 words)'),
  prompt: z.string().describe('the full task for the agent. be specific about what to do and what to report back.'),
  agent: z.string().optional().describe('optional name of a user-defined agent (see project ./agents/ or ~/.prism/agents/). when omitted, the default read-only research agent runs.'),
})

type AgentInput = z.infer<typeof inputSchema>

// these get injected at runtime by the App
let _provider: ProviderBridge | null = null
let _model: string = ''
let _tools: Tool[] = []
let _onProgress: ((event: AgentProgressEvent) => void) | null = null

/**
 * configure the Agent tool with the current provider and tools.
 * called once at startup. agents share the same provider.
 */
export function configureAgentTool(
  provider: ProviderBridge,
  model: string,
  tools: Tool[],
  onProgress?: (event: AgentProgressEvent) => void,
) {
  _provider = provider
  _model = model
  _tools = tools.filter(t => t.name !== 'Agent')
  _onProgress = onProgress || null
}

export const AgentTool = buildTool<AgentInput>({
  name: 'Agent',
  description:
    'Spawn a subagent to handle a focused task. The subagent gets its own conversation and tools and returns a single string back. Pass `agent` to use a named definition (project ./agents/<name>.md or ~/.prism/agents/<name>.md); omit for the default read-only research subagent. Parameters: description (short, 3-5 words), prompt (detailed task instructions), agent (optional name).',

  inputSchema,

  async call(input: AgentInput, context: ToolContext): Promise<ToolResult> {
    if (!_provider) {
      return { content: 'error: Agent tool not configured', isError: true }
    }

    // empty / whitespace-only `agent` is treated as "use the default".
    const requested = input.agent?.trim()
    const agentName = requested && requested.length > 0 ? requested : undefined

    // recovery is an internal flow spawned by the engine on consecutive errors.
    // it is reserved against direct invocation so the model cannot fold it
    // into a normal task.
    if (agentName === RECOVERY_AGENT.name) {
      return {
        content: `agent "${RECOVERY_AGENT.name}" is reserved for the engine's automatic recovery flow and cannot be invoked directly`,
        isError: true,
      }
    }

    let agent
    try {
      agent = resolveAgent(agentName, context.cwd)
    } catch (err) {
      if (err instanceof AgentNotFoundError || err instanceof AgentValidationError) {
        return { content: err.message, isError: true }
      }
      throw err
    }

    const result = await runAgent(agent, {
      prompt: input.prompt,
      description: input.description,
      provider: _provider,
      model: _model,
      tools: _tools,
      signal: context.signal,
      onProgress: _onProgress || undefined,
    })

    if (!result.success) {
      return {
        content: `agent "${result.description}" failed: ${result.output}`,
        isError: true,
      }
    }

    return {
      content: `agent "${result.description}" completed (${result.turnCount} turns):\n${result.output}`,
    }
  },

  isConcurrencySafe: () => true, // agents can run in parallel
  isReadOnly: () => true, // agents report back, main agent decides what to do

  checkPermissions: () => ({ behavior: 'allow' }), // auto-allow agent spawning
})
