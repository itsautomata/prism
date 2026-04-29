import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// redirect homedir() to a temp dir so the store doesn't touch the real ~/.prism
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import { createSession, saveSession, loadSession, findLastSession, listSessions } from '../store.js'
import type { Session } from '../types.js'

const SESSIONS_DIR = join(TEST_HOME, '.prism', 'sessions')

function pause(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

beforeEach(() => {
  rmSync(join(TEST_HOME, '.prism'), { recursive: true, force: true })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('createSession', () => {
  it('returns a Session with all fields populated', () => {
    const s = createSession('qwen3:14b', 'ollama', '/some/cwd')
    expect(s.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}$/)
    expect(s.model).toBe('qwen3:14b')
    expect(s.provider).toBe('ollama')
    expect(s.cwd).toBe('/some/cwd')
    expect(s.messages).toEqual([])
    expect(s.createdAt).toBe(s.updatedAt)
    expect(() => new Date(s.createdAt).toISOString()).not.toThrow()
  })

  it('produces unique ids across two calls (ms precision)', async () => {
    const a = createSession('m', 'p', '/x')
    await pause(5)
    const b = createSession('m', 'p', '/x')
    expect(a.id).not.toBe(b.id)
  })

  it('creates the sessions dir if it is missing', () => {
    expect(existsSync(SESSIONS_DIR)).toBe(false)
    createSession('m', 'p', '/x')
    expect(existsSync(SESSIONS_DIR)).toBe(true)
  })

  it('id sorts lexicographically the same as chronologically', async () => {
    const a = createSession('m', 'p', '/x')
    await pause(10)
    const b = createSession('m', 'p', '/x')
    await pause(10)
    const c = createSession('m', 'p', '/x')
    const sorted = [c.id, a.id, b.id].sort()
    expect(sorted).toEqual([a.id, b.id, c.id])
  })

  it('passes unicode in model and cwd through verbatim', () => {
    const s = createSession('qwen-中文', 'ollama', '/path/中/with spaces')
    expect(s.model).toBe('qwen-中文')
    expect(s.cwd).toBe('/path/中/with spaces')
  })
})

describe('saveSession', () => {
  it('writes a JSON file at the expected path', () => {
    const s = createSession('m', 'p', '/x')
    saveSession(s)
    expect(existsSync(join(SESSIONS_DIR, `${s.id}.json`))).toBe(true)
  })

  it('round-trip: saveSession then loadSession returns equivalent session', () => {
    const s = createSession('m', 'p', '/x')
    s.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    saveSession(s)
    const loaded = loadSession(s.id)
    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe(s.id)
    expect(loaded!.model).toBe(s.model)
    expect(loaded!.provider).toBe(s.provider)
    expect(loaded!.cwd).toBe(s.cwd)
    expect(loaded!.messages).toEqual(s.messages)
  })

  it('mutates session.updatedAt in place to current time', async () => {
    const s = createSession('m', 'p', '/x')
    const original = s.updatedAt
    await pause(10)
    saveSession(s)
    expect(s.updatedAt).not.toBe(original)
    expect(() => new Date(s.updatedAt).toISOString()).not.toThrow()
  })

  it('overwrites existing file when called twice with the same id', () => {
    const s = createSession('m', 'p', '/x')
    saveSession(s)
    s.model = 'changed'
    saveSession(s)
    const loaded = loadSession(s.id)
    expect(loaded!.model).toBe('changed')
  })

  it('creates the sessions dir if it is missing', () => {
    rmSync(join(TEST_HOME, '.prism'), { recursive: true, force: true })
    const s = createSession('m', 'p', '/x')
    rmSync(join(TEST_HOME, '.prism'), { recursive: true, force: true })
    saveSession(s)
    expect(existsSync(join(SESSIONS_DIR, `${s.id}.json`))).toBe(true)
  })
})

describe('loadSession', () => {
  it('loads a previously saved session', () => {
    const s = createSession('m', 'p', '/x')
    saveSession(s)
    expect(loadSession(s.id)).not.toBeNull()
  })

  it('returns null for a missing file', () => {
    expect(loadSession('does-not-exist')).toBeNull()
  })

  it('returns null for corrupt JSON', () => {
    mkdirSync(SESSIONS_DIR, { recursive: true })
    writeFileSync(join(SESSIONS_DIR, 'corrupt.json'), '{not valid json', 'utf-8')
    expect(loadSession('corrupt')).toBeNull()
  })

  it('returns the parsed object even if fields are missing (no validation)', () => {
    mkdirSync(SESSIONS_DIR, { recursive: true })
    writeFileSync(join(SESSIONS_DIR, 'partial.json'), '{}', 'utf-8')
    const result = loadSession('partial')
    expect(result).not.toBeNull()
  })

  it('loads sessions written with the legacy long id format', () => {
    mkdirSync(SESSIONS_DIR, { recursive: true })
    const legacyId = '2026-04-21T18-14-29__Users_automata_Desktop'
    const s = { id: legacyId, model: 'm', provider: 'p', cwd: '/x', createdAt: 'now', updatedAt: 'now', messages: [] }
    writeFileSync(join(SESSIONS_DIR, `${legacyId}.json`), JSON.stringify(s), 'utf-8')
    expect(loadSession(legacyId)).not.toBeNull()
  })
})

describe('findLastSession', () => {
  it('returns the most recent session matching the cwd', async () => {
    const a = createSession('m', 'p', '/cwd-a')
    a.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    saveSession(a)
    await pause(10)
    const b = createSession('m', 'p', '/cwd-b')
    b.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    saveSession(b)

    const found = findLastSession('/cwd-a')
    expect(found).not.toBeNull()
    expect(found!.cwd).toBe('/cwd-a')
  })

  it('returns null when no sessions exist at all', () => {
    expect(findLastSession('/anything')).toBeNull()
  })

  it('returns null when no session matches the cwd', () => {
    const s = createSession('m', 'p', '/other')
    s.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    saveSession(s)
    expect(findLastSession('/not-other')).toBeNull()
  })

  it('skips sessions with empty messages', async () => {
    const empty = createSession('m', 'p', '/cwd')
    saveSession(empty)
    await pause(10)
    const withMessages = createSession('m', 'p', '/cwd')
    withMessages.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    saveSession(withMessages)
    await pause(10)
    const newer_empty = createSession('m', 'p', '/cwd')
    saveSession(newer_empty)

    const found = findLastSession('/cwd')
    expect(found!.id).toBe(withMessages.id)
  })

  it('skips corrupt files and returns the next valid match', async () => {
    const valid = createSession('m', 'p', '/cwd')
    valid.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    saveSession(valid)
    await pause(10)
    // newer file, but corrupt
    mkdirSync(SESSIONS_DIR, { recursive: true })
    writeFileSync(join(SESSIONS_DIR, '9999-99-99T99-99-99-999.json'), '{garbage', 'utf-8')

    const found = findLastSession('/cwd')
    expect(found!.id).toBe(valid.id)
  })

  it('returns the newest among multiple matches in the same cwd', async () => {
    const s1 = createSession('m', 'p', '/cwd')
    s1.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    saveSession(s1)
    await pause(10)
    const s2 = createSession('m', 'p', '/cwd')
    s2.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    saveSession(s2)

    const found = findLastSession('/cwd')
    expect(found!.id).toBe(s2.id)
  })

  it('ignores non-.json files in the dir', async () => {
    const s = createSession('m', 'p', '/cwd')
    s.messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    saveSession(s)
    writeFileSync(join(SESSIONS_DIR, 'notes.txt'), 'whatever', 'utf-8')

    const found = findLastSession('/cwd')
    expect(found!.id).toBe(s.id)
  })

  // regression: a non-iso filename like `test-session.json` sorts after any
  // timestamp filename (lex: 't' > '2'), which used to make it win over fresher
  // sessions in the same cwd. sort-by-updatedAt should fix this.
  it('does not let a non-iso filename outrank a newer iso-id session', async () => {
    mkdirSync(SESSIONS_DIR, { recursive: true })
    const stale: Session = {
      id: 'test-session',
      model: 'test-model',
      provider: 'p',
      cwd: '/cwd',
      createdAt: '2026-04-26T10:14:42.424Z',
      updatedAt: '2026-04-26T10:14:42.424Z',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'old' }] }],
    }
    writeFileSync(join(SESSIONS_DIR, 'test-session.json'), JSON.stringify(stale))

    await pause(10)

    const fresh = createSession('m', 'p', '/cwd')
    fresh.messages = [{ role: 'user', content: [{ type: 'text', text: 'new' }] }]
    saveSession(fresh)

    const found = findLastSession('/cwd')
    expect(found!.id).toBe(fresh.id)
    expect(listSessions()[0].id).toBe(fresh.id)
  })
})

