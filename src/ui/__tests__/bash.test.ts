import { describe, it, expect, beforeEach } from 'vitest'
import { handleBashCommand } from '../bash.js'

describe('handleBashCommand', () => {
  let displayed: any[]
  const setMessages = (updater: any) => {
    displayed = typeof updater === 'function' ? updater(displayed) : updater
  }

  beforeEach(() => {
    displayed = []
  })

  it('returns false for input without ! prefix', () => {
    expect(handleBashCommand('hello world', setMessages)).toBe(false)
    expect(displayed.length).toBe(0)
  })

  it('returns true and is a no-op for bare !', () => {
    expect(handleBashCommand('!', setMessages)).toBe(true)
    expect(displayed.length).toBe(0)
  })

  it('returns true and runs ! <command>, captures stdout', () => {
    expect(handleBashCommand('!echo hello', setMessages)).toBe(true)
    expect(displayed.length).toBe(2)
    expect(displayed[0].toolName).toBe('! echo hello')
    expect(displayed[1].text).toContain('hello')
    expect(displayed[1].isError).toBeFalsy()
  })

  it('captures non-zero exit code as error', () => {
    handleBashCommand('!exit 42', setMessages)
    expect(displayed[1].isError).toBe(true)
    expect(displayed[1].text).toContain('Exit code: 42')
  })

  it('strips leading whitespace from the command', () => {
    handleBashCommand('!  echo trimmed  ', setMessages)
    expect(displayed[0].toolName).toBe('! echo trimmed')
  })

  it('shows (no output) for commands that produce nothing', () => {
    handleBashCommand('!true', setMessages)
    expect(displayed[1].text).toBe('(no output)')
  })
})
