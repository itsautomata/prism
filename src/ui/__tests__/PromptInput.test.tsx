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
  // typed explicitly so the `Mock` type is assignable to PromptInput's
  // `onSubmit: (text: string) => void` prop signature
  let onSubmit: (text: string) => void

  beforeEach(() => {
    onSubmit = vi.fn() as unknown as (text: string) => void
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
    // type an arg char to expose the trailing space in the buffer.
    // (lastFrame trims trailing whitespace per line, so the bare space is invisible
    // unless followed by a non-space char.)
    stdin.write('x')
    await tick(20)
    const frame = lastFrame() ?? ''
    expect(frame).toMatch(/\/model\sx/)
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

  it('enter on a partial match commits the highlighted command without submitting', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    // /cl matches /clear. enter parity with tab: insert /clear, do not submit yet.
    stdin.write('/cl')
    await tick()
    stdin.write(KEY.enter)
    await tick()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('second enter submits a buffer that already matches the highlighted command', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    // first enter commits /cl -> /clear; second enter submits.
    stdin.write('/cl')
    await tick()
    stdin.write(KEY.enter)
    await tick()
    stdin.write(KEY.enter)
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('/clear')
  })

  it('enter on a partial arg-taking match commits without submitting', async () => {
    const { stdin, lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    // /tea matches /teach (which takes an arg). enter inserts '/teach ' and waits.
    stdin.write('/tea')
    await tick()
    stdin.write(KEY.enter)
    await tick()
    expect(onSubmit).not.toHaveBeenCalled()
    // type a char to expose the trailing space (lastFrame strips trailing whitespace).
    stdin.write('x')
    await tick(20)
    const frame = lastFrame() ?? ''
    expect(frame).toMatch(/\/teach\sx/)
  })

  it('tab on a partial match commits without submitting', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('/cl')
    await tick()
    stdin.write(KEY.tab)
    await tick()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('tab on a buffer that already matches is a no-op', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('/cl')
    await tick()
    stdin.write(KEY.tab)
    await tick()
    stdin.write(KEY.tab)
    await tick()
    // tab on the already-committed buffer should not submit
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('stale display does not commit the wrong command on enter', async () => {
    // regression: enter/tab committed from the stale `matches` closure (derived
    // from the throttled display state) instead of the live buffer. typing fast
    // could leave display at '/' while bufferRef already held '/exec-plan';
    // with selectedHintIdx navigated to /cancel-plan (index 3 in the full list),
    // the old code committed /cancel-plan instead of the intended command.
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)

    stdin.write('/')
    await tick() // display settles to '/', dropdown shows all 14 commands

    // navigate to /cancel-plan: /model(0) → /plan(1) → /exec-plan(2) → /cancel-plan(3)
    stdin.write(KEY.down)
    await tick(15)
    stdin.write(KEY.down)
    await tick(15)
    stdin.write(KEY.down)
    await tick(15)

    // type the rest of /exec-plan without waiting — display is still '/'
    // at the time enter fires, bufferRef = '/exec-plan' but the stale display
    // closure still sees all 14 matches with /cancel-plan highlighted
    stdin.write('exec-plan')
    stdin.write(KEY.enter) // no tick before this: display hasn't refreshed yet

    await tick()
    expect(onSubmit).toHaveBeenCalledWith('/exec-plan')
    expect(onSubmit).not.toHaveBeenCalledWith('/cancel-plan')
  })
})
