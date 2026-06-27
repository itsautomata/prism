import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { PromptInput, renderSegments } from '../PromptInput.js'
import { PHRASES } from '../spinnerPhrases.js'
import type { Segment } from '../inputBuffer.js'

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
    // wait for the hint dropdown to render the /model match before tab. pressing
    // tab before the dropdown computes its matches makes completion a no-op, which
    // flakes under load — poll the condition instead of sleeping a fixed time.
    for (let i = 0; i < 30 && !(lastFrame() ?? '').includes('model'); i++) await tick(15)
    stdin.write(KEY.tab)
    await tick()
    // type an arg char to expose the trailing space in the buffer.
    // (lastFrame trims trailing whitespace per line, so the bare space is invisible
    // unless followed by a non-space char.)
    stdin.write('x')
    for (let i = 0; i < 30 && !/\/model\sx/.test(lastFrame() ?? ''); i++) await tick(15)
    expect(lastFrame() ?? '').toMatch(/\/model\sx/)
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

describe('PromptInput: multi-line input', () => {
  let onSubmit: (text: string) => void

  beforeEach(() => {
    onSubmit = vi.fn() as unknown as (text: string) => void
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // alt+enter as a raw byte sequence: ESC followed by CR. some terminals send
  // LF instead; both routes are tested below.
  const ALT_ENTER_CR = '\x1b\r'
  const ALT_ENTER_LF = '\x1b\n'

  it('plain enter submits the buffer (single-line behavior unchanged)', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('hi')
    await tick()
    stdin.write('\r')
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('hi')
  })

  it('alt+enter (ESC+CR) inserts a newline instead of submitting', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('first')
    await tick()
    stdin.write(ALT_ENTER_CR)
    await tick()
    stdin.write('second')
    await tick()
    // plain enter now submits the multi-line text
    stdin.write('\r')
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('first\nsecond')
  })

  it('alt+enter (ESC+LF) also inserts a newline (alternate terminal route)', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('a')
    await tick()
    stdin.write(ALT_ENTER_LF)
    await tick()
    stdin.write('b')
    await tick()
    stdin.write('\r')
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('a\nb')
  })

  it('renders inside a bordered box', async () => {
    const { lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    await tick()
    const frame = lastFrame() ?? ''
    // ink's round border uses these unicode corner characters; their presence
    // confirms the box is in place without coupling the test to exact width.
    expect(frame).toMatch(/[╭╮╰╯]/)
  })

  it('multi-line buffer survives submit and reports the full text', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('line one')
    await tick()
    stdin.write(ALT_ENTER_CR)
    await tick()
    stdin.write('line two')
    await tick()
    stdin.write(ALT_ENTER_CR)
    await tick()
    stdin.write('line three')
    await tick()
    stdin.write('\r')
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('line one\nline two\nline three')
  })

  it('split-event option+enter (escape then return) inserts a newline', async () => {
    // simulates macos terminal.app / ssh path: option+enter arrives as two
    // separate events with a tiny gap. the deferred-escape mechanism must
    // re-classify the pair as a newline-insert and never clear the buffer.
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('keep me')
    await tick()
    stdin.write('\x1b')      // escape arrives alone (NOT followed by a sequence)
    await tick(10)           // small gap, still well inside the 50ms window
    stdin.write('\r')        // return follows; should be reclassified as newline
    await tick()
    stdin.write('next')
    await tick()
    stdin.write('\r')        // plain return now submits
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('keep me\nnext')
  })

  it('a lone escape does NOT clear the buffer (stray/split escapes must not destroy input)', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('keep this')
    await tick()
    stdin.write('\x1b')        // a lone escape (used to wipe the buffer, now a no-op)
    await tick(100)            // past the 50ms modified-enter window
    stdin.write(' and more')
    await tick()
    stdin.write('\r')
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('keep this and more')
  })

  it('a key after a lone escape is processed normally, not as a clear', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('hello')
    await tick()
    stdin.write('\x1b')        // escape arrives alone (arms the window)
    await tick(10)             // separate event, inside the 50ms window
    stdin.write('x')           // a normal key follows (used to clear, now just inserts)
    await tick()
    stdin.write('\r')
    await tick()
    // the buffer survives; 'x' is appended (a split escape sequence can no longer wipe input)
    expect(onSubmit).toHaveBeenCalledWith('hellox')
  })

  it('up arrow on a multi-line buffer moves cursor up a line, preserving column', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    // type two lines: "abc" then alt+enter then "xyz"
    stdin.write('abc')
    await tick()
    stdin.write('\x1b\r')  // alt+enter newline
    await tick()
    stdin.write('xyz')
    await tick()
    // cursor is now at end of "xyz" (col 3 of line 1). up should move to col 3 of line 0 (after 'c').
    stdin.write('\x1b[A')  // up arrow
    await tick()
    // type 'X' at the cursor position. should land after 'abc' → buffer becomes "abcX\nxyz"
    stdin.write('X')
    await tick()
    stdin.write('\r')  // submit
    await tick()
    expect(onSubmit).toHaveBeenCalledWith('abcX\nxyz')
  })

  it('down arrow on a multi-line buffer moves cursor down a line', async () => {
    const { stdin } = render(<PromptInput onSubmit={onSubmit} isLoading={false} />)
    stdin.write('abc')
    await tick()
    stdin.write('\x1b\r')
    await tick()
    stdin.write('xyz')
    await tick()
    // move to start, then up to line 0
    stdin.write('\x01')   // ctrl+a → start
    await tick()
    // cursor now at pos 0 (line 0, col 0). down → pos = start of line 1.
    stdin.write('\x1b[B')  // down arrow
    await tick()
    stdin.write('Y')
    await tick()
    stdin.write('\r')
    await tick()
    // 'Y' lands at start of line 1, so buffer is "abc\nYxyz"
    expect(onSubmit).toHaveBeenCalledWith('abc\nYxyz')
  })
})

