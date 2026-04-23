import { describe, it, expect } from 'vitest'
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

describe('bin/prism', () => {
  it('resolves its own path and runs', () => {
    const output = execSync('./bin/prism --help', {
      cwd: PRISM_DIR,
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env, NO_COLOR: '1' },
    }).trim()
    expect(output).toContain('prism')
    expect(output).toContain('usage')
  })
})