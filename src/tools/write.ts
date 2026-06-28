/**
 * Write tool.
 * create or overwrite files.
 * never concurrency-safe, never read-only.
 */

import { z } from 'zod'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { buildTool, type ToolResult, type ToolContext } from './Tool.js'
import { resolve, isAbsolute, dirname } from 'path'
import { classifyRead, writeAskMessage } from './sensitivePaths.js'

const inputSchema = z.object({
  file_path: z.string().describe('absolute path to the file to write'),
  content: z.string().describe('the content to write to the file'),
})

type WriteInput = z.infer<typeof inputSchema>

export const WriteTool = buildTool<WriteInput>({
  name: 'Write',
  description: 'Write content to a file. Creates the file if it does not exist. Overwrites if it does.',

  inputSchema,

  async call(input: WriteInput, context: ToolContext): Promise<ToolResult> {
    const filePath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(context.cwd, input.file_path)

    try {
      // ensure parent directory exists
      const dir = dirname(filePath)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }

      writeFileSync(filePath, input.content, 'utf-8')

      const lineCount = input.content.split('\n').length
      return { content: `wrote ${lineCount} lines to ${filePath}` }
    } catch (error) {
      return {
        content: `error writing file: ${(error as Error).message}`,
        isError: true,
      }
    }
  },

  // resolve symlinks before prompting so the approval names the real target:
  // a path inside the project can be a symlink to ~/.ssh or another secret.
  checkPermissions(input: WriteInput, context: ToolContext) {
    const c = classifyRead(input.file_path, context.cwd)
    if (c.reason === 'in-project') {
      return { behavior: 'ask' as const, message: `write to ${input.file_path}` }
    }
    return { behavior: 'ask' as const, message: writeAskMessage(c.resolved, c.reason) }
  },
})
