/**
 * symbol cache.
 *
 * extracted symbols + imports per source file, persisted across sessions so a
 * warm start doesn't re-parse files that haven't changed. cache layout:
 *
 *   ~/.prism/cache/trees/<project-id>/<path-hash>.json
 *
 * - project-id matches `memory/memo.ts`'s scheme (git remote hash or cwd hash)
 * - path-hash is sha256(file-path) sliced to 16 hex; collisions are negligible
 *   and we verify the stored `path` field on read so a collision returns a miss
 * - cache hit requires the file's current mtime to match the cached mtime
 * - corrupt or missing entries return null; callers re-parse and overwrite
 *
 * one file per source file (not one giant index): isolated writes are atomic,
 * eviction is `rm`, partial corruption only loses one entry.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import type { Symbol } from './treesitter.js'

const ROOT = join(homedir(), '.prism', 'cache', 'trees')

export interface CachedSymbols {
  /** file path, exactly as the caller stored it (for collision verification). */
  path: string
  /** file mtime (ms since epoch) at cache time. */
  mtime: number
  /** file size in bytes at cache time. paired with mtime, this catches edits
   *  that preserve mtime (git checkout, touch -m, sub-tick saves). */
  size: number
  /** grammar that parsed the file. */
  language: string
  symbols: Symbol[]
  imports: string[]
  /** ISO timestamp of the cache write. */
  cachedAt: string
}

function cacheDir(projectId: string): string {
  return join(ROOT, projectId)
}

function hashPath(filePath: string): string {
  return createHash('sha256').update(filePath).digest('hex').slice(0, 16)
}

function entryFile(projectId: string, filePath: string): string {
  return join(cacheDir(projectId), `${hashPath(filePath)}.json`)
}

/**
 * read the cached symbols for a file. returns null on any of:
 *   - file doesn't exist in cache
 *   - cached mtime doesn't match the supplied mtime (file changed)
 *   - stored `path` doesn't match the supplied path (hash collision)
 *   - JSON parse fails (corruption)
 */
export function getCached(projectId: string, filePath: string, mtime: number, size: number): CachedSymbols | null {
  const path = entryFile(projectId, filePath)
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as CachedSymbols
    if (data.path !== filePath) return null  // hash collision
    if (data.mtime !== mtime) return null    // file changed (mtime)
    if (data.size !== size) return null      // file changed (size; catches mtime-preserving edits)
    return data
  } catch {
    return null
  }
}

/**
 * write the cache entry atomically (temp file + rename).
 * silently no-ops on write failure: cache misses are not user-visible errors.
 */
export function setCached(
  projectId: string,
  filePath: string,
  data: { mtime: number; size: number; language: string; symbols: Symbol[]; imports: string[] },
): void {
  const dir = cacheDir(projectId)
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }) } catch { return }
  }

  const entry: CachedSymbols = {
    path: filePath,
    mtime: data.mtime,
    size: data.size,
    language: data.language,
    symbols: data.symbols,
    imports: data.imports,
    cachedAt: new Date().toISOString(),
  }

  const final = entryFile(projectId, filePath)
  const tmp = `${final}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(entry), 'utf-8')
    renameSync(tmp, final)
  } catch {
    // cleanup the temp file if rename failed
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
  }
}

/**
 * delete all cached entries for a project. used when the project's structure
 * changed in a way the per-file mtime check can't detect (rare; e.g. a forced
 * reindex after a branch swap).
 */
export function invalidateProject(projectId: string): void {
  const dir = cacheDir(projectId)
  if (!existsSync(dir)) return
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

/**
 * quick-look cache statistics for a project (entry count + on-disk bytes).
 * used by `/cache` style introspection later; not on the hot path.
 */
export function cacheStats(projectId: string): { entries: number; bytes: number } {
  const dir = cacheDir(projectId)
  if (!existsSync(dir)) return { entries: 0, bytes: 0 }
  let entries = 0
  let bytes = 0
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const s = statSync(join(dir, name))
        entries += 1
        bytes += s.size
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return { entries, bytes }
}
