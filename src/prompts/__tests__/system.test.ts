import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// redirect homedir before importing the prompt builder so user-scope agent
// lookups land in a temp dir.
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-prompt-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import { buildSystemPrompt } from '../system.js'
import type { ModelCapabilities } from '../../types/index.js'

const CAPS: ModelCapabilities = {
  maxTools: 10,
  parallelToolCalls: true,
  streaming: true,
  thinking: false,
  vision: false,
  strictMode: false,
  maxContextTokens: 128_000,
}

let projectRoot: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'prism-prompt-project-'))
  rmSync(`${TEST_HOME}/.prism/agents`, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

function writeUserAgent(name: string, body: string): void {
  const dir = join(TEST_HOME, '.prism', 'agents')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.md`), body, 'utf-8')
}

describe('buildSystemPrompt: agents section', () => {
  it('omits the agents section when only the default exists', () => {
    const prompt = buildSystemPrompt({ capabilities: CAPS, tools: [], cwd: projectRoot })
    expect(prompt).not.toContain('# available agents')
  })

  it('includes the section when a user-defined agent exists', () => {
    writeUserAgent('refactor', `---
description: rename and reshape code without changing behavior
---
you are the refactor agent.`)

    const prompt = buildSystemPrompt({ capabilities: CAPS, tools: [], cwd: projectRoot })
    expect(prompt).toContain('# available agents')
    expect(prompt).toContain('refactor: rename and reshape code without changing behavior')
    // default is listed alongside extras so the model sees the full picture
    expect(prompt).toContain('default:')
    // instructions to dispatch
    expect(prompt).toContain('call Agent with `agent: "<name>"`')
  })

  it('lists project-scoped agents and user-scoped agents together', () => {
    const projectAgentsDir = join(projectRoot, 'agents')
    mkdirSync(projectAgentsDir, { recursive: true })
    writeFileSync(join(projectAgentsDir, 'auditor.md'), `---
description: audit code for OWASP issues
---
you are the auditor.`, 'utf-8')

    writeUserAgent('researcher', `---
description: read-only research
---
you are the researcher.`)

    const prompt = buildSystemPrompt({ capabilities: CAPS, tools: [], cwd: projectRoot })
    expect(prompt).toContain('auditor:')
    expect(prompt).toContain('researcher:')
  })
})

describe('buildSystemPrompt: active skills section', () => {
  function writeUserSkill(name: string, body: string): void {
    const dir = join(TEST_HOME, '.prism', 'skills')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.md`), body, 'utf-8')
  }

  it('omits the section when no skills are active', () => {
    writeUserSkill('security', `security focus\n\ndetails`)
    const prompt = buildSystemPrompt({ capabilities: CAPS, tools: [], cwd: projectRoot })
    expect(prompt).not.toContain('# active skills')
  })

  it('omits the section when an active set is empty', () => {
    const prompt = buildSystemPrompt({ capabilities: CAPS, tools: [], cwd: projectRoot, activeSkills: new Set() })
    expect(prompt).not.toContain('# active skills')
  })

  it('appends each active skill body under the # active skills heading', () => {
    writeUserSkill('security', `security focus\n\nprioritize SSRF and injection.`)
    writeUserSkill('refactor', `refactor focus\n\npreserve behavior, no new abstractions.`)
    const prompt = buildSystemPrompt({
      capabilities: CAPS,
      tools: [],
      cwd: projectRoot,
      activeSkills: new Set(['security', 'refactor']),
    })
    expect(prompt).toContain('# active skills')
    expect(prompt).toContain('prioritize SSRF and injection')
    expect(prompt).toContain('preserve behavior')
    // separator between skill bodies
    expect(prompt).toContain('---')
  })

  it('silently skips unknown skill names without crashing', () => {
    writeUserSkill('security', `security focus\n\nbody.`)
    const prompt = buildSystemPrompt({
      capabilities: CAPS,
      tools: [],
      cwd: projectRoot,
      activeSkills: new Set(['security', 'ghost']),
    })
    expect(prompt).toContain('# active skills')
    expect(prompt).toContain('body.')
  })
})
