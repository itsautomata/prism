/**
 * pins the runtime defaults in TUNING_DEFAULTS to the user-visible values
 * inside the toml template. these two live in the same file but as separate
 * strings — without this check, bumping one and forgetting the other ships a
 * silent divergence where fresh installs see a different value in their
 * config.toml than what the runtime actually uses.
 *
 * the test parses the actual template by running initConfig against a tmp
 * home, then loadConfig from that same tmp home, and asserts the two agree
 * on every key.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-cfg-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import { initConfig, loadConfig, getConfigPath, type TuningConfig } from '../config.js'

beforeEach(() => {
  rmSync(join(TEST_HOME, '.prism'), { recursive: true, force: true })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('tuning defaults: runtime ↔ template sync', () => {
  it('every tuning key in the template matches the in-code default', () => {
    // capture the in-code defaults first, with no config file present, so the
    // snapshot reflects DEFAULTS untouched by any parse path.
    rmSync(join(TEST_HOME, '.prism'), { recursive: true, force: true })
    const fromDefaults = loadConfig().tuning

    // write the template against the tmp home and load it back through the
    // parser. these are the values a fresh user receives from the [tuning]
    // block on first launch.
    initConfig()
    const text = readFileSync(getConfigPath(), 'utf-8')
    const fromTemplate = loadConfig().tuning

    // every key must match across both paths. when the runtime default and
    // the template value drift apart, this fails and names the offending key.
    const keys = Object.keys(fromDefaults) as (keyof TuningConfig)[]
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(
        fromTemplate[key],
        `template value for ${key} (in the [tuning] block) does not match the runtime default in TUNING_DEFAULTS`,
      ).toBe(fromDefaults[key])
    }

    // also make sure the template literally mentions every key by name, a
    // typo or missing line in the template would silently fall back to the
    // default without users ever seeing the knob.
    for (const key of keys) {
      expect(text, `template is missing the line for ${key}`).toContain(key)
    }
  })
})

describe('parseToml: string fields are not numeric-coerced', () => {
  it('keeps a numeric-looking unquoted api_key as the exact string', () => {
    const dir = join(TEST_HOME, '.prism')
    mkdirSync(dir, { recursive: true })
    // unquoted, all digits, leading zero — parseInt would corrupt this
    writeFileSync(getConfigPath(), '[openrouter]\napi_key = 0012345\n', 'utf-8')

    const cfg = loadConfig()
    expect(typeof cfg.openrouter.api_key).toBe('string')
    expect(cfg.openrouter.api_key).toBe('0012345')
  })

  it('still coerces numeric [tuning] values to numbers', () => {
    const dir = join(TEST_HOME, '.prism')
    mkdirSync(dir, { recursive: true })
    writeFileSync(getConfigPath(), '[tuning]\ncompaction_threshold = 0.7\nrepomap_max_files = 300\n', 'utf-8')

    const cfg = loadConfig()
    expect(cfg.tuning.compaction_threshold).toBe(0.7)
    expect(cfg.tuning.repomap_max_files).toBe(300)
  })
})
