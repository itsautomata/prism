import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
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

describe('scanProject: structure scan bounds', () => {
  it('bounds the walk yet still samples every sibling directory', () => {
    // a/ alone exceeds the stat budget. a draining walk would spend the whole
    // budget there and never count b/, skewing language detection. round-robin
    // must reach b/ regardless.
    mkdirSync(join(cwd, 'a'))
    mkdirSync(join(cwd, 'b'))
    for (let i = 0; i < 4200; i++) writeFileSync(join(cwd, 'a', `m${i}.md`), '', 'utf-8')
    for (let i = 0; i < 50; i++) writeFileSync(join(cwd, 'b', `t${i}.ts`), '', 'utf-8')

    const ctx = scanProject(cwd)
    // bounded: not every file was stat-ed
    expect(ctx.structure.totalFiles).toBeLessThan(4250)
    // representative: the small sibling was sampled despite the fat one
    expect(ctx.structure.filesByType['.ts']).toBeGreaterThan(0)
    expect(ctx.structure.filesByType['.md']).toBeGreaterThan(0)
  })
})

describe('scanProject: symlinks', () => {
  it('skips a broken symlink without crashing', () => {
    writeFileSync(join(cwd, 'real.ts'), '', 'utf-8')
    symlinkSync(join(cwd, 'no-such-target'), join(cwd, 'dangling.ts'))
    expect(() => scanProject(cwd)).not.toThrow()
    expect(scanProject(cwd).structure.filesByType['.ts']).toBe(1)
  })

  it('counts a symlinked file by its target', () => {
    writeFileSync(join(cwd, 'real.ts'), '', 'utf-8')
    symlinkSync(join(cwd, 'real.ts'), join(cwd, 'alias.ts'))
    expect(scanProject(cwd).structure.filesByType['.ts']).toBe(2)
  })

  it('does not descend into a symlinked directory, so it cannot cycle or escape', () => {
    mkdirSync(join(cwd, 'pkg'))
    writeFileSync(join(cwd, 'pkg', 'mod.ts'), '', 'utf-8')
    // a symlink pointing back at the root: descending would re-walk and inflate
    symlinkSync(cwd, join(cwd, 'loop'))
    // only the real pkg/mod.ts is counted; 'loop' is listed but not walked
    expect(scanProject(cwd).structure.filesByType['.ts']).toBe(1)
  })
})
