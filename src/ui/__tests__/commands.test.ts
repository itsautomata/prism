import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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

  it('returns all 15 commands for "/" alone', () => {
    expect(filterSlashCommands('/').length).toBe(15)
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
      const planMode = { value: false, set: () => {} }
      const result = handleSlashCommand(cmd.name, 'm', makeProfile(), spy(), spy(), spy(), undefined, planMode)
      expect(result, `${cmd.name} should be dispatched`).toBe(true)
    }
  })
})

describe('handleSlashCommand: plan mode', () => {
  it('/plan turns plan mode on when off', () => {
    let value = false
    const set = (v: boolean) => { value = v }
    handleSlashCommand('/plan', 'm', makeProfile(), spy(), spy(), spy(), undefined, { value, set })
    expect(value).toBe(true)
  })

  it('/plan when already on does not flip and shows usage info', () => {
    let value = true
    let captured: any = null
    const setMessages = (updater: any) => { captured = typeof updater === 'function' ? updater([]) : updater }
    const set = (v: boolean) => { value = v }
    handleSlashCommand('/plan', 'm', makeProfile(), spy(), setMessages, spy(), undefined, { value, set })
    expect(value).toBe(true)
    expect(JSON.stringify(captured)).toContain('already in plan mode')
  })

  it('/exec-plan turns plan mode off when on', () => {
    let value = true
    const set = (v: boolean) => { value = v }
    handleSlashCommand('/exec-plan', 'm', makeProfile(), spy(), spy(), spy(), undefined, { value, set })
    expect(value).toBe(false)
  })

  it('/exec-plan when not in plan mode shows usage info, no flip', () => {
    let value = false
    let captured: any = null
    const setMessages = (updater: any) => { captured = typeof updater === 'function' ? updater([]) : updater }
    const set = (v: boolean) => { value = v }
    handleSlashCommand('/exec-plan', 'm', makeProfile(), spy(), setMessages, spy(), undefined, { value, set })
    expect(value).toBe(false)
    expect(JSON.stringify(captured)).toContain('not in plan mode')
  })

  it('/cancel-plan turns plan mode off when on', () => {
    let value = true
    const set = (v: boolean) => { value = v }
    handleSlashCommand('/cancel-plan', 'm', makeProfile(), spy(), spy(), spy(), undefined, { value, set })
    expect(value).toBe(false)
  })

  it('/cancel-plan emits abandon message (distinct from /exec-plan)', () => {
    let value = true
    let captured: any = null
    const setMessages = (updater: any) => { captured = typeof updater === 'function' ? updater([]) : updater }
    const set = (v: boolean) => { value = v }
    handleSlashCommand('/cancel-plan', 'm', makeProfile(), spy(), setMessages, spy(), undefined, { value, set })
    expect(value).toBe(false)
    expect(JSON.stringify(captured)).toContain('abandoned')
  })

  it('/plan without planMode arg is a no-op (graceful)', () => {
    let captured: any = null
    const setMessages = (updater: any) => { captured = typeof updater === 'function' ? updater([]) : updater }
    const result = handleSlashCommand('/plan', 'm', makeProfile(), spy(), setMessages, spy())
    expect(result).toBe(true)
    expect(JSON.stringify(captured)).toContain('not available')
  })
})

