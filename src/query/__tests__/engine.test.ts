import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { query, type QueryEvent, type QueryOptions } from '../engine.js'
import { buildTool } from '../../tools/Tool.js'
import type {
  ProviderBridge,
  StreamEvent,
  Message,
  ModelCapabilities,
  ToolSchema,
  ContentBlock,
  MessageParams,
  MessageResponse,
} from '../../types/index.js'

const CAPS: ModelCapabilities = {
  maxTools: 10,
  parallelToolCalls: true,
  streaming: true,
  thinking: false,
  vision: false,
  strictMode: false,
  maxContextTokens: 128_000,
}

const END = { usage: { inputTokens: 0, outputTokens: 0 } } as const

// a turn that calls one tool and stops with stopReason 'tool_use'.
function toolTurn(name: string, id: string, input: unknown = {}): StreamEvent[] {
  return [
    { type: 'tool_call_start', id, name },
    { type: 'tool_call_delta', id, inputJson: JSON.stringify(input) },
    { type: 'tool_call_end', id },
    { type: 'message_end', stopReason: 'tool_use', ...END },
  ]
}

// a text-only turn that ends the conversation (stopReason 'end_turn').
function textTurn(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', ...END },
  ]
}

// provider that replays one scripted turn per streamMessage call. once the
// scripts run out it falls back to a plain end-turn so the loop can't hang.
function scriptedProvider(scripts: StreamEvent[][]): ProviderBridge {
  let i = 0
  return {
    name: 'scripted',
    async connect() {},
    getCapabilities: () => CAPS,
    async *streamMessage(_p: MessageParams): AsyncGenerator<StreamEvent> {
      const script = scripts[i++] ?? textTurn('(stop)')
      for (const ev of script) yield ev
    },
    async createMessage(_p: MessageParams): Promise<MessageResponse> {
      throw new Error('not used')
    },
    formatToolSchema(t: ToolSchema) { return t },
    parseToolCalls(c: ContentBlock[]) { return c },
  }
}

const editTool = buildTool({
  name: 'Edit',
  description: 'edit a file',
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  checkPermissions: () => ({ behavior: 'allow' as const }),
  async call() { return { content: 'edited' } },
})

function makeVerifyTool(fails = false) {
  return buildTool({
    name: 'Verify',
    description: 'run tests',
    inputSchema: z.object({}).passthrough(),
    isReadOnly: () => false,
    checkPermissions: () => ({ behavior: 'allow' as const }),
    async call() {
      return fails ? { content: 'tests failed', isError: true } : { content: 'all green' }
    },
  })
}

// a tool with an arbitrary name and isReadOnly, to stand in for Bash / Agent /
// Skill when exercising which edit channels the verify-nudge counts.
function namedTool(name: string, readOnly: boolean) {
  return buildTool({
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    isReadOnly: () => readOnly,
    checkPermissions: () => ({ behavior: 'allow' as const }),
    async call() { return { content: `${name} ran` } },
  })
}

async function run(scripts: StreamEvent[][], opts: Partial<QueryOptions> = {}) {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'do it' }] }]
  const events: QueryEvent[] = []
  for await (const e of query({
    provider: scriptedProvider(scripts),
    model: 'test',
    systemPrompt: 'sys',
    tools: [editTool, makeVerifyTool(false)],
    messages,
    enforceVerify: true,
    ...opts,
  })) {
    events.push(e)
  }
  return { events, messages }
}

const nudgedCount = (messages: Message[]) =>
  messages.filter(m =>
    m.role === 'user' &&
    m.content.some(b => b.type === 'text' && b.text.includes('have not run a passing Verify'))
  ).length

