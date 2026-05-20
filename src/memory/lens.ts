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
import { loadConfig } from '../config/config.js'

export function loadLens(cwd: string): string | null {
  const path = join(cwd, 'lens.md')
  if (!existsSync(path)) return null
  try {
    const content = readFileSync(path, 'utf-8')
    const maxBytes = loadConfig().tuning.lens_max_bytes
    if (content.length > maxBytes) {
      return content.slice(0, maxBytes) + `\n\n[truncated: lens.md exceeds ${maxBytes} bytes]`
    }
    return content.trim() || null
  } catch {
    return null
  }
}
