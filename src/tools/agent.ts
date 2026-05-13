/**
 * Agent tool.
 * spawn subagents for parallel or isolated work.
 * each agent gets its own conversation, shares tools and provider.
 * agents can't spawn more agents (no nesting).
 *
 * the runtime context (provider, model, subagent tool pool, progress callback)
 * is captured at construction via createAgentTool. each call to createAgentTool
 * yields a fresh Tool with the bound context, so multiple instances can
 * coexist if a caller ever needs that.
 */

import { z } from 'zod'
import { buildTool, type ToolResult, type ToolContext, type Tool } from './Tool.js'
import { runAgent, type AgentProgressEvent } from '../agents/runner.js'
import { resolveAgent, AgentNotFoundError, AgentValidationError } from '../agents/registry.js'
import { RECOVERY_AGENT } from '../agents/definition.js'
import type { ProviderBridge } from '../types/index.js'

const inputSchema = z.object({
  description: z.string().describe('short description of what this agent should do (3-5 words)'),
  prompt: z.string().describe('the full task for the agent. be specific about what to do and what to report back.'),
  agent: z.string().optional().describe('optional name of a user-defined agent (see project ./agents/ or ~/.prism/agents/). when omitted, the default read-only research agent runs.'),
})

type AgentInput = z.infer<typeof inputSchema>

const DESCRIPTION =
  'Spawn a subagent to handle a focused task. The subagent gets its own conversation and tools and returns a single string back. Pass `agent` to use a named definition (project ./agents/<name>.md or ~/.prism/agents/<name>.md); omit for the default read-only research subagent. Parameters: description (short, 3-5 words), prompt (detailed task instructions), agent (optional name).'

export interface CreateAgentToolOptions {
  provider: ProviderBridge
  model: string
  /**
   * the tool pool subagents draw from. should not include the Agent tool
   * itself; the no-nesting filter is enforced inside runAgent regardless,
   * but excluding it here keeps the schemas the model sees honest.
   */
  subagentTools: Tool[]
  /** optional progress callback wired to the host UI. */
  onProgress?: (event: AgentProgressEvent) => void
}

/**
 * create an Agent tool bound to the given runtime context. the returned tool
 * is immutable; if the host needs to swap the provider mid-session, it should
 * construct a new tool with the new context.
 */
export function createAgentTool(opts: CreateAgentToolOptions): Tool<AgentInput> {
  const subagentTools = opts.subagentTools.filter(t => t.name !== 'Agent')

  return buildTool<AgentInput>({
    name: 'Agent',
    description: DESCRIPTION,
    inputSchema,

    async call(input: AgentInput, context: ToolContext): Promise<ToolResult> {
      const requested = input.agent?.trim()
      const agentName = requested && requested.length > 0 ? requested : undefined

      // recovery is an internal flow spawned by the engine on consecutive
      // errors. it is reserved against direct invocation so the model cannot
      // fold it into a normal task.
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
        provider: opts.provider,
        model: opts.model,
        tools: subagentTools,
        signal: context.signal,
        onProgress: opts.onProgress,
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
    isReadOnly: () => true, // agents report back, parent decides what to do

    checkPermissions: () => ({ behavior: 'allow' }), // auto-allow agent spawning
  })
}