describe('query: verify-before-done enforcement', () => {
  it('nudges once when the model edits then tries to finish without verifying', async () => {
    const { events, messages } = await run([
      toolTurn('Edit', 'e1'),
      textTurn('all done'),
      textTurn('ok, stopping'),
    ])
    expect(nudgedCount(messages)).toBe(1)
    expect(events.some(e => e.type === 'done' && e.reason === 'completed')).toBe(true)
  })

  it('does not nudge when a passing Verify followed the edit', async () => {
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'do it' }] }]
    const events: QueryEvent[] = []
    for await (const e of query({
      provider: scriptedProvider([
        toolTurn('Edit', 'e1'),
        toolTurn('Verify', 'v1'),
        textTurn('done and verified'),
      ]),
      model: 'test',
      systemPrompt: 'sys',
      tools: [editTool, makeVerifyTool(false)],
      messages,
      enforceVerify: true,
    })) {
      events.push(e)
    }
    expect(nudgedCount(messages)).toBe(0)
    expect(events.some(e => e.type === 'done' && e.reason === 'completed')).toBe(true)
  })

  it('still nudges when the Verify failed (cleared only on a pass)', async () => {
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'do it' }] }]
    const events: QueryEvent[] = []
    for await (const e of query({
      provider: scriptedProvider([
        toolTurn('Edit', 'e1'),
        toolTurn('Verify', 'v1'),
        textTurn('giving up'),
        textTurn('stopping'),
      ]),
      model: 'test',
      systemPrompt: 'sys',
      tools: [editTool, makeVerifyTool(true)], // verify reports isError
      messages,
      enforceVerify: true,
    })) {
      events.push(e)
    }
    expect(nudgedCount(messages)).toBe(1)
  })

  it('does not nudge when enforceVerify is off (project has no test suite)', async () => {
    const { messages } = await run(
      [toolTurn('Edit', 'e1'), textTurn('all done')],
      { enforceVerify: false },
    )
    expect(nudgedCount(messages)).toBe(0)
  })

  it('does not nudge when the model only read/answered (no edits)', async () => {
    const { messages } = await run([textTurn('here is the answer')])
    expect(nudgedCount(messages)).toBe(0)
  })

  it('caps the nudge so a declining model still terminates', async () => {
    const { events, messages } = await run([
      toolTurn('Edit', 'e1'),
      textTurn('nope'),
      textTurn('still nope'),
      textTurn('and again'),
    ])
    expect(nudgedCount(messages)).toBe(1) // exactly one, never loops
    expect(events.some(e => e.type === 'done')).toBe(true)
  })
})

describe('query: which edit channels the verify-nudge counts', () => {
  it('nudges on a mutating Bash edit (sed -i, redirect)', async () => {
    const { messages } = await run(
      [toolTurn('Bash', 'b1', { command: 'echo x > f.ts' }), textTurn('done')],
      { tools: [namedTool('Bash', false), makeVerifyTool(false)] },
    )
    expect(nudgedCount(messages)).toBe(1)
  })

  it('does not nudge on a read-only Bash command (ls, cat)', async () => {
    const { messages } = await run(
      [toolTurn('Bash', 'b1', { command: 'cat f.ts' }), textTurn('done')],
      { tools: [namedTool('Bash', true), makeVerifyTool(false)] },
    )
    expect(nudgedCount(messages)).toBe(0)
  })

  it('nudges when a write-capable subagent edited via the Agent tool', async () => {
    const { messages } = await run(
      [toolTurn('Agent', 'a1'), textTurn('done')],
      { tools: [namedTool('Agent', false), makeVerifyTool(false)] },
    )
    expect(nudgedCount(messages)).toBe(1)
  })

  it('does not nudge for a deny-writes (read-only) subagent', async () => {
    const { messages } = await run(
      [toolTurn('Agent', 'a1'), textTurn('done')],
      { tools: [namedTool('Agent', true), makeVerifyTool(false)] },
    )
    expect(nudgedCount(messages)).toBe(0)
  })

  it('does not nudge on a Skill call (non-readonly, but touches no files)', async () => {
    const { messages } = await run(
      [toolTurn('Skill', 's1'), textTurn('done')],
      { tools: [namedTool('Skill', false), makeVerifyTool(false)] },
    )
    expect(nudgedCount(messages)).toBe(0)
  })
})
