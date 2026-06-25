import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseNotebook } from '../notebook.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prism-nb-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function writeNb(cells: unknown[]): string {
  const p = join(dir, 'n.ipynb')
  writeFileSync(p, JSON.stringify({ cells }), 'utf-8')
  return p
}

describe('parseNotebook: source shape tolerance', () => {
  it('handles source as a single string (nbformat permits it)', () => {
    const p = writeNb([{ cell_type: 'code', source: 'print(1)' }])
    expect(parseNotebook(p)).toContain('print(1)')
  })

  it('handles source as a string array', () => {
    const p = writeNb([{ cell_type: 'code', source: ['print(', '1)'] }])
    expect(parseNotebook(p)).toContain('print(1)')
  })

  it('does not throw on missing or null source', () => {
    const p = writeNb([{ cell_type: 'code' }, { cell_type: 'markdown', source: null }])
    expect(() => parseNotebook(p)).not.toThrow()
  })

  it('handles string-typed output text and data', () => {
    const p = writeNb([{
      cell_type: 'code',
      source: 'x',
      outputs: [{ output_type: 'stream', text: 'hello' }, { output_type: 'execute_result', data: { 'text/plain': 'world' } }],
    }])
    const out = parseNotebook(p)
    expect(out).toContain('hello')
    expect(out).toContain('world')
  })
})
