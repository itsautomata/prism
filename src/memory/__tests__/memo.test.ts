import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// redirect homedir() so the memo store doesn't touch the real ~/.prism
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-memo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import { getProjectId, loadMemo, saveMemo, appendMemo, backupMemo, getMemoMeta } from '../memo.js'

const PROJECTS_DIR = join(TEST_HOME, '.prism', 'projects')

beforeEach(() => {
  rmSync(`${TEST_HOME}/.prism`, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('getProjectId', () => {
  it('returns a 12-char hex id', () => {
    const id = getProjectId('/some/random/path')
    expect(id).toMatch(/^[0-9a-f]{12}$/)
  })

  it('is deterministic for the same cwd (when no git remote)', () => {
    // a path that's almost certainly not a git repo
    const cwd = `${TEST_HOME}/no-git-here`
    const id1 = getProjectId(cwd)
    const id2 = getProjectId(cwd)
    expect(id1).toBe(id2)
  })

  it('differs across cwds', () => {
    const a = getProjectId('/path/a')
    const b = getProjectId('/path/b')
    expect(a).not.toBe(b)
  })
})

describe('loadMemo', () => {
  it('returns null when no memo exists', () => {
    expect(loadMemo('nonexistent-id-aaa')).toBeNull()
  })

  it('returns the file content when memo exists', () => {
    saveMemo('test-id', '# memo\n\ncontent')
    expect(loadMemo('test-id')).toContain('content')
  })
})

describe('saveMemo', () => {
  it('writes the file at the expected path', () => {
    saveMemo('id-1', 'hello memo')
    expect(existsSync(join(PROJECTS_DIR, 'id-1', 'memo.md'))).toBe(true)
  })

  it('round-trips: save then load returns equivalent', () => {
    const content = '# memo\n\n## architecture\n- foo'
    saveMemo('id-2', content)
    expect(loadMemo('id-2')).toBe(content)
  })

  it('overwrites on second save', () => {
    saveMemo('id-3', 'first')
    saveMemo('id-3', 'second')
    expect(loadMemo('id-3')).toBe('second')
  })
})

describe('appendMemo', () => {
  it('creates the memo file with proper structure when none exists', () => {
    appendMemo('new-id', 'first fact')
    const content = loadMemo('new-id')
    expect(content).toContain('# memo')
    expect(content).toContain('## notes')
    expect(content).toContain('first fact')
  })

  it('prepends a timestamp like [YYYY-MM-DD]', () => {
    appendMemo('ts-id', 'a fact')
    const content = loadMemo('ts-id')!
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}\] a fact/)
  })

  it('inserts under existing ## notes heading', () => {
    appendMemo('multi-id', 'first')
    appendMemo('multi-id', 'second')
    const content = loadMemo('multi-id')!
    expect(content).toContain('first')
    expect(content).toContain('second')
    // both should appear under the same ## notes heading
    const notesCount = (content.match(/## notes/g) ?? []).length
    expect(notesCount).toBe(1)
  })

  it('appends a new ## notes section if file lacks one', () => {
    saveMemo('lone-id', '# memo\n\n## architecture\n- a fact about layout')
    appendMemo('lone-id', 'a learned fact')
    const content = loadMemo('lone-id')!
    expect(content).toContain('## architecture')
    expect(content).toContain('## notes')
    expect(content).toContain('a learned fact')
  })

  it('trims whitespace from the fact', () => {
    appendMemo('trim-id', '   spaced   ')
    const content = loadMemo('trim-id')!
    expect(content).toMatch(/\] spaced$/m)
  })
})

describe('backupMemo', () => {
  it('returns false when no memo exists', () => {
    expect(backupMemo('no-memo-here')).toBe(false)
  })

  it('creates a .backup copy when memo exists', () => {
    saveMemo('backup-id', 'original content')
    expect(backupMemo('backup-id')).toBe(true)
    const backupPath = join(PROJECTS_DIR, 'backup-id', 'memo.md.backup')
    expect(existsSync(backupPath)).toBe(true)
    expect(readFileSync(backupPath, 'utf-8')).toBe('original content')
  })

  it('overwrites previous backup on second call', () => {
    saveMemo('rebackup-id', 'v1')
    backupMemo('rebackup-id')
    saveMemo('rebackup-id', 'v2')
    backupMemo('rebackup-id')
    const backupPath = join(PROJECTS_DIR, 'rebackup-id', 'memo.md.backup')
    expect(readFileSync(backupPath, 'utf-8')).toBe('v2')
  })
})

describe('getMemoMeta', () => {
  it('returns exists=false when no memo', () => {
    const meta = getMemoMeta('absent-id')
    expect(meta.exists).toBe(false)
    expect(meta.id).toBe('absent-id')
    expect(meta.path).toContain('absent-id/memo.md')
  })

  it('returns exists=true after save', () => {
    saveMemo('present-id', 'x')
    expect(getMemoMeta('present-id').exists).toBe(true)
  })
})
