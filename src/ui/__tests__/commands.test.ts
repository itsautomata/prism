import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync } from 'fs'

// redirect homedir so addRule/removeRule/setMaxTools (called by handleSlashCommand)
// write to a temp dir, not the real ~/.prism
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-commands-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import { SLASH_COMMANDS, filterSlashCommands, handleSlashCommand } from '../commands.js'
import { addRule } from '../../learning/profile.js'
import type { ModelProfile, LearnedRule } from '../../learning/profile.js'

beforeEach(() => {
  rmSync(`${TEST_HOME}/.prism`, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

function makeProfile(rules: LearnedRule[] = []): ModelProfile {
  return { model: 'test-model', maxToolsOverride: null, rules }
}

function spy<T extends any[]>() {
  const calls: T[] = []
  const fn = (...args: T) => { calls.push(args) }
  return Object.assign(fn, { calls })
}

describe('SLASH_COMMANDS', () => {
  it('every entry name starts with /', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.name.startsWith('/')).toBe(true)
    }
  })

  it('every entry has a non-empty description', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.desc.length).toBeGreaterThan(0)
    }
  })

  it('names are unique', () => {
    const names = SLASH_COMMANDS.map(c => c.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('contains the canonical commands', () => {
    const names = SLASH_COMMANDS.map(c => c.name)
    for (const expected of ['/model', '/teach', '/rules', '/forget', '/max-tools', '/clear', '/help', '/exit']) {
      expect(names).toContain(expected)
    }
  })
})

describe('filterSlashCommands', () => {
  it('returns [] for input without leading /', () => {
    expect(filterSlashCommands('hello')).toEqual([])
    expect(filterSlashCommands('')).toEqual([])
    expect(filterSlashCommands('   ')).toEqual([])
  })

  it('returns all 9 commands for "/" alone', () => {
    expect(filterSlashCommands('/').length).toBe(9)
  })

  it('returns /max-tools and /model for "/m"', () => {
    const result = filterSlashCommands('/m')
    const names = result.map(c => c.name)
    expect(names).toEqual(expect.arrayContaining(['/max-tools', '/model']))
    expect(result.length).toBe(2)
  })

  it('returns only /model for "/mo"', () => {
    const result = filterSlashCommands('/mo')
    expect(result.length).toBe(1)
    expect(result[0]!.name).toBe('/model')
  })

  it('is case-insensitive', () => {
    const result = filterSlashCommands('/MODEL')
    expect(result.length).toBe(1)
    expect(result[0]!.name).toBe('/model')
  })

  it('returns [] when no command matches', () => {
    expect(filterSlashCommands('/xyz')).toEqual([])
  })

  it('exact match returns the single command', () => {
    const result = filterSlashCommands('/clear')
    expect(result.length).toBe(1)
    expect(result[0]!.name).toBe('/clear')
  })
})

describe('handleSlashCommand: dispatch', () => {
  it('returns false for non-slash input', () => {
    const result = handleSlashCommand('hello world', 'm', makeProfile(), spy(), spy(), spy())
    expect(result).toBe(false)
  })

  it('returns false for unknown slash command', () => {
    const result = handleSlashCommand('/notarealcommand', 'm', makeProfile(), spy(), spy(), spy())
    expect(result).toBe(false)
  })

  it('/exit calls exit() and returns true', () => {
    const exit = spy<[]>()
    const result = handleSlashCommand('/exit', 'm', makeProfile(), spy(), spy(), exit)
    expect(result).toBe(true)
    expect(exit.calls.length).toBe(1)
  })

  it('/quit calls exit() and returns true (alias)', () => {
    const exit = spy<[]>()
    const result = handleSlashCommand('/quit', 'm', makeProfile(), spy(), spy(), exit)
    expect(result).toBe(true)
    expect(exit.calls.length).toBe(1)
  })

  it('/clear calls setMessages with []', () => {
    const setMessages = spy<[any]>()
    const result = handleSlashCommand('/clear', 'm', makeProfile(), spy(), setMessages, spy())
    expect(result).toBe(true)
    expect(setMessages.calls.length).toBe(1)
    expect(setMessages.calls[0]![0]).toEqual([])
  })

  it('/help calls setMessages once with content containing "commands:"', () => {
    let captured: any = null
    const setMessages = (updater: any) => {
      const result = typeof updater === 'function' ? updater([]) : updater
      captured = result
    }
    const result = handleSlashCommand('/help', 'm', makeProfile(), spy(), setMessages, spy())
    expect(result).toBe(true)
    expect(JSON.stringify(captured)).toContain('commands:')
  })

  it('/teach with empty args shows usage', () => {
    let captured: any = null
    const setMessages = (updater: any) => { captured = typeof updater === 'function' ? updater([]) : updater }
    const setProfile = spy<[ModelProfile]>()
    const result = handleSlashCommand('/teach', 'm', makeProfile(), setProfile, setMessages, spy())
    expect(result).toBe(true)
    expect(JSON.stringify(captured)).toContain('usage: /teach <rule>')
    expect(setProfile.calls.length).toBe(0)
  })

  it('/teach <rule> calls setProfile with the new rule appended', () => {
    const setProfile = spy<[ModelProfile]>()
    const result = handleSlashCommand('/teach never push', 'm', makeProfile(), setProfile, spy(), spy())
    expect(result).toBe(true)
    expect(setProfile.calls.length).toBe(1)
    const newProfile = setProfile.calls[0]![0]
    expect(newProfile.rules.some(r => r.rule === 'never push')).toBe(true)
  })

  it('/forget non-numeric shows usage', () => {
    let captured: any = null
    const setMessages = (updater: any) => { captured = typeof updater === 'function' ? updater([]) : updater }
    const setProfile = spy<[ModelProfile]>()
    const result = handleSlashCommand('/forget abc', 'm', makeProfile(), setProfile, setMessages, spy())
    expect(result).toBe(true)
    expect(JSON.stringify(captured)).toContain('usage: /forget <number>')
    expect(setProfile.calls.length).toBe(0)
  })

  it('/forget <n> removes the (n-1)-th rule (1-based to 0-based conversion)', () => {
    // /forget reads from disk via removeRule, so seed the model's profile on disk first
    addRule('m', 'first')
    addRule('m', 'second')
    addRule('m', 'third')
    const setProfile = spy<[ModelProfile]>()
    handleSlashCommand('/forget 2', 'm', makeProfile(), setProfile, spy(), spy())
    expect(setProfile.calls.length).toBe(1)
    const updated = setProfile.calls[0]![0]
    expect(updated.rules.map(r => r.rule)).toEqual(['first', 'third'])
  })

  it('/rules with empty profile shows the no-rules message', () => {
    let captured: any = null
    const setMessages = (updater: any) => { captured = typeof updater === 'function' ? updater([]) : updater }
    const result = handleSlashCommand('/rules', 'qwen3:14b', makeProfile(), spy(), setMessages, spy())
    expect(result).toBe(true)
    expect(JSON.stringify(captured)).toContain('no learned rules')
    expect(JSON.stringify(captured)).toContain('qwen3:14b')
  })

  it('/rules with rules formats them as a numbered list', () => {
    let captured: any = null
    const setMessages = (updater: any) => { captured = typeof updater === 'function' ? updater([]) : updater }
    const profile = makeProfile([
      { rule: 'do thing', source: 'user', addedAt: 'now' },
      { rule: 'avoid other', source: 'user', addedAt: 'now' },
    ])
    handleSlashCommand('/rules', 'm', profile, spy(), setMessages, spy())
    const text = JSON.stringify(captured)
    expect(text).toContain('1. do thing')
    expect(text).toContain('2. avoid other')
  })

  it('/max-tools <n> calls setProfile with the new override', () => {
    const setProfile = spy<[ModelProfile]>()
    handleSlashCommand('/max-tools 5', 'm', makeProfile(), setProfile, spy(), spy())
    expect(setProfile.calls.length).toBe(1)
    expect(setProfile.calls[0]![0].maxToolsOverride).toBe(5)
  })

  it('/max-tools 0 shows usage (n must be >= 1)', () => {
    let captured: any = null
    const setMessages = (updater: any) => { captured = typeof updater === 'function' ? updater([]) : updater }
    const setProfile = spy<[ModelProfile]>()
    handleSlashCommand('/max-tools 0', 'm', makeProfile(), setProfile, setMessages, spy())
    expect(JSON.stringify(captured)).toContain('usage: /max-tools')
    expect(setProfile.calls.length).toBe(0)
  })

  it('/max-tools abc shows usage', () => {
    let captured: any = null
    const setMessages = (updater: any) => { captured = typeof updater === 'function' ? updater([]) : updater }
    const setProfile = spy<[ModelProfile]>()
    handleSlashCommand('/max-tools abc', 'm', makeProfile(), setProfile, setMessages, spy())
    expect(JSON.stringify(captured)).toContain('usage: /max-tools')
    expect(setProfile.calls.length).toBe(0)
  })

  it('/model empty shows current and usage', () => {
    let captured: any = null
    const setMessages = (updater: any) => { captured = typeof updater === 'function' ? updater([]) : updater }
    const result = handleSlashCommand('/model', 'qwen3:14b', makeProfile(), spy(), setMessages, spy())
    expect(result).toBe(true)
    expect(JSON.stringify(captured)).toContain('current model: qwen3:14b')
  })

  it('/model <name> calls switchModel with the name', async () => {
    const switchModel = spy<[string]>()
    const switchModelFn = async (name: string) => switchModel(name)
    const result = handleSlashCommand('/model deepseek/deepseek-r1', 'old', makeProfile(), spy(), spy(), spy(), switchModelFn)
    expect(result).toBe(true)
    expect(switchModel.calls.length).toBe(1)
    expect(switchModel.calls[0]![0]).toBe('deepseek/deepseek-r1')
  })

  it('/model when switchModel is undefined does not throw and returns true', () => {
    const result = handleSlashCommand('/model qwen3:14b', 'old', makeProfile(), spy(), spy(), spy(), undefined)
    expect(result).toBe(true)
  })
})

describe('handleSlashCommand: drift catcher', () => {
  it('every command in SLASH_COMMANDS is dispatched (returns true)', () => {
    for (const cmd of SLASH_COMMANDS) {
      const result = handleSlashCommand(cmd.name, 'm', makeProfile(), spy(), spy(), spy())
      expect(result, `${cmd.name} should be dispatched`).toBe(true)
    }
  })
})
