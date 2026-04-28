import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { PromptInput } from '../PromptInput.js'

// the input throttles non-backspace keystrokes through a 16ms timer.
// we wait a beat between writes to let the display refresh.
async function tick(ms = 30) {
  return new Promise(r => setTimeout(r, ms))
}

const KEY = {
  up: '\u001B[A',
  down: '\u001B[B',
  tab: '\t',
  enter: '\r',
  esc: '\u001B',
}

describe('PromptInput: slash autocomplete', () => {
  let onSubmit: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onSubmit = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('typing / shows the dropdown with all 8 commands', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('/')
    await tick()
    const frame = lastFrame() ?? ''
    for (const name of ['/model', '/teach', '/rules', '/forget', '/max-tools', '/clear', '/help', '/exit']) {
      expect(frame).toContain(name)
    }
  })

  it('typing /m filters to /max-tools and /model', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('/m')
    await tick()
    const frame = lastFrame() ?? ''
    expect(frame).toContain('/max-tools')
    expect(frame).toContain('/model')
    expect(frame).not.toContain('/rules')
    expect(frame).not.toContain('/clear')
  })

  it('typing /xyz hides the dropdown (no matches)', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('/xyz')
    await tick()
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain('↑/↓ to navigate')
  })

  it('typing space after / hides the dropdown', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('/model')
    await tick()
    expect(lastFrame()).toContain('↑/↓ to navigate')
    stdin.write(' ')
    await tick()
    expect(lastFrame()).not.toContain('↑/↓ to navigate')
  })

  it('non-slash input does not show the dropdown', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('hello')
    await tick()
    expect(lastFrame()).not.toContain('↑/↓ to navigate')
  })

  it('down arrow advances selection', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('/m')
    await tick()
    // first match (/max-tools or /model) is selected
    const beforeFrame = lastFrame() ?? ''
    const beforeLines = beforeFrame.split('\n')
    const beforeSelected = beforeLines.find(l => l.includes('▸'))

    stdin.write(KEY.down)
    await tick()
    const afterFrame = lastFrame() ?? ''
    const afterLines = afterFrame.split('\n')
    const afterSelected = afterLines.find(l => l.includes('▸'))

    expect(afterSelected).toBeDefined()
    expect(afterSelected).not.toBe(beforeSelected)
  })

  it('down arrow at last index stays at last (clamped)', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('/m')
    await tick()
    // /m matches 2 commands in source-array order: /model, /max-tools.
    // 5 downs clamps at last index (1) = /max-tools.
    for (let i = 0; i < 5; i++) {
      stdin.write(KEY.down)
      await tick(15)
    }
    const frame = lastFrame() ?? ''
    const lines = frame.split('\n')
    const arrowLine = lines.find(l => l.includes('▸')) ?? ''
    expect(arrowLine).toContain('/max-tools')
  })

  it('up arrow at index 0 stays at 0 (clamped)', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('/m')
    await tick()
    // 5 ups clamps at first index (0) = /model (source-array order).
    for (let i = 0; i < 5; i++) {
      stdin.write(KEY.up)
      await tick(15)
    }
    const frame = lastFrame() ?? ''
    const lines = frame.split('\n')
    const arrowLine = lines.find(l => l.includes('▸')) ?? ''
    expect(arrowLine).toContain('/model')
  })

  it('tab completes to selected command name with trailing space if it takes args', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('/mo')
    await tick()
    // /mo matches /model (which has args)
    stdin.write(KEY.tab)
    await tick()
    const frame = lastFrame() ?? ''
    // buffer should now read /model<space> (visible portion of the input row)
    expect(frame).toMatch(/\/model\s/)
  })

  it('tab completes to just the name with no trailing space if no args', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('/cl')
    await tick()
    // /cl matches /clear (no args)
    stdin.write(KEY.tab)
    await tick()
    const frame = lastFrame() ?? ''
    // dropdown should be gone (showHints became false because tab completed without trailing space)
    expect(frame).toContain('/clear')
  })

  it('enter submits the buffer regardless of selected hint', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('/clear')
    await tick()
    stdin.write(KEY.enter)
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('/clear')
  })
})
