/**
 * Jupyter notebook parser.
 * extracts cells with their type, source, and outputs.
 * .ipynb is just JSON.
 */

import { readFileSync } from 'fs'

interface NotebookCell {
  cell_type: 'code' | 'markdown' | 'raw'
  source: string[]
  outputs?: {
    output_type: string
    text?: string[]
    data?: Record<string, string[]>
  }[]
}

interface Notebook {
  cells: NotebookCell[]
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
    const source = cell.source.join('')

    if (cell.cell_type === 'markdown') {
      parts.push(`[cell ${i + 1} markdown]\n${source}`)
    } else if (cell.cell_type === 'code') {
      parts.push(`[cell ${i + 1} code]\n${source}`)

      // include outputs
      if (cell.outputs) {
        for (const out of cell.outputs) {
          if (out.text) {
            parts.push(`[output]\n${out.text.join('')}`)
          }
          if (out.data) {
            for (const [mime, content] of Object.entries(out.data)) {
              if (mime.startsWith('text/')) {
                parts.push(`[output ${mime}]\n${content.join('')}`)
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
