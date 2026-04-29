/**
 * persistent project memo.
 * what the model and user have learned about a specific repo, accumulated
 * across sessions. lives at ~/.prism/projects/<id>/memo.md.
 *
 * project id resolution:
 * - if the repo has a git remote, hash the remote url (stable across machines)
 * - else hash the absolute cwd (fallback for non-git or local-only repos)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'
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
 * resolve a stable project id for the current cwd.
 * prefers git remote url; falls back to cwd. first 12 hex chars of sha256.
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
    if (remote) key = remote
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
  writeFileSync(memoPath(id), content, 'utf-8')
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
    writeFileSync(path, initial, 'utf-8')
    return
  }

  const current = readFileSync(path, 'utf-8')
  if (current.includes('## notes')) {
    // insert under the existing ## notes heading
    const updated = current.replace(/## notes\n/, `## notes\n${line}`)
    writeFileSync(path, updated, 'utf-8')
  } else {
    // append a new ## notes section at the end
    const updated = current.endsWith('\n') ? current : current + '\n'
    writeFileSync(path, `${updated}\n## notes\n${line}`, 'utf-8')
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
