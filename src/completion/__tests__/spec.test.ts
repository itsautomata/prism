import { describe, it, expect } from 'vitest'
import { FLAGS, allFlagTokens, findFlag, complete, completeOpenRouterModels } from '../spec.js'

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
