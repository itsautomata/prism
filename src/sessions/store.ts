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
 * find the most recent session for a given cwd.
 */
export function findLastSession(cwd: string): Session | null {
  ensureDir()

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()

  for (const file of files) {
    try {
      const session: Session = JSON.parse(
        readFileSync(join(SESSIONS_DIR, file), 'utf-8')
      )
      if (session.cwd === cwd && session.messages.length > 0) {
        return session
      }
    } catch {
      continue
    }
  }

  return null
}

/**
 * list all sessions, most recent first.
 */
export function listSessions(limit = 10): Session[] {
  ensureDir()

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit)

  const sessions: Session[] = []

  for (const file of files) {
    try {
      const session: Session = JSON.parse(
        readFileSync(join(SESSIONS_DIR, file), 'utf-8')
      )
      sessions.push(session)
    } catch {
      continue
    }
  }

  return sessions
}
