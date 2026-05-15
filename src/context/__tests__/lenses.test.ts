import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadLenses } from '../lenses.js'

let projectRoot: string
let prismDir: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'prism-lenses-'))
  prismDir = join(projectRoot, '.prism')
})

function writeLens(name: string, content: string): void {
  mkdirSync(prismDir, { recursive: true })
  writeFileSync(join(prismDir, `${name}.md`), content, 'utf-8')
}

describe('loadLenses', () => {
  it('returns empty array when .prism does not exist', () => {
    expect(loadLenses(projectRoot)).toEqual([])
  })

  it('returns empty array when .prism exists but has no md files', () => {
    mkdirSync(prismDir)
    writeFileSync(join(prismDir, 'notes.txt'), 'ignored', 'utf-8')
    expect(loadLenses(projectRoot)).toEqual([])
  })

  it('loads a single lens file', () => {
    writeLens('lens', 'this project uses event sourcing. all state changes go through domain events.')
    const lenses = loadLenses(projectRoot)
    expect(lenses).toHaveLength(1)
    expect(lenses[0]!.name).toBe('lens')
    expect(lenses[0]!.content).toContain('event sourcing')
  })

  it('loads multiple lens files', () => {
    writeLens('lens', 'main context')
    writeLens('conventions', 'naming conventions here')
    const lenses = loadLenses(projectRoot)
    expect(lenses).toHaveLength(2)
  })

  it('lens.md appears first regardless of alphabetical order', () => {
    writeLens('zzz', 'last alphabetically')
    writeLens('lens', 'primary lens')
    writeLens('aaa', 'first alphabetically')
    const names = loadLenses(projectRoot).map(l => l.name)
    expect(names[0]).toBe('lens')
  })

  it('remaining files after lens.md are alphabetical', () => {
    writeLens('lens', 'primary')
    writeLens('zzz', 'z context')
    writeLens('aaa', 'a context')
    const names = loadLenses(projectRoot).map(l => l.name)
    expect(names).toEqual(['lens', 'aaa', 'zzz'])
  })

  it('skips empty files', () => {
    writeLens('lens', 'has content')
    writeLens('empty', '')
    const lenses = loadLenses(projectRoot)
    expect(lenses).toHaveLength(1)
    expect(lenses[0]!.name).toBe('lens')
  })

  it('does not descend into subdirectories', () => {
    writeLens('lens', 'top level')
    const subdir = join(prismDir, 'agents')
    mkdirSync(subdir, { recursive: true })
    writeFileSync(join(subdir, 'researcher.md', ), 'agent def', 'utf-8')
    const lenses = loadLenses(projectRoot)
    expect(lenses).toHaveLength(1)
  })

  it('trims whitespace from content', () => {
    mkdirSync(prismDir, { recursive: true })
    writeFileSync(join(prismDir, 'lens.md'), '  \ncontext here\n  ', 'utf-8')
    const lenses = loadLenses(projectRoot)
    expect(lenses[0]!.content).toBe('context here')
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })
})
