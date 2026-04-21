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

function cwdSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(-50)
}

/**
 * create a new session.
 */
export function createSession(model: string, provider: string, cwd: string): Session {
  ensureDir()
  const now = new Date()
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const id = `${timestamp}_${cwdSlug(cwd)}`

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