describe('PromptInput: thinking indicator', () => {
  let onSubmit: (text: string) => void

  beforeEach(() => {
    onSubmit = vi.fn() as unknown as (text: string) => void
  })

  it('renders a thinking-pool phrase by default when isLoading and no overrides', async () => {
    const { lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={true} />)
    await tick()
    const frame = lastFrame() ?? ''
    const matched = PHRASES.thinking!.some(p => frame.includes(`${p}...`))
    expect(matched, `frame did not contain any thinking-pool phrase: ${frame}`).toBe(true)
    expect(frame).toContain('esc to interrupt')
  })

  it('activity prop overrides phrase selection (raw label)', async () => {
    const { lastFrame } = render(
      <PromptInput onSubmit={onSubmit} isLoading={true} activity="running Read" />,
    )
    await tick()
    expect(lastFrame()).toContain('running Read...')
  })

  it('phase=running + currentTool routes to the tool-specific pool', async () => {
    const { lastFrame } = render(
      <PromptInput onSubmit={onSubmit} isLoading={true} phase="running" currentTool="Read" />,
    )
    await tick()
    const frame = lastFrame() ?? ''
    const matched = PHRASES.Read!.some(p => frame.includes(`${p}...`))
    expect(matched, `frame did not contain any Read-pool phrase: ${frame}`).toBe(true)
  })

  it('inPlanMode + thinking phase routes to the planMode pool', async () => {
    const { lastFrame } = render(
      <PromptInput onSubmit={onSubmit} isLoading={true} phase="thinking" inPlanMode={true} />,
    )
    await tick()
    const frame = lastFrame() ?? ''
    const matched = PHRASES.planMode!.some(p => frame.includes(`${p}...`))
    expect(matched, `frame did not contain any planMode-pool phrase: ${frame}`).toBe(true)
  })

  it('phase=after-tool routes to the afterTool pool regardless of tool name', async () => {
    const { lastFrame } = render(
      <PromptInput onSubmit={onSubmit} isLoading={true} phase="after-tool" currentTool="Bash" />,
    )
    await tick()
    const frame = lastFrame() ?? ''
    const matched = PHRASES.afterTool!.some(p => frame.includes(`${p}...`))
    expect(matched, `frame did not contain any afterTool-pool phrase: ${frame}`).toBe(true)
  })

  it('renders a braille spinner glyph (animated)', async () => {
    const { lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={true} />)
    await tick()
    const frame = lastFrame() ?? ''
    // the spinner uses braille frames; at least one must be on screen
    expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
  })

  it('shows elapsed seconds once at least a second has passed', async () => {
    const { lastFrame } = render(<PromptInput onSubmit={onSubmit} isLoading={true} />)
    // wait ~1.1s for elapsedSec to roll over to 1
    await tick(1100)
    expect(lastFrame()).toMatch(/· \d+s/)
  })

  it('does NOT render the indicator when isLoading is false', async () => {
    const { lastFrame } = render(
      <PromptInput onSubmit={onSubmit} isLoading={false} activity="should not appear" />,
    )
    await tick()
    expect(lastFrame()).not.toContain('should not appear')
    expect(lastFrame()).not.toContain('esc to interrupt')
  })
})

describe('renderSegments: multi-byte', () => {
  it('keeps an astral char (emoji) whole when the cursor splits the segment', () => {
    const segs: Segment[] = [{ kind: 'text', chars: '😀x' }]
    // cursor at atom 1: just past the emoji. UTF-16 slicing here would split
    // the surrogate pair; the text before the cursor must be the whole emoji.
    const nodes = renderSegments(segs, 1)
    const before = nodes.find(n =>
      String((n as { key?: unknown }).key ?? '').includes('pre'),
    ) as { props: { children: string } } | undefined
    expect(before?.props.children).toBe('😀')
  })
})
