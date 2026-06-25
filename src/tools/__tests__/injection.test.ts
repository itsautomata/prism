import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { GrepTool } from '../grep.js'
import { GlobTool } from '../glob.js'
import { BashTool } from '../bash.js'

// these tests verify that the swap from execSync(string) to execFileSync(cmd, args)
// in grep / glob actually prevents shell expansion. the canary file is written by
// a `$(...)` payload baked into the tool input — if execution reaches a shell,
// the canary appears on disk; if args are passed properly, it never exists.

let projectRoot: string
let canary: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'prism-injection-'))
  canary = join(projectRoot, 'pwned-canary')
})

afterEach(() => {
  if (existsSync(canary)) unlinkSync(canary)
  rmSync(projectRoot, { recursive: true, force: true })
})

describe('GrepTool: command injection guard', () => {
  it('shell metacharacters in pattern do not execute', async () => {
    writeFileSync(join(projectRoot, 'a.txt'), 'hello world')
    // if grep ran through a shell, `$(touch ...)` would create the canary
    await GrepTool.call(
      { pattern: `hello$(touch ${canary})`, path: projectRoot },
      { cwd: projectRoot },
    )
    expect(existsSync(canary)).toBe(false)
  })

  it('shell metacharacters in path do not execute', async () => {
    await GrepTool.call(
      { pattern: 'hello', path: `${projectRoot}$(touch ${canary})` },
      { cwd: projectRoot },
    )
    expect(existsSync(canary)).toBe(false)
  })

  it('shell metacharacters in glob do not execute', async () => {
    writeFileSync(join(projectRoot, 'a.txt'), 'hello world')
    await GrepTool.call(
      { pattern: 'hello', path: projectRoot, glob: `$(touch ${canary})`, output_mode: 'content' },
      { cwd: projectRoot },
    )
    expect(existsSync(canary)).toBe(false)
  })
})

describe('GlobTool: command injection guard', () => {
  it('shell metacharacters in pattern do not execute', async () => {
    await GlobTool.call(
      { pattern: `*$(touch ${canary}).ts` },
      { cwd: projectRoot },
    )
    expect(existsSync(canary)).toBe(false)
  })

  it('shell metacharacters in path do not execute', async () => {
    await GlobTool.call(
      { pattern: '*.ts', path: `${projectRoot}$(touch ${canary})` },
      { cwd: projectRoot },
    )
    expect(existsSync(canary)).toBe(false)
  })
})

describe('BashTool: safety classification (permission-gate regression)', () => {
  // a command that merely starts with a safe token must not be treated as
  // read-only / auto-allowed — that was the bypass: `echo ok && rm -rf ~`
  // ran with no prompt because the first token (`echo`) was in SAFE_COMMANDS.
  const bypasses = [
    'echo ok && rm -rf ~',
    'echo hi; rm -rf /tmp/x',
    'cat list.txt | xargs rm -f',
    'echo data > ~/.zshrc',
    'echo $(rm -rf foo)',
    'find . -name x -delete && echo done',
    'date && sudo rm -rf /',
  ]

  for (const command of bypasses) {
    it(`does not auto-allow: ${command}`, () => {
      expect(BashTool.isReadOnly({ command })).toBe(false)
      expect(BashTool.isConcurrencySafe({ command })).toBe(false)
      expect(BashTool.checkPermissions({ command }, { cwd: '/' }).behavior).not.toBe('allow')
    })
  }

  it('still auto-allows a genuinely simple read command', () => {
    expect(BashTool.isReadOnly({ command: 'ls -la' })).toBe(true)
    expect(BashTool.checkPermissions({ command: 'git status' }, { cwd: '/' }).behavior).toBe('allow')
  })
})
