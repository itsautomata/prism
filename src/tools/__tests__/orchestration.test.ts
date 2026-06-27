import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildTool } from '../Tool.js'
import { runToolCalls } from '../orchestration.js'
import type { ToolUseBlock, ToolResultBlock } from '../../types/index.js'

async function collect(gen: AsyncGenerator<ToolResultBlock>): Promise<ToolResultBlock[]> {
  const out: ToolResultBlock[] = []
  for await (const r of gen) out.push(r)
  return out
}

describe('runToolCalls: malformed-args guard', () => {
  it('refuses a block flagged invalidArgs and never calls the tool', async () => {
    let called = false
    const probe = buildTool({
      name: 'Probe',
      description: 'records whether it ran',
      inputSchema: z.object({}).passthrough(),
      isReadOnly: () => true,
      checkPermissions: () => ({ behavior: 'allow' as const }),
      async call() {
        called = true
        return { content: 'ran' }
      },
    })

    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 'x1',
      name: 'Probe',
      input: {},
      invalidArgs: true,
    }

    const results = await collect(runToolCalls([block], [probe], { cwd: '/' }))

    expect(called).toBe(false)
    expect(results).toHaveLength(1)
    expect(results[0].isError).toBe(true)
    expect(results[0].content).toMatch(/malformed tool arguments/)
  })

  it('runs the tool normally when args are valid', async () => {
    let called = false
    const probe = buildTool({
      name: 'Probe',
      description: 'records whether it ran',
      inputSchema: z.object({}).passthrough(),
      isReadOnly: () => true,
      checkPermissions: () => ({ behavior: 'allow' as const }),
      async call() {
        called = true
        return { content: 'ran' }
      },
    })

    const block: ToolUseBlock = { type: 'tool_use', id: 'x2', name: 'Probe', input: {} }
    const results = await collect(runToolCalls([block], [probe], { cwd: '/' }))

    expect(called).toBe(true)
    expect(results[0].isError).toBeUndefined()
  })
})

describe('runToolCalls: concurrent batch completeness', () => {
  it('returns a result for every call when more than MAX_CONCURRENCY run concurrently', async () => {
    // a concurrency-safe tool: many of these in one turn form a single
    // concurrent batch. every tool_use must get a tool_result, or the next
    // request orphans the unmatched calls and the provider rejects it.
    const probe = buildTool({
      name: 'Probe',
      description: 'concurrency-safe no-op',
      inputSchema: z.object({}).passthrough(),
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      checkPermissions: () => ({ behavior: 'allow' as const }),
      async call() {
        return { content: 'ran' }
      },
    })

    const n = 25 // well past MAX_CONCURRENCY (10)
    const blocks: ToolUseBlock[] = Array.from({ length: n }, (_, i) => ({
      type: 'tool_use',
      id: `c${i}`,
      name: 'Probe',
      input: {},
    }))

    const results = await collect(runToolCalls(blocks, [probe], { cwd: '/' }))

    expect(results).toHaveLength(n)
    expect(new Set(results.map(r => r.toolUseId))).toEqual(
      new Set(blocks.map(b => b.id)),
    )
  })
})
