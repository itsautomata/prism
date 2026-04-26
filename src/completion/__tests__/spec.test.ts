import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

// redirect homedir() so completeSessionIds doesn't touch the real ~/.prism
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-spec-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import { FLAGS, allFlagTokens, findFlag, complete, completeOpenRouterModels, completeSessionIds } from '../spec.js'

const SESSIONS_DIR = join(TEST_HOME, '.prism', 'sessions')

describe('FLAGS spec', () => {
  it('contains the core flags', () => {
    const tokens = allFlagTokens()
    expect(tokens).toContain('--or')
    expect(tokens).toContain('--openrouter')
    expect(tokens).toContain('-c')
    expect(tokens).toContain('--continue')
    expect(tokens).toContain('--max-tokens')
    expect(tokens).toContain('--config')
    expect(tokens).toContain('--sessions')
    expect(tokens).toContain('-h')
    expect(tokens).toContain('--help')
  })

  it('every FLAGS entry has a flag and a description', () => {
    for (const f of FLAGS) {
      expect(f.flag).toBeTruthy()
      expect(f.desc).toBeTruthy()
    }
  })
})

describe('findFlag', () => {
  it('finds by primary flag', () => {
    expect(findFlag('--or')?.alias).toBe('--openrouter')
  })

  it('finds by alias', () => {
    expect(findFlag('--openrouter')?.flag).toBe('--or')
  })

  it('returns undefined for unknown', () => {
    expect(findFlag('--nope')).toBeUndefined()
  })
})

describe('complete dispatch', () => {
  it('returns flags for context "flags"', async () => {
    const result = await complete('flags')
    expect(result).toContain('--or')
    expect(result).toContain('--max-tokens')
  })

  it('returns openrouter models for context "model-openrouter"', async () => {
    const result = await complete('model-openrouter')
    expect(result.length).toBeGreaterThan(0)
  })

  it('returns empty array for unknown context', async () => {
    expect(await complete('garbage')).toEqual([])
  })
})

describe('completeOpenRouterModels', () => {
  it('returns a list of model names with provider/name format', async () => {
    const models = await completeOpenRouterModels()
    expect(models.length).toBeGreaterThan(0)
    for (const m of models) {
      expect(m).toContain('/')
    }
  })
})

describe('completeSessionIds', () => {
  beforeEach(() => {
    rmSync(SESSIONS_DIR, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(TEST_HOME, { recursive: true, force: true })
  })

  it('returns an empty array when no sessions exist', () => {
    expect(completeSessionIds()).toEqual([])
  })

  it('returns the ids of recent sessions', () => {
    mkdirSync(SESSIONS_DIR, { recursive: true })
    const ids = ['2026-04-26T10-00-00-000', '2026-04-26T10-00-01-000']
    for (const id of ids) {
      const session = { id, model: 'm', provider: 'p', cwd: '/x', createdAt: 'now', updatedAt: 'now', messages: [] }
      writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(session), 'utf-8')
    }
    const result = completeSessionIds()
    expect(result.length).toBe(2)
    expect(result).toContain(ids[0])
    expect(result).toContain(ids[1])
  })

  it('caps at 20 entries (matches listSessions limit)', () => {
    mkdirSync(SESSIONS_DIR, { recursive: true })
    for (let i = 0; i < 25; i++) {
      const id = `2026-04-26T10-00-00-${String(i).padStart(3, '0')}`
      const session = { id, model: 'm', provider: 'p', cwd: '/x', createdAt: 'now', updatedAt: 'now', messages: [] }
      writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(session), 'utf-8')
    }
    expect(completeSessionIds().length).toBe(20)
  })
})
