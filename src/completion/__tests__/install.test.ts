import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { detectShell, rcPathFor, installCompletion } from '../install.js'

describe('detectShell', () => {
  const original = process.env.SHELL

  afterEach(() => {
    if (original === undefined) delete process.env.SHELL
    else process.env.SHELL = original
  })

  it('returns zsh for /bin/zsh', () => {
    process.env.SHELL = '/bin/zsh'
    expect(detectShell()).toBe('zsh')
  })

  it('returns bash for /usr/local/bin/bash', () => {
    process.env.SHELL = '/usr/local/bin/bash'
    expect(detectShell()).toBe('bash')
  })

  it('returns null for fish (unsupported)', () => {
    process.env.SHELL = '/usr/bin/fish'
    expect(detectShell()).toBeNull()
  })

  it('returns null when SHELL is unset', () => {
    delete process.env.SHELL
    expect(detectShell()).toBeNull()
  })
})

describe('rcPathFor', () => {
  it('returns ~/.zshrc for zsh', () => {
    const p = rcPathFor('zsh')
    expect(p.endsWith('/.zshrc')).toBe(true)
  })

  it('respects ZDOTDIR for zsh', () => {
    const original = process.env.ZDOTDIR
    process.env.ZDOTDIR = '/custom/zdir'
    expect(rcPathFor('zsh')).toBe('/custom/zdir/.zshrc')
    if (original === undefined) delete process.env.ZDOTDIR
    else process.env.ZDOTDIR = original
  })

  it('returns a bash rc path for bash', () => {
    const p = rcPathFor('bash')
    expect(p.endsWith('/.bashrc') || p.endsWith('/.bash_profile')).toBe(true)
  })
})

describe('installCompletion', () => {
  let dir: string
  let rcPath: string
  const originalHome = process.env.HOME
  const originalZdotdir = process.env.ZDOTDIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prism-install-test-'))
    process.env.HOME = dir
    process.env.ZDOTDIR = dir
    rcPath = join(dir, '.zshrc')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalZdotdir === undefined) delete process.env.ZDOTDIR
    else process.env.ZDOTDIR = originalZdotdir
  })

  it('appends the eval line when rc file does not exist', () => {
    const result = installCompletion('zsh')
    expect(result.status).toBe('installed')
    expect(result.rcPath).toBe(rcPath)
    expect(existsSync(rcPath)).toBe(true)
    expect(readFileSync(rcPath, 'utf-8')).toContain('eval "$(prism --completion zsh)"')
  })

  it('appends the eval line when rc file exists but lacks the line', () => {
    writeFileSync(rcPath, '# existing config\nexport FOO=bar\n', 'utf-8')
    const result = installCompletion('zsh')
    expect(result.status).toBe('installed')
    const contents = readFileSync(rcPath, 'utf-8')
    expect(contents).toContain('export FOO=bar')
    expect(contents).toContain('eval "$(prism --completion zsh)"')
  })

  it('is idempotent: second call reports already-installed', () => {
    installCompletion('zsh')
    const result = installCompletion('zsh')
    expect(result.status).toBe('already-installed')
    const contents = readFileSync(rcPath, 'utf-8')
    const matches = contents.match(/eval "\$\(prism --completion zsh\)"/g) || []
    expect(matches.length).toBe(1)
  })

  it('throws when shell cannot be detected and none is requested', () => {
    const original = process.env.SHELL
    delete process.env.SHELL
    expect(() => installCompletion()).toThrow(/could not detect shell/)
    if (original !== undefined) process.env.SHELL = original
  })
})
