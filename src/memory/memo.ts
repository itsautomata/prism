/**
 * persistent project memo.
 * what the model and user have learned about a specific repo, accumulated
 * across sessions. lives at ~/.prism/projects/<id>/memo.md.
 *
 * project id resolution:
 * - if the repo has a git remote, hash the remote url (stable across machines)
 * - else hash the absolute cwd (fallback for non-git or local-only repos)
 */

import { existsSync, readFileSync, mkdirSync, copyFileSync } from 'fs'
import { atomicWriteFileSync } from '../util/atomic.js'
import { join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { execSync } from 'child_process'

const PROJECTS_DIR = join(homedir(), '.prism', 'projects')

export interface MemoMeta {
  id: string
  path: string
  exists: boolean
}

/**
 * normalize a git remote url to a canonical `host/owner/repo` form so the same
 * repo resolves to one id regardless of how it's addressed: https vs ssh,
 * trailing slash, .git suffix, or an embedded userinfo. without this, cloning
 * the same repo over ssh on one machine and https on another splits its memo.
 */
export function normalizeRemote(url: string): string {
  let s = url.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '')
  // scp-like ssh: git@github.com:owner/repo
  const scp = s.match(/^[^@]+@([^:]+):(.+)$/)
  if (scp) return `${scp[1]}/${scp[2]}`
  // scheme://[user@]host/path
  const proto = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?(.+)$/)
  if (proto) return proto[1]
  return s
}

/**
 * resolve a stable project id for the current cwd.
 * prefers git remote url (normalized); falls back to cwd. first 12 hex of sha256.
 */
export function getProjectId(cwd: string): string {
  let key = cwd
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null', {
      cwd,
      encoding: 'utf-8',
      timeout: 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (remote) key = normalizeRemote(remote)
  } catch {
    // no git or no remote, fall through to cwd
  }
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

function memoDir(id: string): string {
  return join(PROJECTS_DIR, id)
}

function memoPath(id: string): string {
  return join(memoDir(id), 'memo.md')
}

function ensureDir(id: string): void {
  const dir = memoDir(id)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * load the memo file for a project. returns null if no memo exists yet.
 */
export function loadMemo(id: string): string | null {
  const path = memoPath(id)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * write the full memo content for a project.
 * caller is responsible for any backup before overwriting.
 */
export function saveMemo(id: string, content: string): void {
  ensureDir(id)
  atomicWriteFileSync(memoPath(id), content)
}

/**
 * append a single fact to the memo file under a `## notes` heading.
 * timestamps each entry with [YYYY-MM-DD] so staleness is visible to the
 * model in future sessions. creates the file (and heading) if it does not
 * exist yet.
 */
export function appendMemo(id: string, fact: string): void {
  ensureDir(id)
  const path = memoPath(id)
  const date = new Date().toISOString().slice(0, 10)
  const line = `- [${date}] ${fact.trim()}\n`

  if (!existsSync(path)) {
    const initial = `# memo\n\n## notes\n${line}`
    atomicWriteFileSync(path, initial)
    return
  }

  const current = readFileSync(path, 'utf-8')
  if (current.includes('## notes')) {
    // insert under the existing ## notes heading
    const updated = current.replace(/## notes\n/, `## notes\n${line}`)
    atomicWriteFileSync(path, updated)
  } else {
    // append a new ## notes section at the end
    const updated = current.endsWith('\n') ? current : current + '\n'
    atomicWriteFileSync(path, `${updated}\n## notes\n${line}`)
  }
}

/**
 * back up memo.md to memo.md.backup before destructive operations
 * (used by /compress). returns true if a backup was made.
 */
export function backupMemo(id: string): boolean {
  const path = memoPath(id)
  if (!existsSync(path)) return false
  copyFileSync(path, path + '.backup')
  return true
}

export function getMemoMeta(id: string): MemoMeta {
  const path = memoPath(id)
  return { id, path, exists: existsSync(path) }
}
