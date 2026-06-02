import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { scanProject } from '../scanner.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'prism-scan-test-'))
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('scanProject: testing signal', () => {
  it('reports hasTests=false for a project with no test files', () => {
    writeFileSync(join(cwd, 'index.ts'), '', 'utf-8')
    const ctx = scanProject(cwd)
    expect(ctx.testing.hasTests).toBe(false)
    expect(ctx.testing.testFileCount).toBe(0)
    expect(ctx.testing.framework).toBeNull()
    expect(ctx.testing.command).toBeNull()
  })

  it('counts *.test.ts files', () => {
    writeFileSync(join(cwd, 'foo.test.ts'), '', 'utf-8')
    writeFileSync(join(cwd, 'bar.spec.ts'), '', 'utf-8')
    const ctx = scanProject(cwd)
    expect(ctx.testing.hasTests).toBe(true)
    expect(ctx.testing.testFileCount).toBe(2)
  })

  it('counts files inside a tests/ directory regardless of filename', () => {
    mkdirSync(join(cwd, 'tests'))
    writeFileSync(join(cwd, 'tests', 'login.ts'), '', 'utf-8')
    writeFileSync(join(cwd, 'tests', 'signup.ts'), '', 'utf-8')
    const ctx = scanProject(cwd)
    expect(ctx.testing.testFileCount).toBe(2)
  })

  it('detects vitest from package.json deps', () => {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      name: 'x',
      devDependencies: { vitest: '^1.0.0' },
      scripts: { test: 'vitest run' },
    }), 'utf-8')
    writeFileSync(join(cwd, 'index.test.ts'), '', 'utf-8')
    const ctx = scanProject(cwd)
    expect(ctx.testing.framework).toBe('vitest')
    expect(ctx.testing.command).toBe('vitest run')
  })

  it('detects pytest from pyproject.toml', () => {
    writeFileSync(join(cwd, 'pyproject.toml'), '[project]\nname = "x"\n', 'utf-8')
    writeFileSync(join(cwd, 'test_foo.py'), '', 'utf-8')
    const ctx = scanProject(cwd)
    expect(ctx.testing.framework).toBe('pytest')
  })

  it('detects cargo-test from Cargo.toml', () => {
    writeFileSync(join(cwd, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\n', 'utf-8')
    mkdirSync(join(cwd, 'tests'))
    writeFileSync(join(cwd, 'tests', 'integration.rs'), '', 'utf-8')
    const ctx = scanProject(cwd)
    expect(ctx.testing.framework).toBe('cargo-test')
  })

  it('detects go-test from go.mod', () => {
    writeFileSync(join(cwd, 'go.mod'), 'module x\n', 'utf-8')
    writeFileSync(join(cwd, 'foo_test.go'), '', 'utf-8')
    const ctx = scanProject(cwd)
    expect(ctx.testing.framework).toBe('go-test')
  })

  it('skips node_modules and dist when counting test files', () => {
    mkdirSync(join(cwd, 'node_modules'))
    mkdirSync(join(cwd, 'node_modules', 'lib'))
    writeFileSync(join(cwd, 'node_modules', 'lib', 'fake.test.ts'), '', 'utf-8')
    mkdirSync(join(cwd, 'dist'))
    writeFileSync(join(cwd, 'dist', 'compiled.test.js'), '', 'utf-8')
    const ctx = scanProject(cwd)
    expect(ctx.testing.testFileCount).toBe(0)
  })

  it('survives a malformed package.json without crashing', () => {
    writeFileSync(join(cwd, 'package.json'), '{ not json', 'utf-8')
    expect(() => scanProject(cwd)).not.toThrow()
    const ctx = scanProject(cwd)
    expect(ctx.testing.command).toBeNull()
  })
})
