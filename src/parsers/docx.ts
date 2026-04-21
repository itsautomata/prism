/**
 * Word document parser.
 * extracts text from .docx files using mammoth.
 */

import { readFileSync } from 'fs'

export async function parseDocx(filePath: string): Promise<string> {
  const mammoth = await import('mammoth')
  const buffer = readFileSync(filePath)
  const result = await mammoth.extractRawText({ buffer })
  return result.value.trim() || '(no text content in document)'
}
