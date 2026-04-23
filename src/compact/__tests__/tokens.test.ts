import { describe, it, expect } from 'vitest'
import { countTokens, countMessageTokens, countConversationTokens, formatTokens } from '../tokens.js'

describe('countTokens', () => {
  it('counts single word', () => {
    expect(countTokens('hello')).toBe(1)
  })

  it('counts two words', () => {
    expect(countTokens('hello world')).toBe(2)
  })

  it('counts prose', () => {
    expect(countTokens('the quick brown fox')).toBe(4)
  })

  it('counts code', () => {
    expect(countTokens('function foo() { return 1 }')).toBe(8)
  })

  it('counts file paths', () => {
    expect(countTokens('/home/user/projects/app/src/index.ts')).toBe(7)
  })

  it('empty string returns 0', () => {
    expect(countTokens('')).toBe(0)
  })
})

describe('countMessageTokens', () => {
  it('counts tokens in a text message', () => {
    const count = countMessageTokens({
      role: 'user',
      content: [{ type: 'text', text: 'hello world' }],
    })
    expect(count).toBeGreaterThan(0)
  })

  it('counts tokens in a tool_use message', () => {
    const count = countMessageTokens({
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: '123',
        name: 'Bash',
        input: { command: 'ls -la' },
      }],
    })
    expect(count).toBeGreaterThan(2)
  })
})

describe('countConversationTokens', () => {
  it('sums across messages', () => {
    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'hi there' }] },
    ]
    const total = countConversationTokens(messages)
    const first = countMessageTokens(messages[0]!)
    const second = countMessageTokens(messages[1]!)
    expect(total).toBe(first + second)
  })
})

describe('formatTokens', () => {
  it('formats small numbers as-is', () => {
    expect(formatTokens(500)).toBe('500')
  })

  it('formats thousands as K', () => {
    expect(formatTokens(12400)).toBe('12.4K')
  })

  it('formats millions as M', () => {
    expect(formatTokens(1500000)).toBe('1.5M')
  })
})
