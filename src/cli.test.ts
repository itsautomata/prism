import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { join } from 'path'

const PRISM_DIR = join(import.meta.dirname, '..')
const run = (args: string) => {
  try {
    return execSync(`npx tsx src/cli.ts ${args}`, {
      cwd: PRISM_DIR,
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, NO_COLOR: '1' },
    }).trim()
  } catch (e: any) {
    return { stdout: e.stdout?.trim() || '', stderr: e.stderr?.trim() || '', code: e.status }
  }
}

describe('CLI', () => {
  it('--help prints usage', () => {
    const output = run('--help')
    expect(output).toContain('prism')
    expect(output).toContain('usage')
    expect(output).toContain('flags')
    expect(output).toContain('--or')
    expect(output).toContain('--continue')
    expect(output).toContain('--max-tokens')
  })

  it('-h is alias for --help', () => {
    const output = run('-h')
    expect(output).toContain('usage')
  })

  it('--config prints config path', () => {
    const output = run('--config')
    expect(output).toContain('.prism')
    expect(output).toContain('config.toml')
  })

  it('--sessions works without error', () => {
    const output = run('--sessions')
    // either lists sessions or says "no sessions yet"
    expect(typeof output).toBe('string')
  })

  it('unknown flag shows error 2 dash', () => {
    const result = run('--foobar') as { stdout: string; stderr: string; code: number }
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('unknown flag')
    expect(result.stderr).toContain('--foobar')
  })
  
  it('unknown flag shows error 1 dash', () => {
    const result = run('-foobar') as { stdout: string; stderr: string; code: number }
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('unknown flag')
    expect(result.stderr).toContain('-foobar')
  })
   
  it('two positional args shows error', () => {
    const result = run('model extra') as { stdout: string; stderr: string; code: number }
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('too many arguments')
  })

  it('three positional args shows error', () => {
    const result = run('model extra more') as { stdout: string; stderr: string; code: number }
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('too many arguments')
  })

  it('multiple unknown flags reports the first one', () => {
    const result = run('--abc --xyz zx') as { stdout: string; stderr: string; code: number }
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--abc')
  })

  it('--max-tokens without value shows error', () => {
    const result = run('--max-tokens') as { stdout: string; stderr: string; code: number }
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--max-tokens requires a number')
  })

  it('--max-tokens with non-numeric value shows error', () => {
    const result = run('--max-tokens abc') as { stdout: string; stderr: string; code: number }
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('must be a positive number')
  })

  it('--max-tokens with zero shows error', () => {
    const result = run('--max-tokens 0') as { stdout: string; stderr: string; code: number }
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('must be a positive number')
  })

  it('--max-tokens with negative shows error', () => {
    const result = run('--max-tokens -5') as { stdout: string; stderr: string; code: number }
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--max-tokens requires a number')
  })

})

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

// helpers for session-related cli tests with HOME isolation
function runWithHome(args: string, home: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(`npx tsx src/cli.ts ${args}`, {
      cwd: PRISM_DIR,
      encoding: 'utf-8',
      timeout: 8000,
      env: { ...process.env, NO_COLOR: '1', HOME: home, PRISM_NO_AUTO_COMPLETION: '1' },
    })
    return { stdout: stdout.trim(), stderr: '', code: 0 }
  } catch (e: any) {
    return { stdout: e.stdout?.trim() || '', stderr: e.stderr?.trim() || '', code: e.status ?? 1 }
  }
}

function seedSession(home: string, opts: { id?: string; model?: string; provider?: string; cwd?: string; turns?: number } = {}): string {
  const id = opts.id ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23) + '-' + Math.random().toString(36).slice(2, 5)
  const dir = join(home, '.prism', 'sessions')
  mkdirSync(dir, { recursive: true })
  const messages = []
  for (let i = 0; i < (opts.turns ?? 1); i++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `msg ${i}` }] })
  }
  const session = {
    id,
    model: opts.model ?? 'qwen3:14b',
    provider: opts.provider ?? 'ollama',
    cwd: opts.cwd ?? '/tmp/test-cwd',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages,
  }
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(session, null, 2), 'utf-8')
  return id
}

