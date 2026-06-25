/**
 * Jupyter notebook parser.
 * extracts cells with their type, source, and outputs.
 * .ipynb is just JSON.
 */

import { readFileSync } from 'fs'

interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw'
  // nbformat permits source as a string[] OR a single string; tools emit both.
  source: string[] | string
  outputs?: {
    output_type: string
    text?: string[] | string
    data?: Record<string, string[] | string>
  }[]
}

interface Notebook {
  cells: NotebookCell[]
}

/** nbformat source/text may be a string[] or a single string (or absent). */
function joinSource(s: string[] | string | undefined | null): string {
  if (Array.isArray(s)) return s.join('')
  if (typeof s === 'string') return s
  return ''
}

export function parseNotebook(filePath: string): string {
  const raw = readFileSync(filePath, 'utf-8')
  const notebook: Notebook = JSON.parse(raw)

  if (!notebook.cells || notebook.cells.length === 0) {
    return '(empty notebook)'
  }

  const parts: string[] = []

  for (let i = 0; i < notebook.cells.length; i++) {
    const cell = notebook.cells[i]!
    const source = joinSource(cell.source)

    if (cell.cell_type === 'markdown') {
      parts.push(`[cell ${i + 1} markdown]\n${source}`)
    } else if (cell.cell_type === 'code') {
      parts.push(`[cell ${i + 1} code]\n${source}`)

      // include outputs
      if (cell.outputs) {
        for (const out of cell.outputs) {
          if (out.text) {
            parts.push(`[output]\n${joinSource(out.text)}`)
          }
          if (out.data) {
            for (const [mime, content] of Object.entries(out.data)) {
              if (mime.startsWith('text/')) {
                parts.push(`[output ${mime}]\n${joinSource(content)}`)
              } else {
                parts.push(`[output ${mime}] (binary content)`)
              }
            }
          }
        }
      }
    } else {
      parts.push(`[cell ${i + 1} ${cell.cell_type}]\n${source}`)
    }
  }

  return parts.join('\n\n')
}
