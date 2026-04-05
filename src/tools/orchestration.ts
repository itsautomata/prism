/**
 * tool orchestration.
 * partition tool calls into batches: parallel if safe, serial if not.
 * principle #6: serial by default, prove safety to parallelize.
 */

import type { Tool, ToolResult, ToolContext } from './Tool.js'
import type { ToolUseBlock, ToolResultBlock } from '../types/index.js'

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

/**
 * run all tool calls from a single assistant turn.
 * partitions into batches based on concurrency safety.
 */
export async function* runToolCalls(
  toolUseBlocks: ToolUseBlock[],
  tools: Tool[],
  context: ToolContext,
): AsyncGenerator<ToolResultBlock> {
  const batches = partitionIntoBatches(toolUseBlocks, tools)

  for (const batch of batches) {
    if (batch.concurrent) {
      yield* runConcurrent(batch.blocks, tools, context)
    } else {
      yield* runSerial(batch.blocks, tools, context)
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
): AsyncGenerator<ToolResultBlock> {
  // limit concurrency
  const limited = blocks.slice(0, MAX_CONCURRENCY)

  const promises = limited.map(block => executeToolCall(block, tools, context))
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
): AsyncGenerator<ToolResultBlock> {
  for (const block of blocks) {
    const result = await executeToolCall(block, tools, context)
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
