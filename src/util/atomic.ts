import { writeFileSync, renameSync, rmSync } from 'fs'

/**
 * write a file atomically: write a sibling temp file, then rename it over the
 * target. rename is atomic on the same filesystem, so a crash mid-write leaves
 * the previous file intact rather than a truncated one. the temp is removed if
 * the write or rename fails, and the error propagates to the caller.
 */
export function atomicWriteFileSync(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content, 'utf-8')
    renameSync(tmp, path)
  } catch (err) {
    try { rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw err
  }
}
