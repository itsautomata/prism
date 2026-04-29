/**
 * session store.
 * save, load, list sessions.
 * one JSON file per session in ~/.prism/sessions/
 * auto-saves after every turn.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
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
 * id is the iso timestamp with ms (sortable, ~23 chars, collision-proof at 1ms).
 * cwd is stored as a field, no longer encoded in the id.
 */
export function createSession(model: string, provider: string, cwd: string): Session {
  ensureDir()
  const now = new Date()
  // 2026-04-21T18:14:29.123Z -> 2026-04-21T18-14-29-123
  const id = now.toISOString().replace(/[:.]/g, '-').slice(0, 23)

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
  writeFileSync(path, JSON.stringify(session, null, 2), 'utf-8')
}

/**
 * load a session by ID.
 */
export function loadSession(id: string): Session | null {
  const path = sessionPath(id)
  if (!existsSync(path)) return null

  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
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
      sessions.push(JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8')))
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