describe('CLI: --sessions', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'prism-cli-sessions-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('shows "no sessions yet." on empty', () => {
    const { stdout, code } = runWithHome('--sessions', home)
    expect(code).toBe(0)
    expect(stdout).toContain('no sessions yet')
  })

  it('lists sessions numbered with model, turns, date, cwd', () => {
    seedSession(home, { model: 'qwen3:14b', cwd: '/some/cwd', turns: 3 })
    const { stdout, code } = runWithHome('--sessions', home)
    expect(code).toBe(0)
    expect(stdout).toContain(' 1.')
    expect(stdout).toContain('qwen3:14b')
    expect(stdout).toContain('3 turns')
    expect(stdout).toContain('/some/cwd')
  })

  it('shows the id on the second line of each entry', () => {
    const id = seedSession(home, { id: '2026-04-26T11-22-33-456' })
    const { stdout } = runWithHome('--sessions', home)
    expect(stdout).toContain(id)
  })

  it('counts only user-role messages as turns', () => {
    // seed a session with 2 user + 5 other messages, expect "2 turns"
    const id = '2026-04-26T11-22-33-789'
    const dir = join(home, '.prism', 'sessions')
    mkdirSync(dir, { recursive: true })
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'c' }] },
      { role: 'user', content: [{ type: 'text', text: 'd' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'e' }] },
    ]
    const session = {
      id, model: 'm', provider: 'ollama', cwd: '/x',
      createdAt: 'now', updatedAt: 'now', messages,
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(session), 'utf-8')

    const { stdout } = runWithHome('--sessions', home)
    expect(stdout).toContain('2 turns')
  })
})

describe('CLI: --resume validation (early-exit cases)', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'prism-cli-resume-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('--resume without value errors', () => {
    const { stderr, code } = runWithHome('--resume', home)
    expect(code).toBe(1)
    expect(stderr).toContain('--resume requires a session id')
  })

  it('-r without value errors', () => {
    const { stderr, code } = runWithHome('-r', home)
    expect(code).toBe(1)
    expect(stderr).toContain('--resume requires a session id')
  })

  it('--resume followed by another flag errors', () => {
    const { stderr, code } = runWithHome('--resume --or', home)
    expect(code).toBe(1)
    expect(stderr).toContain('--resume requires a session id')
  })

  it('-r with non-existent id errors with "no session"', () => {
    const { stderr, code } = runWithHome('-r nonexistent-session-id', home)
    expect(code).toBe(1)
    expect(stderr).toContain('no session with id or index')
  })

  it('-r with out-of-range index errors', () => {
    seedSession(home)
    const { stderr, code } = runWithHome('-r 999', home)
    expect(code).toBe(1)
    expect(stderr).toContain('no session with id or index')
  })

  it('-r 0 errors (1-based index)', () => {
    seedSession(home)
    const { stderr, code } = runWithHome('-r 0', home)
    expect(code).toBe(1)
    expect(stderr).toContain('no session with id or index')
  })
})

describe('CLI: --resume dispatch (load by id or index)', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'prism-cli-resume-load-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  // these tests load a real session, so prism gets PAST resume and tries to
  // connect to a provider (which will fail in CI). we look for the
  // "resuming session" stdout that prints BEFORE the connection attempt.

  it('-r 1 loads the most recent session', () => {
    const id = seedSession(home, { provider: 'ollama' })
    const { stdout } = runWithHome('-r 1', home)
    expect(stdout).toContain('resuming session')
    expect(stdout).toContain(id)
  })

  it('-r <full-id> loads that exact session', () => {
    seedSession(home, { id: '2026-04-26T11-22-33-aaa', provider: 'ollama' })
    const id2 = '2026-04-26T11-22-33-bbb'
    seedSession(home, { id: id2, provider: 'ollama' })
    const { stdout } = runWithHome(`-r ${id2}`, home)
    expect(stdout).toContain('resuming session')
    expect(stdout).toContain(id2)
  })

  it('-r N loads the Nth most recent session', () => {
    // seed 3 sessions in deterministic order
    const id1 = seedSession(home, { id: '2026-04-26T10-00-00-000' })
    const id2 = seedSession(home, { id: '2026-04-26T10-00-01-000' })
    const id3 = seedSession(home, { id: '2026-04-26T10-00-02-000' })
    // index 2 = second-most-recent = id2
    const { stdout } = runWithHome('-r 2', home)
    expect(stdout).toContain(id2)
  })
})
