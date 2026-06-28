import { describe, it, expect, beforeEach } from 'vitest'
import { needsPermission, allowForSession, isSessionAllowed, clearSessionRules } from '../permissions.js'

describe('permissions', () => {
  beforeEach(() => {
    clearSessionRules()
  })

  it('read-only tools auto-allow via the allow behavior', () => {
    expect(needsPermission('Read', { behavior: 'allow' })).toBe(false)
  })

  it('a tool that returns ask always needs permission (no isReadOnly bypass)', () => {
    expect(needsPermission('Write', { behavior: 'ask', message: '' })).toBe(true)
  })

  it('tools with allow behavior skip permission', () => {
    expect(needsPermission('Bash', { behavior: 'allow' })).toBe(false)
  })

  it('tools with deny behavior skip permission (denied at execution)', () => {
    expect(needsPermission('Bash', { behavior: 'deny', message: 'blocked' })).toBe(false)
  })

  it('session allow rules persist', () => {
    expect(isSessionAllowed('Write')).toBe(false)
    allowForSession('Write')
    expect(isSessionAllowed('Write')).toBe(true)
  })

  it('subagents (respectSessionRules=false) ignore session-allow so their deny floor holds', () => {
    allowForSession('Verify')
    // main conversation: session-allow short-circuits the prompt
    expect(needsPermission('Verify', { behavior: 'ask', message: '' })).toBe(false)
    // subagent: session-allow is ignored, so the resolver is still consulted
    expect(needsPermission('Verify', { behavior: 'ask', message: '' }, false)).toBe(true)
  })

  it('session-allowed tools skip permission', () => {
    allowForSession('Bash')
    expect(needsPermission('Bash', { behavior: 'ask', message: '' })).toBe(false)
  })

  it('clear removes all session rules', () => {
    allowForSession('Bash')
    allowForSession('Write')
    clearSessionRules()
    expect(isSessionAllowed('Bash')).toBe(false)
    expect(isSessionAllowed('Write')).toBe(false)
  })
})