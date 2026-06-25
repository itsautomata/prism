import { describe, it, expect } from 'vitest'
import type { Message } from '../../types/index.js'
import { safeKeepStart } from '../pairing.js'
import { snipOldTurns } from '../snip.js'

// alternating history where every assistant tool_use is followed by a user
// tool_result — the exact shape where a naive index cut orphans a result.
function toolHistory(turns: number): Message[] {
  const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'start' }] }]
  for (let i = 0; i < turns; i++) {
    msgs.push({ role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: {} }] })
    msgs.push({ role: 'user', content: [{ type: 'tool_result', toolUseId: `t${i}`, content: 'ok' }] })
  }
  return msgs
}

const opensWithOrphan = (msgs: Message[]) =>
  msgs.length > 0 && msgs[0].role === 'user' && msgs[0].content.some(b => b.type === 'tool_result')

describe('safeKeepStart', () => {
  it('never starts the kept slice on an orphaned tool_result', () => {
    const msgs = toolHistory(6) // 13 messages
    for (let keep = 1; keep <= msgs.length; keep++) {
      const start = safeKeepStart(msgs, keep)
      expect(opensWithOrphan(msgs.slice(start))).toBe(false)
    }
  })

  it('leaves a clean boundary untouched', () => {
    // assistant text followed by user text — no tool pairing to protect
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'd' }] },
    ]
    expect(safeKeepStart(msgs, 2)).toBe(2)
  })
})

describe('snipOldTurns', () => {
  it('produced slice never opens with an orphaned tool_result', () => {
    const snipped = snipOldTurns(toolHistory(8))
    // first element is the injected marker (user text); the rest is the kept tail
    expect(opensWithOrphan(snipped.slice(1))).toBe(false)
  })
})
