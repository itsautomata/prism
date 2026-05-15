import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { PermissionPrompt } from '../PermissionPrompt.js'

const KEY = {
  up: '\u001B[A',
  down: '\u001B[B',
  enter: '\r',
  esc: '',
}

describe('PermissionPrompt', () => {
  it('renders nothing when toolName is null', () => {
    const onDecision = vi.fn()
    const { lastFrame } = render(<PermissionPrompt toolName={null} description={null} onDecision={onDecision} />)
    expect(lastFrame()).toBe('')
  })

  it('renders tool name and description when active', () => {
    const onDecision = vi.fn()
    const { lastFrame } = render(<PermissionPrompt toolName="BashTool" description="run: echo hello" onDecision={onDecision} />)
    const frame = lastFrame()
    expect(frame).toContain('BashTool')
    expect(frame).toContain('run: echo hello')
  })

  it('pressing y calls onDecision with allow_once', () => {
    const onDecision = vi.fn()
    const { stdin } = render(<PermissionPrompt toolName="BashTool" description="run: echo hello" onDecision={onDecision} />)
    stdin.write('y')
    expect(onDecision).toHaveBeenCalledWith('allow_once')
  })

  it('pressing a calls onDecision with allow_session', () => {
    const onDecision = vi.fn()
    const { stdin } = render(<PermissionPrompt toolName="BashTool" description="run: echo hello" onDecision={onDecision} />)
    stdin.write('a')
    expect(onDecision).toHaveBeenCalledWith('allow_session')
  })

  it('pressing n calls onDecision with deny', () => {
    const onDecision = vi.fn()
    const { stdin } = render(<PermissionPrompt toolName="BashTool" description="run: echo hello" onDecision={onDecision} />)
    stdin.write('n')
    expect(onDecision).toHaveBeenCalledWith('deny')
  })

  it('pressing enter calls onDecision with the selected option', () => {
    const onDecision = vi.fn()
    const { stdin } = render(<PermissionPrompt toolName="BashTool" description="run: echo hello" onDecision={onDecision} />)
    stdin.write(KEY.enter)
    expect(onDecision).toHaveBeenCalledWith('allow_once')
  })

  it('pressing down arrow changes selection, then enter uses new selection', () => {
    const onDecision = vi.fn()
    const { stdin } = render(<PermissionPrompt toolName="BashTool" description="run: echo hello" onDecision={onDecision} />)
    stdin.write(KEY.down)
    stdin.write(KEY.enter)
    expect(onDecision).toHaveBeenCalledWith('allow_session')
  })

  it('ignores keys when toolName is null', () => {
    const onDecision = vi.fn()
    const { stdin } = render(<PermissionPrompt toolName={null} description={null} onDecision={onDecision} />)
    stdin.write('y')
    stdin.write(KEY.esc)
    stdin.write('n')
    expect(onDecision).not.toHaveBeenCalled()
  })
})