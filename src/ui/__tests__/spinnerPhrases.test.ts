import { describe, it, expect } from 'vitest'
import {
  chooseBucket,
  pickPhrase,
  PHRASES,
  STUCK_THRESHOLD_SEC,
  type SelectionContext,
} from '../spinnerPhrases.js'

const ctx = (over: Partial<SelectionContext>): SelectionContext => ({
  phase: 'thinking',
  inPlanMode: false,
  elapsedSec: 0,
  ...over,
})

describe('chooseBucket: priority order', () => {
  it('plan-mode wins over default thinking', () => {
    expect(chooseBucket(ctx({ phase: 'thinking', inPlanMode: true }))).toBe('planMode')
  })

  it('plan-mode does NOT override a running tool (executing matters more)', () => {
    expect(chooseBucket(ctx({ phase: 'running', tool: 'Read', inPlanMode: true }))).toBe('Read')
  })

  it('stuck bucket kicks in at the threshold', () => {
    expect(chooseBucket(ctx({ phase: 'thinking', elapsedSec: STUCK_THRESHOLD_SEC }))).toBe('stuck')
  })

  it('stuck bucket does NOT fire one second before the threshold', () => {
    expect(chooseBucket(ctx({ phase: 'thinking', elapsedSec: STUCK_THRESHOLD_SEC - 1 }))).toBe('thinking')
  })

  it('stuck bucket does not apply during a running tool', () => {
    expect(chooseBucket(ctx({ phase: 'running', tool: 'Bash', elapsedSec: 999 }))).toBe('Bash')
  })

  it('tool bucket selected when phase is running and tool name is known', () => {
    expect(chooseBucket(ctx({ phase: 'running', tool: 'Verify' }))).toBe('Verify')
  })

  it('unknown tool falls through to thinking (not crashed, not empty)', () => {
    expect(chooseBucket(ctx({ phase: 'running', tool: 'Mystery' }))).toBe('thinking')
  })

  it('after-tool phase routes to afterTool bucket regardless of tool name', () => {
    expect(chooseBucket(ctx({ phase: 'after-tool', tool: 'Edit' }))).toBe('afterTool')
  })

  it('plain thinking is the default', () => {
    expect(chooseBucket(ctx({}))).toBe('thinking')
  })
})

describe('pickPhrase: no-repeat window', () => {
  it('excludes every phrase in the recentPhrases window', () => {
    const recent = PHRASES.thinking!.slice(0, 3)
    const result = pickPhrase(ctx({ recentPhrases: recent }), () => 0)
    expect(recent).not.toContain(result)
    expect(PHRASES.thinking).toContain(result)
  })

  it('falls back to the full pool when the window would empty it', () => {
    const recent = [...PHRASES.thinking!]
    const result = pickPhrase(ctx({ recentPhrases: recent }), () => 0)
    expect(PHRASES.thinking).toContain(result)
  })

  it('an empty recentPhrases window means the full pool is available', () => {
    const result = pickPhrase(ctx({ recentPhrases: [] }), () => 0)
    expect(PHRASES.thinking).toContain(result)
  })

  it('picks from the planMode pool when inPlanMode + thinking', () => {
    const result = pickPhrase(ctx({ phase: 'thinking', inPlanMode: true }), () => 0)
    expect(PHRASES.planMode).toContain(result)
  })

  it('picks from the stuck pool past threshold', () => {
    const result = pickPhrase(ctx({ phase: 'thinking', elapsedSec: STUCK_THRESHOLD_SEC + 10 }), () => 0)
    expect(PHRASES.stuck).toContain(result)
  })

  it('picks from the tool-specific pool when running a known tool', () => {
    const result = pickPhrase(ctx({ phase: 'running', tool: 'Read' }), () => 0)
    expect(PHRASES.Read).toContain(result)
  })

  it('picks from the afterTool pool after a tool finishes', () => {
    const result = pickPhrase(ctx({ phase: 'after-tool', tool: 'Bash' }), () => 0)
    expect(PHRASES.afterTool).toContain(result)
  })
})

describe('PHRASES: pool hygiene', () => {
  it('every pool has at least one phrase', () => {
    for (const [name, pool] of Object.entries(PHRASES)) {
      expect(pool.length, `pool ${name} is empty`).toBeGreaterThan(0)
    }
  })

  it('no phrase contains an em-dash (writing rule)', () => {
    for (const [name, pool] of Object.entries(PHRASES)) {
      for (const phrase of pool) {
        expect(phrase, `pool ${name}`).not.toContain('—')
      }
    }
  })

  it('every phrase is lowercase at sentence start (writing rule)', () => {
    for (const [name, pool] of Object.entries(PHRASES)) {
      for (const phrase of pool) {
        const first = phrase[0] ?? ''
        expect(first, `pool ${name}, phrase "${phrase}"`).toBe(first.toLowerCase())
      }
    }
  })
})
