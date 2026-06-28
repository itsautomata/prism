/**
 * session store.
 * save, load, list sessions.
 * one JSON file per session in ~/.prism/sessions/
 * auto-saves after every turn.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { atomicWriteFileSync } from '../util/atomic.js'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import type { Message } from '../types/index.js'
import type { Session } from './types.js'

const SESSIONS_DIR = join(homedir(), '.prism', 'sessions')

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true })
  }
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`)
}

/**
 * create a new session.
 * id is the iso timestamp with ms plus a short random suffix, so it stays
 * sortable but two sessions created in the same millisecond (two processes,
 * a scripted launch) can't collide and overwrite each other on save.
 * cwd is stored as a field, no longer encoded in the id.
 */
export function createSession(model: string, provider: string, cwd: string): Session {
  ensureDir()
  const now = new Date()
  // 2026-04-21T18:14:29.123Z -> 2026-04-21T18-14-29-123-<6 hex>
  const id = now.toISOString().replace(/[:.]/g, '-').slice(0, 23) + '-' + randomBytes(3).toString('hex')

  return {
    id,
    model,
    provider,
    cwd,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    messages: [],
  }
}

/**
 * save session to disk. call after every turn.
 */
export function saveSession(session: Session): void {
  ensureDir()
  session.updatedAt = new Date().toISOString()
  const path = sessionPath(session.id)
  atomicWriteFileSync(path, JSON.stringify(session, null, 2))
}

/**
 * a parsed session must carry the fields the app reads, or it is treated as
 * corrupt (a partial write, a hand edit, a legacy file). callers then take the
 * clean "no session" path instead of crashing later on session.messages.filter.
 */
function isValidSession(data: unknown): data is Session {
  if (!data || typeof data !== 'object') return false
  const s = data as Record<string, unknown>
  return typeof s.id === 'string'
    && typeof s.model === 'string'
    && typeof s.provider === 'string'
    && typeof s.cwd === 'string'
    && Array.isArray(s.messages)
}

/**
 * load a session by ID.
 */
export function loadSession(id: string): Session | null {
  const path = sessionPath(id)
  if (!existsSync(path)) return null

  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    return isValidSession(data) ? data : null
  } catch {
    return null
  }
}

/**
 * load every valid session from disk, sorted by updatedAt descending.
 * sorting by `updatedAt` (not filename) tolerates non-iso ids — orphaned
 * test fixtures or hand-named sessions don't get to jump the queue just
 * because their filename sorts after a digit.
 */
function loadAllSorted(): Session[] {
  ensureDir()

  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'))
  const sessions: Session[] = []

  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'))
      if (isValidSession(data)) sessions.push(data)
    } catch {
      continue
    }
  }

  // missing / malformed updatedAt sorts to the bottom (treated as epoch 0)
  return sessions.sort((a, b) => {
    const ta = Date.parse(a.updatedAt) || 0
    const tb = Date.parse(b.updatedAt) || 0
    return tb - ta
  })
}

/**
 * find the most recent session for a given cwd.
 */
export function findLastSession(cwd: string): Session | null {
  for (const session of loadAllSorted()) {
    if (session.cwd === cwd && session.messages.length > 0) return session
  }
  return null
}

/**
 * list all sessions, most recent first.
 */
export function listSessions(limit = 10): Session[] {
  return loadAllSorted().slice(0, limit)
}
