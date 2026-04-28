import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { SlashHints } from '../SlashHints.js'
import type { SlashCommandSpec } from '../commands.js'

const sample: SlashCommandSpec[] = [
  { name: '/model', args: '<name>', desc: 'switch model' },
  { name: '/rules', desc: 'show learned rules' },
  { name: '/clear', desc: 'clear the conversation' },
]

describe('SlashHints', () => {
  it('renders nothing when matches is empty', () => {
    const { lastFrame } = render(<SlashHints matches={[]} selectedIdx={0} />)
    expect(lastFrame()).toBe('')
  })

  it('renders the header line', () => {
    const { lastFrame } = render(<SlashHints matches={sample} selectedIdx={0} />)
    expect(lastFrame()).toContain('↑/↓ to navigate, tab to complete')
  })

  it('renders one row per match', () => {
    const { lastFrame } = render(<SlashHints matches={sample} selectedIdx={0} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('/model')
    expect(frame).toContain('/rules')
    expect(frame).toContain('/clear')
  })

  it('selected row has a ▸ prefix', () => {
    const { lastFrame } = render(<SlashHints matches={sample} selectedIdx={1} />)
    const lines = (lastFrame() ?? '').split('\n')
    const modelLine = lines.find(l => l.includes('/model'))
    const rulesLine = lines.find(l => l.includes('/rules'))
    const clearLine = lines.find(l => l.includes('/clear'))
    expect(rulesLine).toContain('▸')
    expect(modelLine).not.toContain('▸')
    expect(clearLine).not.toContain('▸')
  })

  it('shows args placeholder for commands that take args', () => {
    const { lastFrame } = render(<SlashHints matches={sample} selectedIdx={0} />)
    expect(lastFrame()).toContain('/model <name>')
  })

  it('omits args portion for commands without args', () => {
    const { lastFrame } = render(<SlashHints matches={sample} selectedIdx={0} />)
    const lines = (lastFrame() ?? '').split('\n')
    const rulesLine = lines.find(l => l.includes('/rules')) ?? ''
    // /rules has no args: name should not be followed by < or [
    expect(rulesLine).not.toMatch(/\/rules\s+</)
  })

  it('renders descriptions for each match', () => {
    const { lastFrame } = render(<SlashHints matches={sample} selectedIdx={0} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('switch model')
    expect(frame).toContain('show learned rules')
    expect(frame).toContain('clear the conversation')
  })
})