describe('handleSlashCommand: /agent', () => {
  let projectRoot: string
  let messages: any[]
  const setMessages = (updater: any) => {
    messages = typeof updater === 'function' ? updater(messages) : updater
  }

  beforeEach(() => {
    messages = []
    projectRoot = mkdtempSync(join(tmpdir(), 'prism-cmd-agent-'))
    rmSync(`${TEST_HOME}/.prism/agents`, { recursive: true, force: true })
  })

  function writeUserAgent(name: string, body: string): void {
    const dir = join(TEST_HOME, '.prism', 'agents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.md`), body, 'utf-8')
  }

  function minimal(): string {
    return `---
description: a minimal agent
---

you are a minimal agent.`
  }

  it('/agent lists the default and any user-defined agents', () => {
    writeUserAgent('researcher', minimal())
    handleSlashCommand('/agent', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot)
    const text = JSON.stringify(messages)
    expect(text).toContain('available agents')
    expect(text).toContain('default')
    expect(text).toContain('researcher')
  })

  it('/agent <name> shows that agent\'s details', () => {
    writeUserAgent('auditor', `---
description: audit code
tools: [Read, Grep]
permissions: deny-writes
---
audit the target.`)
    handleSlashCommand('/agent auditor', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot)
    const text = JSON.stringify(messages)
    expect(text).toContain('auditor')
    expect(text).toContain('audit code')
    expect(text).toContain('deny-writes')
  })

  it('/agent <unknown> reports not found without invoking trigger', () => {
    const triggerCalls: string[] = []
    const trigger = (m: string) => { triggerCalls.push(m) }
    handleSlashCommand('/agent unknown task here', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, trigger, projectRoot)
    expect(triggerCalls).toHaveLength(0)
    expect(JSON.stringify(messages)).toContain('not found')
  })

  it('/agent recovery <task> is rejected with a clear message', () => {
    const triggerCalls: string[] = []
    const trigger = (m: string) => { triggerCalls.push(m) }
    handleSlashCommand('/agent recovery diagnose', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, trigger, projectRoot)
    expect(triggerCalls).toHaveLength(0)
    expect(JSON.stringify(messages)).toContain('reserved')
  })

  it('/agent <name> <task> triggers a hidden model message naming the agent', () => {
    writeUserAgent('researcher', minimal())
    const triggerCalls: string[] = []
    const trigger = (m: string) => { triggerCalls.push(m) }
    handleSlashCommand('/agent researcher summarize src/tools/', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, trigger, projectRoot)
    expect(triggerCalls).toHaveLength(1)
    expect(triggerCalls[0]).toContain('researcher')
    expect(triggerCalls[0]).toContain('summarize src/tools/')
    expect(triggerCalls[0]).toContain('Agent tool')
  })

  it('/agent <name> <task> without a trigger function is a graceful no-op', () => {
    writeUserAgent('researcher', minimal())
    handleSlashCommand('/agent researcher do something', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot)
    expect(JSON.stringify(messages)).toContain('not available')
  })
})

describe('handleSlashCommand: /skill', () => {
  let projectRoot: string
  let messages: any[]
  let active: ReadonlySet<string>
  const setMessages = (updater: any) => {
    messages = typeof updater === 'function' ? updater(messages) : updater
  }
  const setActive = (next: Set<string>) => { active = next }

  beforeEach(() => {
    messages = []
    active = new Set()
    projectRoot = mkdtempSync(join(tmpdir(), 'prism-cmd-skill-'))
    rmSync(`${TEST_HOME}/.prism/skills`, { recursive: true, force: true })
  })

  function writeUserSkill(name: string, body: string): void {
    const dir = join(TEST_HOME, '.prism', 'skills')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.md`), body, 'utf-8')
  }

  function exampleSkill(): string {
    return `---
mode: passive
---
narrow security focus for the session

when active, prioritize security review of every diff and flag SSRF, injection, path traversal.`
  }

  function exampleInvokeSkill(): string {
    return `---
mode: invoke
---
narrow security focus, one-shot

run this when you need a security review of the current diff.`
  }

  it('/skill lists all skills with active markers', () => {
    writeUserSkill('security', exampleSkill())
    handleSlashCommand('/skill', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot, { active, setActive })
    const text = JSON.stringify(messages)
    expect(text).toContain('available skills')
    expect(text).toContain('security')
  })

  it('/skill <name> activates a passive skill and reports it back', () => {
    writeUserSkill('security', exampleSkill())
    handleSlashCommand('/skill security', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot, { active, setActive })
    expect(active.has('security')).toBe(true)
    expect(JSON.stringify(messages)).toContain('activated')
  })

  it('/skill <name> reports invoke skills with hint about /run', () => {
    writeUserSkill('invoke-only', exampleInvokeSkill())
    handleSlashCommand('/skill invoke-only', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot, { active, setActive })
    expect(active.has('invoke-only')).toBe(false)
    expect(JSON.stringify(messages)).toContain('/run')
  })

  it('/skill <name> deactivates an already-active skill (toggle)', () => {
    writeUserSkill('security', exampleSkill())
    active = new Set(['security'])
    handleSlashCommand('/skill security', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot, { active, setActive })
    expect(active.has('security')).toBe(false)
    expect(JSON.stringify(messages)).toContain('deactivated')
  })

  it('/skill <unknown> reports not found without activating', () => {
    handleSlashCommand('/skill nope', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot, { active, setActive })
    expect(active.size).toBe(0)
    expect(JSON.stringify(messages)).toContain('not found')
  })

  it('/skill clear deactivates everything', () => {
    writeUserSkill('security', exampleSkill())
    writeUserSkill('refactor', `---
mode: passive
---
narrow refactor focus\n\nbody.`)
    active = new Set(['security', 'refactor'])
    handleSlashCommand('/skill clear', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot, { active, setActive })
    expect(active.size).toBe(0)
    expect(JSON.stringify(messages)).toContain('all passive skills deactivated')
  })

  it('/skill clear when nothing is active is a graceful no-op', () => {
    handleSlashCommand('/skill clear', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot, { active, setActive })
    expect(JSON.stringify(messages)).toContain('no skills were active')
  })

  it('/skill without a state bag is a graceful no-op (build-time safety)', () => {
    writeUserSkill('security', exampleSkill())
    handleSlashCommand('/skill security', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot)
    expect(JSON.stringify(messages)).toContain('not available')
  })

  it('/skill lists all skills with both modes', () => {
    writeUserSkill('review', exampleInvokeSkill())
    writeUserSkill('passive-one', exampleSkill())
    handleSlashCommand('/skill', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot, { active, setActive })
    const text = JSON.stringify(messages)
    expect(text).toContain('available skills')
    expect(text).toContain('review')
    expect(text).toContain('passive-one')
  })

  it('/run without args prints usage', () => {
    handleSlashCommand('/run', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, undefined, projectRoot, { active, setActive })
    const text = JSON.stringify(messages)
    expect(text).toContain('usage')
  })

  it('/run <name> triggers a synthetic turn with skill body', () => {
    writeUserSkill('review', exampleInvokeSkill())
    let triggered = ''
    const trigger = (msg: string) => { triggered = msg }
    handleSlashCommand('/run review', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, trigger, projectRoot, { active, setActive })
    expect(triggered).toContain('narrow security focus, one-shot')
    expect(JSON.stringify(messages)).toContain('invoking skill')
  })

  it('/run <name> with task appends the task to the skill body', () => {
    writeUserSkill('review', exampleInvokeSkill())
    let triggered = ''
    const trigger = (msg: string) => { triggered = msg }
    handleSlashCommand('/run review check auth', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, trigger, projectRoot, { active, setActive })
    expect(triggered).toContain('check auth')
  })

  it('/run <unknown> reports not found', () => {
    const trigger = () => {}
    handleSlashCommand('/run nope', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, trigger, projectRoot, { active, setActive })
    expect(JSON.stringify(messages)).toContain('not found')
  })

  it('/run <name> <section> injects section note', () => {
    writeUserSkill('multi', `a multi-section skill

## standard
one-line message.

## detail
one-line summary + body.`)
    let triggered = ''
    const trigger = (msg: string) => { triggered = msg }
    handleSlashCommand('/run multi detail', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, trigger, projectRoot, { active, setActive })
    expect(triggered).toContain('[section: detail]')
    expect(triggered).toContain('one-line summary + body')
  })

  it('/run <name> <section> <task> combines section + task', () => {
    writeUserSkill('multi', `a multi-section skill

## standard
one-line message.

## detail
one-line summary + body.`)
    let triggered = ''
    const trigger = (msg: string) => { triggered = msg }
    handleSlashCommand('/run multi detail check auth', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, trigger, projectRoot, { active, setActive })
    expect(triggered).toContain('[section: detail]')
    expect(triggered).toContain('task: check auth')
  })

  it('/run <name> <unknown-token> treats it as task, not section error', () => {
    writeUserSkill('multi', `a multi-section skill

## standard
one-line message.

## detail
one-line summary + body.`)
    let triggered = ''
    const trigger = (msg: string) => { triggered = msg }
    handleSlashCommand('/run multi split', 'm', makeProfile(), spy(), setMessages, spy(), undefined, undefined, trigger, projectRoot, { active, setActive })
    expect(triggered).toContain('task: split')
    expect(triggered).not.toContain('[section:')
  })
})
