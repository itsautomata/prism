/**
 * Agent tool.
 * spawn subagents for parallel or isolated work.
 * each agent gets its own conversation, shares tools and provider.
 * agents can't spawn more agents (no nesting).
 */

import { z } from 'zod'
import { buildTool, type ToolResult, type ToolContext } from './Tool.js'
import { runAgent, type AgentProgressEvent } from '../agents/runner.js'
import type { ProviderBridge } from '../types/index.js'
import type { Tool } from './Tool.js'

const inputSchema = z.object({
  description: z.string().describe('short description of what this agent should do (3-5 words)'),
  prompt: z.string().describe('the full task for the agent. be specific about what to do and what to report back.'),
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
  description: 'Spawn a subagent to handle a focused task independently. The agent gets its own conversation and tools. Use for parallel work or isolating complex subtasks. Parameters: description (short, 3-5 words), prompt (detailed task instructions).',

  inputSchema,

  async call(input: AgentInput, context: ToolContext): Promise<ToolResult> {
    if (!_provider) {
      return { content: 'error: Agent tool not configured', isError: true }
    }

    const result = await runAgent({
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
