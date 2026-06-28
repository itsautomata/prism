import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { VerifyTool } from '../verify.js'

const ctx = (cwd: string) => ({ cwd, signal: undefined as AbortSignal | undefined })

describe('VerifyTool', () => {
  it('runs a passing command and returns its output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'))
    try {
      const result = await VerifyTool.call({ command: 'echo hello' }, ctx(dir))
      expect(result.isError).toBeFalsy()
      expect(result.content).toContain('verified:')
      expect(result.content).toContain('hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports failure with exit code when the command exits non-zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-'))
    try {
      const result = await VerifyTool.call({ command: 'exit 2' }, ctx(dir))
      expect(result.isError).toBe(true)
      expect(result.content).toContain('verification failed:')
      expect(result.content).toContain('exit code: 2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('asks permission before running (no auto-allow)', () => {
    const perm = VerifyTool.checkPermissions({ command: 'npx vitest run' }, ctx('/tmp'))
    expect(perm.behavior).toBe('ask')
    expect(perm.behavior === 'ask' && perm.message).toContain('npx vitest run')
  })

  it('is not read-only: it runs an arbitrary shell command', () => {
    expect(VerifyTool.isReadOnly({ command: 'pytest' })).toBe(false)
  })

  it('declares itself not concurrency-safe (build/test pipelines serialize)', () => {
    expect(VerifyTool.isConcurrencySafe({ command: 'go test ./...' })).toBe(false)
  })
})
