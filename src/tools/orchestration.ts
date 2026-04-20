/**
 * tool orchestration.
 * partition tool calls into batches: parallel if safe, serial if not.
 * serial by default. parallel only when the tool declares it safe.
 */

import type { Tool, ToolResult, ToolContext } from './Tool.js'
import type { ToolUseBlock, ToolResultBlock } from '../types/index.js'
import { needsPermission, allowForSession, isSessionAllowed } from './permissions.js'

const MAX_CONCURRENCY = 10

interface ToolCallResult {
  toolUseId: string
  result: ToolResult
}

/**
 * find a tool by name from the tool pool.
 */
export function findTool(tools: Tool[], name: string): Tool | undefined {
  return tools.find(t => t.name === name)
}

export type PermissionResolver = (
  toolName: string,
  description: string,
  id: string,
) => Promise<'allow_once' | 'allow_session' | 'deny'>

/**
 * run all tool calls from a single assistant turn.
 * partitions into batches based on concurrency safety.
 * asks for permission on write operations.
 */
export async function* runToolCalls(
  toolUseBlocks: ToolUseBlock[],
  tools: Tool[],
  context: ToolContext,
  askPermission?: PermissionResolver,
): AsyncGenerator<ToolResultBlock> {
  const batches = partitionIntoBatches(toolUseBlocks, tools)

  for (const batch of batches) {
    if (batch.concurrent) {
      yield* runConcurrent(batch.blocks, tools, context, askPermission)
    } else {
      yield* runSerial(batch.blocks, tools, context, askPermission)
    }
  }
}

interface Batch {
  concurrent: boolean
  blocks: ToolUseBlock[]
}

/**
 * partition consecutive tool calls into batches.
 * consecutive concurrency-safe tools → one parallel batch.
 * non-safe tools → single-item serial batch.
 */
function partitionIntoBatches(blocks: ToolUseBlock[], tools: Tool[]): Batch[] {
  const batches: Batch[] = []

  for (const block of blocks) {
    const tool = findTool(tools, block.name)
    const isSafe = tool ? tool.isConcurrencySafe(block.input) : false

    const lastBatch = batches[batches.length - 1]
    if (isSafe && lastBatch?.concurrent) {
      // append to current concurrent batch
      lastBatch.blocks.push(block)
    } else {
      // start new batch
      batches.push({ concurrent: isSafe, blocks: [block] })
    }
  }

  return batches
}

async function* runConcurrent(
  blocks: ToolUseBlock[],
  tools: Tool[],
  context: ToolContext,
  askPermission?: PermissionResolver,
): AsyncGenerator<ToolResultBlock> {
  const limited = blocks.slice(0, MAX_CONCURRENCY)

  const promises = limited.map(block => executeToolCall(block, tools, context, askPermission))
  const results = await Promise.all(promises)

  for (const result of results) {
    yield {
      type: 'tool_result',
      toolUseId: result.toolUseId,
      content: result.result.content,
      isError: result.result.isError,
    }
  }
}

async function* runSerial(
  blocks: ToolUseBlock[],
  tools: Tool[],
  context: ToolContext,
  askPermission?: PermissionResolver,
): AsyncGenerator<ToolResultBlock> {
  for (const block of blocks) {
    const result = await executeToolCall(block, tools, context, askPermission)
    yield {
      type: 'tool_result',
      toolUseId: result.toolUseId,
      content: result.result.content,
      isError: result.result.isError,
    }
  }
}

/**
 * obvious bad calls that weak models make.
 * catch them before execution — faster and safer than letting them fail.
 */
const OBVIOUS_NON_COMMANDS = new Set([
  'hello', 'hi', 'hey', 'yes', 'no', 'ok', 'okay', 'sure', 'thanks',
  'thank you', 'bye', 'goodbye', 'help', 'please', 'sorry', 'what',
  'why', 'how', 'when', 'where', 'who', 'true', 'false',
])

function isObviousBadToolCall(block: ToolUseBlock): string | null {
  if (block.name === 'Bash') {
    const input = block.input as { command?: unknown }
    if (typeof input.command !== 'string') {
      return `command must be a string, got ${typeof input.command}`
    }
    const cmd = input.command.trim().toLowerCase()
    if (!cmd) return 'empty command'
    if (OBVIOUS_NON_COMMANDS.has(cmd)) {
      return `"${cmd}" is not a shell command. respond with text instead.`
    }
    // single word that doesn't look like a command
    if (/^[a-z]+$/.test(cmd) && cmd.length < 10 && !cmd.includes('/')) {
      // check if it's a real command
      try {
        const { execSync } = require('child_process')
        execSync(`which ${cmd}`, { stdio: 'pipe' })
      } catch {
        return `"${cmd}" is not a recognized command. respond with text instead.`
      }
    }
  }
  return null
}

async function executeToolCall(
  block: ToolUseBlock,
  tools: Tool[],
  context: ToolContext,
  askPermission?: PermissionResolver,
): Promise<ToolCallResult> {
  // pre-validation: catch obviously wrong calls
  const badCallReason = isObviousBadToolCall(block)
  if (badCallReason) {
    return {
      toolUseId: block.id,
      result: {
        content: `bad tool call: ${badCallReason}`,
        isError: true,
      },
    }
  }

  const tool = findTool(tools, block.name)

  if (!tool) {
    return {
      toolUseId: block.id,
      result: {
        content: `tool not found: ${block.name}`,
        isError: true,
      },
    }
  }

  // validate input
  const parsed = tool.inputSchema.safeParse(block.input)
  if (!parsed.success) {
    return {
      toolUseId: block.id,
      result: {
        content: `invalid input: ${parsed.error.message}`,
        isError: true,
      },
    }
  }

  // check permissions
  const permission = tool.checkPermissions(parsed.data, context)

  if (permission.behavior === 'deny') {
    return {
      toolUseId: block.id,
      result: {
        content: `permission denied: ${permission.message}`,
        isError: true,
      },
    }
  }

  // ask user if needed
  const isReadOnly = tool.isReadOnly(parsed.data)
  if (askPermission && needsPermission(tool.name, permission, isReadOnly)) {
    const description = permission.behavior === 'ask' ? permission.message : `run ${tool.name}`
    const choice = await askPermission(tool.name, description, block.id)

    if (choice === 'deny') {
      return {
        toolUseId: block.id,
        result: {
          content: `permission denied by user`,
          isError: true,
        },
      }
    }

    if (choice === 'allow_session') {
      allowForSession(tool.name)
    }
  }

  // execute
  try {
    const result = await tool.call(parsed.data, context)
    return { toolUseId: block.id, result }
  } catch (error) {
    return {
      toolUseId: block.id,
      result: {
        content: `tool error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      },
    }
  }
}
