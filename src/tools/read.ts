/**
 * Read tool.
 * reads any file. dispatches to the right parser by extension.
 * text files read directly. PDFs, docx, notebooks, images get parsed.
 */

import { z } from 'zod'
import { readFileSync, statSync } from 'fs'
import { buildTool, type ToolResult, type ToolContext } from './Tool.js'
import { classifyRead, readAskMessage } from './sensitivePaths.js'
import { resolve, isAbsolute, extname } from 'path'
import { parsePdf } from '../parsers/pdf.js'
import { parseDocx } from '../parsers/docx.js'
import { parseNotebook } from '../parsers/notebook.js'
import { parseImage, isImageFile } from '../parsers/image.js'

const inputSchema = z.object({
  file_path: z.string().describe('absolute path to the file to read'),
  offset: z.number().int().nonnegative().optional().describe('line number to start reading from (1-based, text files only)'),
  limit: z.number().int().positive().optional().describe('number of lines to read (text files only)'),
  pages: z.string().optional().describe('page range for PDF files (e.g. "1-5", "3")'),
})

type ReadInput = z.infer<typeof inputSchema>

const MAX_LINES = 2000

export const ReadTool = buildTool<ReadInput>({
  name: 'Read',
  description: 'Read a file from the filesystem. Supports text, PDF, Word (.docx), Jupyter notebooks (.ipynb), and images.',

  inputSchema,

  async call(input: ReadInput, context: ToolContext): Promise<ToolResult> {
    const filePath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(context.cwd, input.file_path)

    try {
      const stat = statSync(filePath)
      if (stat.isDirectory()) {
        return { content: `error: "${filePath}" is a directory, not a file. use Bash with ls to list directory contents.`, isError: true }
      }
    } catch {
      return { content: `error: file not found: ${filePath}`, isError: true }
    }

    const ext = extname(filePath).toLowerCase()

    try {
      // dispatch by file type
      switch (ext) {
        case '.pdf':
          return { content: parsePdf(filePath, input.pages) }

        case '.docx':
          return { content: await parseDocx(filePath) }

        case '.ipynb':
          return { content: parseNotebook(filePath) }

        default:
          if (isImageFile(filePath)) {
            const img = parseImage(filePath)
            return { content: img.description }
          }

          // text file — default behavior
          return readTextFile(filePath, input.offset, input.limit)
      }
    } catch (error) {
      return {
        content: `error reading file: ${(error as Error).message}`,
        isError: true,
      }
    }
  },

  isConcurrencySafe: () => true,
  isReadOnly: () => true,

  // reads inside the project auto-allow; reads outside it (home dotfiles,
  // ~/.ssh, /etc) and in-project secret files prompt, so an injected agent
  // can't silently pull credentials into context.
  checkPermissions: (input: ReadInput, context: ToolContext) => {
    const c = classifyRead(input.file_path, context.cwd)
    return c.allow
      ? { behavior: 'allow' as const }
      : { behavior: 'ask' as const, message: readAskMessage(input.file_path, c.reason) }
  },
})

function readTextFile(
  filePath: string,
  offset?: number,
  limit?: number,
): ToolResult {
  const content = readFileSync(filePath, 'utf-8')
  const allLines = content.split('\n')

  const start = (offset ?? 1) - 1
  const count = limit ?? MAX_LINES
  const lines = allLines.slice(start, start + count)

  const numbered = lines.map((line, i) => `${start + i + 1}\t${line}`).join('\n')

  let result = numbered
  if (allLines.length > start + count) {
    result += `\n\n(${allLines.length - start - count} more lines not shown. use offset/limit to read more.)`
  }

  return { content: result || '(empty file)' }
}
