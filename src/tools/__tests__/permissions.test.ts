import { describe, it, expect, beforeEach } from 'vitest'
import { needsPermission, allowForSession, isSessionAllowed, clearSessionRules } from '../permissions.js'

describe('permissions', () => {
  beforeEach(() => {
    clearSessionRules()
  })

  it('read-only tools never need permission', () => {
    expect(needsPermission('Read', { behavior: 'ask', message: '' }, true)).toBe(false)
  })

  it('write tools need permission when result is ask', () => {
    expect(needsPermission('Write', { behavior: 'ask', message: '' }, false)).toBe(true)
  })

  it('tools with allow behavior skip permission', () => {
    expect(needsPermission('Bash', { behavior: 'allow' }, false)).toBe(false)
  })

  it('tools with deny behavior skip permission (denied at execution)', () => {
    expect(needsPermission('Bash', { behavior: 'deny', message: 'blocked' }, false)).toBe(false)
  })

  it('session allow rules persist', () => {
    expect(isSessionAllowed('Write')).toBe(false)
    allowForSession('Write')
    expect(isSessionAllowed('Write')).toBe(true)
  })

  it('session-allowed tools skip permission', () => {
    allowForSession('Bash')
    expect(needsPermission('Bash', { behavior: 'ask', message: '' }, false)).toBe(false)
  })

  it('clear removes all session rules', () => {
    allowForSession('Bash')
    allowForSession('Write')
    clearSessionRules()
    expect(isSessionAllowed('Bash')).toBe(false)
    expect(isSessionAllowed('Write')).toBe(false)
  })
})