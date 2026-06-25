import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { rmSync } from 'fs'

// redirect homedir() so profiles don't touch the real ~/.prism
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import { addRule, loadProfile, listProfiles } from '../profile.js'

beforeEach(() => {
  rmSync(`${TEST_HOME}/.prism`, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('model profile filename collision', () => {
  it('models that sanitize to the same name do not share rules', () => {
    // both names sanitize to `anthropic_claude` under the old scheme
    addRule('anthropic/claude', 'rule for slash')
    addRule('anthropic:claude', 'rule for colon')

    const slash = loadProfile('anthropic/claude')
    const colon = loadProfile('anthropic:claude')

    expect(slash.rules.map(r => r.rule)).toEqual(['rule for slash'])
    expect(colon.rules.map(r => r.rule)).toEqual(['rule for colon'])
  })

  it('listProfiles reports the exact model names, not filenames', () => {
    addRule('anthropic/claude', 'r')
    expect(listProfiles()).toContain('anthropic/claude')
  })
})