describe('listSessions', () => {
  it('returns empty array when dir is empty', () => {
    expect(listSessions()).toEqual([])
  })

  it('returns sessions sorted most-recent-first', async () => {
    const a = createSession('m', 'p', '/x')
    saveSession(a)
    await pause(10)
    const b = createSession('m', 'p', '/x')
    saveSession(b)
    await pause(10)
    const c = createSession('m', 'p', '/x')
    saveSession(c)

    const list = listSessions()
    expect(list.map(s => s.id)).toEqual([c.id, b.id, a.id])
  })

  it('respects the limit argument', async () => {
    for (let i = 0; i < 5; i++) {
      const s = createSession('m', 'p', '/x')
      saveSession(s)
      await pause(2)
    }
    expect(listSessions(2).length).toBe(2)
  })

  it('default limit is 10', async () => {
    for (let i = 0; i < 12; i++) {
      const s = createSession('m', 'p', '/x')
      saveSession(s)
      await pause(2)
    }
    expect(listSessions().length).toBe(10)
  })

  it('skips corrupt files silently', async () => {
    const s = createSession('m', 'p', '/x')
    saveSession(s)
    mkdirSync(SESSIONS_DIR, { recursive: true })
    writeFileSync(join(SESSIONS_DIR, '0000-corrupt.json'), '{bad', 'utf-8')

    const list = listSessions()
    expect(list.length).toBe(1)
    expect(list[0]!.id).toBe(s.id)
  })

  it('ignores non-.json files', async () => {
    const s = createSession('m', 'p', '/x')
    saveSession(s)
    writeFileSync(join(SESSIONS_DIR, 'notes.txt'), 'whatever', 'utf-8')

    expect(listSessions().length).toBe(1)
  })
})
