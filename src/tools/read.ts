/**
 * Read tool.
 * read files. supports text, offset/limit for large files.
 * always concurrency-safe, always read-only.
 */

import { z } from 'zod'
import { readFileSync, statSync } from 'fs'
import { buildTool, type ToolResult, type ToolContext } from './Tool.js'
import { resolve, isAbsolute } from 'path'

const inputSchema = z.object({
  file_path: z.string().describe('absolute path to the file to read'),
  offset: z.number().int().nonnegative().optional().describe('line number to start reading from (1-based)'),
  limit: z.number().int().positive().optional().describe('number of lines to read'),
})

type ReadInput = z.infer<typeof inputSchema>

const MAX_LINES = 2000

export const ReadTool = buildTool<ReadInput>({
  name: 'Read',
  description: 'Read a file from the filesystem. Returns contents with line numbers. Parameters: file_path (absolute path), offset (optional, start line), limit (optional, number of lines).',

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

    try {
      const content = readFileSync(filePath, 'utf-8')
      const allLines = content.split('\n')

      const offset = (input.offset ?? 1) - 1 // convert to 0-based
      const limit = input.limit ?? MAX_LINES
      const lines = allLines.slice(offset, offset + limit)

      // format with line numbers
      const numbered = lines.map((line, i) => `${offset + i + 1}\t${line}`).join('\n')

      let result = numbered
      if (allLines.length > offset + limit) {
        result += `\n\n(${allLines.length - offset - limit} more lines not shown. use offset/limit to read more.)`
      }

      return { content: result || '(empty file)' }
    } catch (error) {
      return {
        content: `error reading file: ${(error as Error).message}`,
        isError: true,
      }
    }
  },

  isConcurrencySafe: () => true,
  isReadOnly: () => true,

  checkPermissions: () => ({ behavior: 'allow' }),
})
