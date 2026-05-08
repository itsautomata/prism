import { describe, it, expect } from 'vitest'
import { summarizeOldTurns } from '../summarize.js'
import type {
  ProviderBridge,
  ProviderConfig,
  ModelCapabilities,
  MessageParams,
  MessageResponse,
  ToolSchema,
  ContentBlock,
  Message,
  StreamEvent,
} from '../../types/index.js'

/**
 * locks in the typed-result contract: summarize must surface failures via
 * { ok: false, reason }, not by silently returning the original messages.
 * the engine relies on this to flip its summarizeBlocked flag and avoid
 * retriggering compaction every turn until maxTurns aborts.
 */

const CAPS: ModelCapabilities = {
  maxTools: 10,
  parallelToolCalls: true,
  streaming: true,
  thinking: false,
  vision: false,
  strictMode: false,
  maxContextTokens: 128_000,
}

interface ProviderOpts {
  text?: string
  throws?: Error
}

function stubProvider(opts: ProviderOpts = {}): ProviderBridge {
  return {
    name: 'stub',
    async connect(_config: ProviderConfig) { /* no-op */ },
    getCapabilities: () => CAPS,
    async *streamMessage(_params: MessageParams): AsyncGenerator<StreamEvent> {
      // unused
    },
    async createMessage(_params: MessageParams): Promise<MessageResponse> {
      if (opts.throws) throw opts.throws
      return {
        id: 'stub-1',
        content: opts.text ? [{ type: 'text', text: opts.text }] : [],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'end_turn',
      }
    },
    formatToolSchema(t: ToolSchema) { return t },
    parseToolCalls(c: ContentBlock[]) { return c },
  }
}

function buildConversation(turns: number): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `q${i}` }] })
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `a${i}` }] })
  }
  return messages
}

describe('summarizeOldTurns', () => {
  it('returns ok:true with summary + recent turns on success', async () => {
    const messages = buildConversation(20) // 40 messages, well over keepRecent=10
    const provider = stubProvider({ text: 'short summary text' })

    const result = await summarizeOldTurns(messages, provider, 'stub-model')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 1 summary message + 10 recent = 11
    expect(result.messages).toHaveLength(11)
    const summary = result.messages[0]!
    expect(summary.role).toBe('user')
    const block = summary.content[0]!
    expect(block.type).toBe('text')
    if (block.type === 'text') {
      expect(block.text).toContain('[session summary]')
      expect(block.text).toContain('short summary text')
      expect(block.text).toContain('[end summary]')
    }
  })

  it('returns ok:false with reason when provider throws', async () => {
    const messages = buildConversation(20)
    const provider = stubProvider({ throws: new Error('rate limit exceeded') })

    const result = await summarizeOldTurns(messages, provider, 'stub-model')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('rate limit')
  })

  it('returns ok:false with reason when provider returns empty text', async () => {
    const messages = buildConversation(20)
    const provider = stubProvider({ text: '' })

    const result = await summarizeOldTurns(messages, provider, 'stub-model')

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('empty')
  })

  it('returns ok:true with original messages when too few to summarize', async () => {
    const messages = buildConversation(2) // 4 messages, below keepRecent + 2 threshold
    const provider = stubProvider({ throws: new Error('should not be called') })

    const result = await summarizeOldTurns(messages, provider, 'stub-model')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.messages).toBe(messages) // identity, no copy
  })
})
