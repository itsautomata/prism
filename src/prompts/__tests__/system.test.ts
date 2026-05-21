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

import { buildSystemPrompt, __resetStaticPromptCache } from '../system.js'
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
  // each test gets a fresh static cache so insert-order or ref-id leakage
  // from a prior test can't bleed in
  __resetStaticPromptCache()
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

describe('buildSystemPrompt: repo-map injection', () => {
  it('injects a non-empty repoMap as its own section', () => {
    const repoMap = '# repo map\n\nsrc/foo.ts\n  function greet'
    const prompt = buildSystemPrompt({
      capabilities: CAPS,
      tools: [],
      cwd: projectRoot,
      repoMap,
    })
    expect(prompt).toContain('# repo map')
    expect(prompt).toContain('src/foo.ts')
    expect(prompt).toContain('function greet')
  })

  it('skips the section when repoMap is empty string', () => {
    const prompt = buildSystemPrompt({
      capabilities: CAPS,
      tools: [],
      cwd: projectRoot,
      repoMap: '',
    })
    expect(prompt).not.toContain('# repo map')
  })

  it('skips the section when repoMap is omitted', () => {
    const prompt = buildSystemPrompt({
      capabilities: CAPS,
      tools: [],
      cwd: projectRoot,
    })
    expect(prompt).not.toContain('# repo map')
  })
})

describe('buildSystemPrompt: static prefix + dynamic suffix layering', () => {
  it('places dynamic sections (active skills, repo map, plan mode) AFTER all static content', () => {
    // build skills on disk so the active block has something to load
    mkdirSync(join(projectRoot, 'skills'), { recursive: true })
    writeFileSync(join(projectRoot, 'skills', 'demo.md'), 'demo body text', 'utf-8')

    const prompt = buildSystemPrompt({
      capabilities: CAPS,
      tools: [],
      cwd: projectRoot,
      activeSkills: new Set(['demo']),
      repoMap: '# repo map\n\nsrc/foo.ts\n  function bar',
      inPlanMode: true,
    })

    // every dynamic anchor lands after every static anchor it could conflict
    // with. ordering: static (core, env) ... dynamic (active skills, repo map, plan mode)
    const idxCore = prompt.indexOf('<identity>')
    const idxEnv = prompt.indexOf('cwd:')
    const idxSkills = prompt.indexOf('# active skills')
    const idxRepo = prompt.indexOf('# repo map')
    const idxPlan = prompt.indexOf('## plan mode')

    expect(idxCore).toBeGreaterThanOrEqual(0)
    expect(idxEnv).toBeGreaterThan(idxCore)
    expect(idxSkills).toBeGreaterThan(idxEnv)
    expect(idxRepo).toBeGreaterThan(idxSkills)
    expect(idxPlan).toBeGreaterThan(idxRepo)
  })

  it('reuses the cached static prefix when inputs are ref-equal across calls', () => {
    // memoize the ref of a "memory" object across calls. the cache key
    // depends on object identity, so two calls with the same ref must
    // produce identical output without recomposing.
    const memory = { lens: null, memo: 'remember me' }
    const a = buildSystemPrompt({
      capabilities: CAPS,
      tools: [],
      cwd: projectRoot,
      memory,
    })
    const b = buildSystemPrompt({
      capabilities: CAPS,
      tools: [],
      cwd: projectRoot,
      memory,
    })
    expect(a).toBe(b)
  })

  it('recomposes the static prefix when the memory ref changes', () => {
    const a = buildSystemPrompt({
      capabilities: CAPS,
      tools: [],
      cwd: projectRoot,
      memory: { lens: null, memo: 'first' },
    })
    const b = buildSystemPrompt({
      capabilities: CAPS,
      tools: [],
      cwd: projectRoot,
      memory: { lens: null, memo: 'second' },
    })
    expect(a).not.toBe(b)
    expect(a).toContain('first')
    expect(b).toContain('second')
    expect(b).not.toContain('first')
  })

  it('active skills section is byte-stable regardless of insertion order', () => {
    mkdirSync(join(projectRoot, 'skills'), { recursive: true })
    writeFileSync(join(projectRoot, 'skills', 'alpha.md'), 'alpha body', 'utf-8')
    writeFileSync(join(projectRoot, 'skills', 'beta.md'), 'beta body', 'utf-8')

    // insert in two orders. without sorting, JS Set iteration order would
    // produce different prompts. with sorting, they're identical.
    const setA = new Set(['alpha', 'beta'])
    const setB = new Set(['beta', 'alpha'])

    const promptA = buildSystemPrompt({ capabilities: CAPS, tools: [], cwd: projectRoot, activeSkills: setA })
    const promptB = buildSystemPrompt({ capabilities: CAPS, tools: [], cwd: projectRoot, activeSkills: setB })

    expect(promptA).toBe(promptB)
  })

  it('plan mode addendum stays in the dynamic suffix (cache survives the toggle)', () => {
    // same memory ref both times. only inPlanMode differs. the static portion
    // must remain identical; only the suffix changes.
    const memory = { lens: null, memo: 'stable' }

    const off = buildSystemPrompt({ capabilities: CAPS, tools: [], cwd: projectRoot, memory, inPlanMode: false })
    const on = buildSystemPrompt({ capabilities: CAPS, tools: [], cwd: projectRoot, memory, inPlanMode: true })

    expect(off).not.toContain('## plan mode')
    expect(on).toContain('## plan mode')
    // the prefix before the plan-mode addendum is the static portion; it
    // must match between the two calls byte-for-byte
    const planIdx = on.indexOf('## plan mode')
    const onStaticPart = on.slice(0, planIdx).trimEnd()
    expect(off.trimEnd()).toBe(onStaticPart)
  })
})
