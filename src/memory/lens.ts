/**
 * lens.md loader.
 * project-local instructions (rules the user enforces). git-committed,
 * ships with the repo. read once at session start.
 *
 * extracted from context/scanner.ts so memory has a clean home for
 * project-specific persistent inputs (lens + memo).
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const MAX_LENS_BYTES = 64 * 1024  // 64KB cap, sanity bound for stray huge files

export function loadLens(cwd: string): string | null {
  const path = join(cwd, 'lens.md')
  if (!existsSync(path)) return null
  try {
    const content = readFileSync(path, 'utf-8')
    if (content.length > MAX_LENS_BYTES) {
      return content.slice(0, MAX_LENS_BYTES) + '\n\n[truncated: lens.md exceeds 64KB cap]'
    }
    return content.trim() || null
  } catch {
    return null
  }
}
