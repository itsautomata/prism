/**
 * PDF parser.
 * uses pdftotext (poppler) for reliable text extraction.
 * falls back to error message if pdftotext is not installed.
 */

import { execFileSync } from 'child_process'

export function parsePdf(filePath: string, pages?: string): string {
  // build pdftotext args. filePath is passed as a single argv entry, never
  // interpolated into a shell string, so shell metacharacters in the filename
  // (e.g. `$(...)`, backticks) are inert.
  const args = ['-layout']

  if (pages) {
    const { first, last } = parsePageRange(pages)
    args.push('-f', String(first), '-l', String(last))
  }

  args.push(filePath, '-')

  try {
    const output = execFileSync('pdftotext', args, {
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    })

    return output.trim() || '(no text content in PDF)'
  } catch (error) {
    const msg = (error as Error).message
    if (msg.includes('not found') || msg.includes('No such file')) {
      return 'error: pdftotext is not installed. install with: brew install poppler'
    }
    return `error reading PDF: ${msg}`
  }
}

function parsePageRange(range: string): { first: number; last: number } {
  if (range.includes('-')) {
    const [f, l] = range.split('-').map(Number)
    return { first: f || 1, last: l || 9999 }
  }
  const page = Number(range)
  return { first: page, last: page }
}
