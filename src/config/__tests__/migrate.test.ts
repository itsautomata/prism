import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// pin homedir to a per-suite tmp so ~/.prism/config.toml writes don't touch
// the real config. hoisted so the mock factory captures the path before any
// import of the module under test.
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-cfg-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import { initConfig, migrateConfig, loadConfig, getConfigPath } from '../config.js'

beforeEach(() => {
  rmSync(join(TEST_HOME, '.prism'), { recursive: true, force: true })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('migrateConfig', () => {
  it('returns [] when no config exists (initConfig handles that case)', () => {
    expect(migrateConfig()).toEqual([])
  })

  it('returns [] when config is current (idempotent: nothing to add)', () => {
    initConfig()
    const before = readFileSync(getConfigPath(), 'utf-8')
    expect(migrateConfig()).toEqual([])
    expect(readFileSync(getConfigPath(), 'utf-8')).toBe(before)
  })

  it('appends [tuning] when an older config is missing it', () => {
    // simulate an old config: everything except [tuning]
    mkdirSync(join(TEST_HOME, '.prism'), { recursive: true })
    const older = [
      'default_provider = "ollama"',
      'default_model = "qwen3:14b"',
      '',
      '[openrouter]',
      'api_key = "sk-or-existing"',
    ].join('\n')
    writeFileSync(getConfigPath(), older, 'utf-8')

    const added = migrateConfig()
    expect(added).toEqual(['tuning'])

    const after = readFileSync(getConfigPath(), 'utf-8')
    // appended; original lines preserved verbatim
    expect(after).toContain('[tuning]')
    expect(after).toContain('repomap_max_lines = 500')
    expect(after).toContain('default_model = "qwen3:14b"')
    expect(after).toContain('api_key = "sk-or-existing"')
  })

  it('is idempotent: running twice does not duplicate the block', () => {
    mkdirSync(join(TEST_HOME, '.prism'), { recursive: true })
    writeFileSync(getConfigPath(), 'default_provider = "ollama"\n', 'utf-8')

    expect(migrateConfig()).toEqual(['tuning'])
    expect(migrateConfig()).toEqual([])

    const text = readFileSync(getConfigPath(), 'utf-8')
    // exactly one [tuning] header — not two
    const occurrences = (text.match(/^\[tuning\]/gm) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('migrated values are parsed correctly by loadConfig', () => {
    mkdirSync(join(TEST_HOME, '.prism'), { recursive: true })
    writeFileSync(getConfigPath(), 'default_model = "test-model"\n', 'utf-8')
    migrateConfig()

    const cfg = loadConfig()
    // appended block defaults must be active
    expect(cfg.tuning.repomap_max_files).toBe(500)
    expect(cfg.tuning.repomap_max_lines).toBe(500)
    expect(cfg.tuning.compaction_threshold).toBe(0.8)
    // the user's pre-existing value survives intact
    expect(cfg.default_model).toBe('test-model')
  })

  it('preserves user-tuned values when [tuning] already exists with overrides', () => {
    initConfig()
    const text = readFileSync(getConfigPath(), 'utf-8')
    // a custom value distinct from the default, used to confirm an existing
    // user-tuned entry is preserved verbatim when migrateConfig runs.
    const tweaked = text.replace(/repomap_max_lines = \d+/, 'repomap_max_lines = 1234')
    writeFileSync(getConfigPath(), tweaked, 'utf-8')

    expect(migrateConfig()).toEqual([])
    expect(loadConfig().tuning.repomap_max_lines).toBe(1234)
  })
})

describe('initConfig', () => {
  it('writes a complete config with [tuning] from a clean slate', () => {
    expect(existsSync(getConfigPath())).toBe(false)
    initConfig()
    expect(existsSync(getConfigPath())).toBe(true)

    const text = readFileSync(getConfigPath(), 'utf-8')
    expect(text).toContain('[openrouter]')
    expect(text).toContain('[tuning]')
    expect(text).toContain('repomap_max_lines = 500')
  })

  it('does not overwrite an existing config', () => {
    mkdirSync(join(TEST_HOME, '.prism'), { recursive: true })
    writeFileSync(getConfigPath(), 'custom = "kept"\n', 'utf-8')
    initConfig()
    expect(readFileSync(getConfigPath(), 'utf-8')).toBe('custom = "kept"\n')
  })
})
