import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// redirect homedir so cache writes land in a temp dir, not the operator's real ~/.prism.
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import { getCached, setCached, invalidateProject, cacheStats } from '../cache.js'
import type { Symbol } from '../treesitter.js'

const PROJECT_ID = 'test-project-12'

function exampleSymbols(): Symbol[] {
  return [
    { kind: 'function_declaration', name: 'greet', line: 5, signature: 'function greet(name) {' },
    { kind: 'class_declaration', name: 'Greeter', line: 12, signature: 'class Greeter {' },
  ]
}

beforeEach(() => {
  rmSync(join(TEST_HOME, '.prism'), { recursive: true, force: true })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('cache: round trip', () => {
  it('returns null before anything is written', () => {
    expect(getCached(PROJECT_ID, '/abs/src/foo.ts', 1234)).toBeNull()
  })

  it('writes and reads back a cached entry', () => {
    setCached(PROJECT_ID, '/abs/src/foo.ts', {
      mtime: 1234,
      language: 'typescript',
      symbols: exampleSymbols(),
      imports: ['./bar.js'],
    })

    const got = getCached(PROJECT_ID, '/abs/src/foo.ts', 1234)
    expect(got).not.toBeNull()
    expect(got!.path).toBe('/abs/src/foo.ts')
    expect(got!.language).toBe('typescript')
    expect(got!.symbols).toHaveLength(2)
    expect(got!.symbols[0]!.name).toBe('greet')
    expect(got!.imports).toEqual(['./bar.js'])
    expect(got!.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('returns null when mtime does not match (file changed)', () => {
    setCached(PROJECT_ID, '/abs/src/foo.ts', {
      mtime: 1000,
      language: 'typescript',
      symbols: exampleSymbols(),
      imports: [],
    })
    expect(getCached(PROJECT_ID, '/abs/src/foo.ts', 9999)).toBeNull()
  })

  it('overwrites previous entry on rewrite', () => {
    setCached(PROJECT_ID, '/abs/src/foo.ts', {
      mtime: 1, language: 'typescript', symbols: [], imports: [],
    })
    setCached(PROJECT_ID, '/abs/src/foo.ts', {
      mtime: 2, language: 'typescript', symbols: exampleSymbols(), imports: ['./bar.js'],
    })
    const got = getCached(PROJECT_ID, '/abs/src/foo.ts', 2)
    expect(got!.symbols).toHaveLength(2)
    expect(got!.imports).toEqual(['./bar.js'])
  })
})

describe('cache: corruption tolerance', () => {
  it('returns null on a corrupted entry instead of throwing', () => {
    // seed a valid entry
    setCached(PROJECT_ID, '/abs/src/foo.ts', {
      mtime: 1, language: 'typescript', symbols: [], imports: [],
    })

    // corrupt the on-disk file: find it and write garbage
    const { createHash } = require('crypto')
    const hash = createHash('sha256').update('/abs/src/foo.ts').digest('hex').slice(0, 16)
    const path = join(TEST_HOME, '.prism', 'cache', 'trees', PROJECT_ID, `${hash}.json`)
    expect(existsSync(path)).toBe(true)
    writeFileSync(path, '{ this is not json', 'utf-8')

    expect(getCached(PROJECT_ID, '/abs/src/foo.ts', 1)).toBeNull()
  })

  it('returns null when the stored path mismatches (hash collision guard)', () => {
    setCached(PROJECT_ID, '/abs/src/foo.ts', {
      mtime: 1, language: 'typescript', symbols: [], imports: [],
    })
    // ask for a different path that happens to share the same hash slot in theory
    // (in practice sha256-16 collisions are vanishingly rare, but the guard exists)
    // we can only test the negative path by reading the on-disk file and
    // rewriting it to point at a different `path` field
    const { createHash } = require('crypto')
    const hash = createHash('sha256').update('/abs/src/foo.ts').digest('hex').slice(0, 16)
    const path = join(TEST_HOME, '.prism', 'cache', 'trees', PROJECT_ID, `${hash}.json`)
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    data.path = '/some/other/file.ts'
    writeFileSync(path, JSON.stringify(data), 'utf-8')

    // looking up the original path should now see the collision-mismatch and return null
    expect(getCached(PROJECT_ID, '/abs/src/foo.ts', 1)).toBeNull()
  })
})

describe('cache: project-scoped operations', () => {
  it('invalidateProject removes every entry for that project', () => {
    setCached(PROJECT_ID, '/a/foo.ts', { mtime: 1, language: 'typescript', symbols: [], imports: [] })
    setCached(PROJECT_ID, '/a/bar.ts', { mtime: 1, language: 'typescript', symbols: [], imports: [] })
    setCached(PROJECT_ID, '/a/baz.ts', { mtime: 1, language: 'typescript', symbols: [], imports: [] })

    expect(cacheStats(PROJECT_ID).entries).toBe(3)

    invalidateProject(PROJECT_ID)
    expect(cacheStats(PROJECT_ID).entries).toBe(0)
    expect(getCached(PROJECT_ID, '/a/foo.ts', 1)).toBeNull()
  })

  it('two projects do not share cache state', () => {
    setCached('proj-a', '/x/file.ts', { mtime: 1, language: 'typescript', symbols: exampleSymbols(), imports: [] })
    setCached('proj-b', '/x/file.ts', { mtime: 1, language: 'typescript', symbols: [], imports: [] })

    expect(getCached('proj-a', '/x/file.ts', 1)!.symbols).toHaveLength(2)
    expect(getCached('proj-b', '/x/file.ts', 1)!.symbols).toHaveLength(0)

    invalidateProject('proj-a')
    expect(getCached('proj-a', '/x/file.ts', 1)).toBeNull()
    expect(getCached('proj-b', '/x/file.ts', 1)).not.toBeNull()  // unaffected
  })

  it('cacheStats reports zero on a fresh project', () => {
    expect(cacheStats('never-seen')).toEqual({ entries: 0, bytes: 0 })
  })

  it('cacheStats reports nonzero bytes after writes', () => {
    setCached(PROJECT_ID, '/x.ts', { mtime: 1, language: 'typescript', symbols: exampleSymbols(), imports: [] })
    const stats = cacheStats(PROJECT_ID)
    expect(stats.entries).toBe(1)
    expect(stats.bytes).toBeGreaterThan(0)
  })
})
