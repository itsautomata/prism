import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runAgent, type AgentProgressEvent } from '../runner.js'
import { ReadTool, WriteTool, BashTool } from '../../tools/index.js'
import type {
  ProviderBridge,
  ProviderConfig,
  ModelCapabilities,
  MessageParams,
  MessageResponse,
  ToolSchema,
  ContentBlock,
  StreamEvent,
} from '../../types/index.js'

/**
 * locks in the deny-writes contract for subagents. these tests guard the fix
 * for the permission bypass at runner.ts: a subagent that calls a write tool
 * must be denied without prompting the user, while read-only tools must still
 * pass through.
 */

const TEST_DIR = mkdtempSync(join(tmpdir(), 'prism-runner-test-'))

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

const CAPS: ModelCapabilities = {
  maxTools: 10,
  parallelToolCalls: true,
  streaming: true,
  thinking: false,
  vision: false,
  strictMode: false,
  maxContextTokens: 128_000,
}

/**
 * minimal scriptable provider. each call to streamMessage yields the next
 * scripted turn. once turns run out, it emits a plain end_turn so the runner
 * exits its loop without hanging.
 */
function scriptedProvider(turns: StreamEvent[][]): ProviderBridge {
  let i = 0
  return {
    name: 'scripted',
    async connect(_config: ProviderConfig) { /* no-op */ },
    getCapabilities: () => CAPS,
    async *streamMessage(_params: MessageParams): AsyncGenerator<StreamEvent> {
      const turn = turns[i++] ?? [
        { type: 'message_start', id: 'fallback' },
        { type: 'text_delta', text: 'done.' },
        { type: 'message_end', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' },
      ]
      for (const event of turn) yield event
    },
    async createMessage(_params: MessageParams): Promise<MessageResponse> {
      throw new Error('not used in these tests')
    },
    formatToolSchema(t: ToolSchema) { return t },
    parseToolCalls(c: ContentBlock[]) { return c },
  }
}

function toolCallTurn(id: string, name: string, input: Record<string, unknown>): StreamEvent[] {
  return [
    { type: 'message_start', id: `msg-${id}` },
    { type: 'tool_call_start', id, name },
    { type: 'tool_call_delta', id, inputJson: JSON.stringify(input) },
    { type: 'tool_call_end', id },
    { type: 'message_end', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'tool_use' },
  ]
}

function textTurn(text: string): StreamEvent[] {
  return [
    { type: 'message_start', id: `msg-${text.slice(0, 8)}` },
    { type: 'text_delta', text },
    { type: 'message_end', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' },
  ]
}

describe('runAgent permission policy', () => {
  let progress: AgentProgressEvent[]

  beforeEach(() => {
    progress = []
  })

  it('denies write tools without prompting', async () => {
    const target = join(TEST_DIR, 'should-not-exist.txt')
    const provider = scriptedProvider([
      toolCallTurn('w1', 'Write', { file_path: target, content: 'hi' }),
      textTurn('reporting back: could not write.'),
    ])

    const result = await runAgent({
      prompt: 'write hi to a file',
      description: 'write attempt',
      provider,
      model: 'scripted',
      tools: [WriteTool],
      onProgress: e => progress.push(e),
    })

    const toolResults = progress.filter(e => e.type === 'tool_result')
    expect(toolResults).toHaveLength(1)
    const denial = toolResults[0]!
    expect(denial.isError).toBe(true)
    expect((denial as { result: string }).result.toLowerCase()).toContain('permission denied')

    // critical: the subagent did not write the file. the deny path is the
    // structural guarantee, this assertion is the observable proof.
    expect(existsSync(target)).toBe(false)

    // subagent terminates cleanly on the text-only turn
    expect(result.success).toBe(true)
  })

  it('allows read-only tools through', async () => {
    const file = join(TEST_DIR, 'readme.txt')
    writeFileSync(file, 'hello from prism', 'utf-8')

    const provider = scriptedProvider([
      toolCallTurn('r1', 'Read', { file_path: file }),
      textTurn('summary: greeting present.'),
    ])

    await runAgent({
      prompt: 'read the file',
      description: 'read attempt',
      provider,
      model: 'scripted',
      tools: [ReadTool],
      onProgress: e => progress.push(e),
    })

    const toolResults = progress.filter(e => e.type === 'tool_result')
    expect(toolResults).toHaveLength(1)
    const read = toolResults[0]!
    expect(read.isError).toBeFalsy()
    expect((read as { result: string }).result).toContain('hello from prism')
  })

  it('allows read-only Bash through (recovery-agent path)', async () => {
    const provider = scriptedProvider([
      toolCallTurn('b1', 'Bash', { command: 'echo recovery-ok' }),
      textTurn('diagnosis: command ran.'),
    ])

    await runAgent({
      prompt: 'run echo',
      description: 'recovery diagnosis',
      provider,
      model: 'scripted',
      tools: [BashTool],
      onProgress: e => progress.push(e),
    })

    const toolResults = progress.filter(e => e.type === 'tool_result')
    expect(toolResults).toHaveLength(1)
    const bash = toolResults[0]!
    expect(bash.isError).toBeFalsy()
    expect((bash as { result: string }).result).toContain('recovery-ok')
  })
})
