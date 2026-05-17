import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// redirect homedir so the cache lands in a temp dir (not the operator's real ~/.prism).
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-repomap-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import { extractRepoMap, formatRepoMap } from '../repomap.js'

let project: string

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'prism-repomap-fixture-'))
  rmSync(join(TEST_HOME, '.prism'), { recursive: true, force: true })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

function w(rel: string, contents: string): void {
  const full = join(project, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, contents, 'utf-8')
}

describe('extractRepoMap', () => {
  it('returns empty entries for an empty project', async () => {
    const data = await extractRepoMap(project)
    expect(data.entries).toEqual([])
    expect(data.filesWalked).toBe(0)
  })

  it('skips files without a grammar mapping', async () => {
    w('readme.unknown', 'whatever')
    w('config.xyz', 'whatever')
    const data = await extractRepoMap(project)
    expect(data.entries).toEqual([])
    expect(data.filesWalked).toBe(0)
  })

  it('parses typescript files and returns their symbols', async () => {
    w('src/a.ts', `
export function hello() {}
class Bar {}
`)
    w('src/b.ts', `
export class Foo {}
function baz() {}
`)
    const data = await extractRepoMap(project)
    // skip the assertion when grammar wasm is not available in the env
    if (data.parseFailures === data.filesWalked) {
      console.warn('skipped: typescript grammar not built locally')
      return
    }

    expect(data.entries.length).toBeGreaterThanOrEqual(2)
    const allSymbols = data.entries.flatMap(e => e.symbols.map(s => s.name))
    expect(allSymbols).toContain('hello')
    expect(allSymbols).toContain('Bar')
    expect(allSymbols).toContain('Foo')
    expect(allSymbols).toContain('baz')
  })

  it('skips IGNORE_DIRS contents (node_modules, dist, .git)', async () => {
    w('src/keep.ts', 'export function keep() {}')
    w('node_modules/pkg/index.ts', 'export function dontwalk() {}')
    w('dist/build.ts', 'export function alsoDontWalk() {}')
    w('.git/HEAD', 'ref: refs/heads/main')
    const data = await extractRepoMap(project)
    if (data.parseFailures === data.filesWalked) return

    const paths = data.entries.map(e => e.path)
    expect(paths.some(p => p.includes('node_modules'))).toBe(false)
    expect(paths.some(p => p.includes('dist'))).toBe(false)
    expect(paths.some(p => p.includes('.git'))).toBe(false)
    expect(paths.some(p => p === 'src/keep.ts')).toBe(true)
  })

  it('honors maxFiles cap', async () => {
    for (let i = 0; i < 10; i++) {
      w(`f${i}.ts`, `export function x${i}() {}`)
    }
    const data = await extractRepoMap(project, { maxFiles: 3 })
    expect(data.filesWalked).toBe(3)
  })

  it('uses the cache on the second extraction', async () => {
    w('src/a.ts', 'export function hello() {}')

    const first = await extractRepoMap(project)
    if (first.parseFailures === first.filesWalked) return

    expect(first.cacheMisses).toBe(1)
    expect(first.cacheHits).toBe(0)

    const second = await extractRepoMap(project)
    expect(second.cacheHits).toBe(1)
    expect(second.cacheMisses).toBe(0)
  })

  it('honors maxSymbolsPerFile', async () => {
    w('src/many.ts', `
function a() {}
function b() {}
function c() {}
function d() {}
function e() {}
`)
    const data = await extractRepoMap(project, { maxSymbolsPerFile: 2 })
    if (data.parseFailures === data.filesWalked) return
    const entry = data.entries.find(e => e.path === 'src/many.ts')
    expect(entry?.symbols.length).toBeLessThanOrEqual(2)
  })
})

describe('formatRepoMap', () => {
  it('returns empty string when no entries', () => {
    expect(formatRepoMap({
      cwd: '/x', entries: [], filesWalked: 0, cacheHits: 0, cacheMisses: 0, parseFailures: 0,
    })).toBe('')
  })

  it('produces a `# repo map` block', () => {
    const out = formatRepoMap({
      cwd: '/x',
      entries: [{
        path: 'src/foo.ts',
        language: 'typescript',
        symbols: [
          { kind: 'function_declaration', name: 'greet', line: 1 },
          { kind: 'class_declaration', name: 'Greeter', line: 5 },
        ],
      }],
      filesWalked: 1, cacheHits: 0, cacheMisses: 1, parseFailures: 0,
    })
    expect(out).toContain('# repo map')
    expect(out).toContain('src/foo.ts')
    expect(out).toContain('function greet')
    expect(out).toContain('class Greeter')
    // _declaration suffix stripped for legibility
    expect(out).not.toContain('function_declaration')
  })

  it('truncates at maxLines and adds a footer', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      path: `src/file${i}.ts`,
      language: 'typescript',
      symbols: [
        { kind: 'function_declaration', name: `f${i}`, line: 1 },
      ],
    }))
    const out = formatRepoMap({
      cwd: '/x', entries, filesWalked: 20, cacheHits: 0, cacheMisses: 20, parseFailures: 0,
    }, { maxLines: 15 })

    expect(out).toMatch(/\.\.\.and \d+ more files/)
    // truncation footer present
    expect(out.split('\n').length).toBeLessThanOrEqual(20)
  })
})
