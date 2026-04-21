/**
 * Edit tool.
 * exact string replacement in files.
 * never concurrency-safe, never read-only.
 */

import { z } from 'zod'
import { readFileSync, writeFileSync } from 'fs'
import { buildTool, type ToolResult, type ToolContext } from './Tool.js'
import { resolve, isAbsolute } from 'path'

const inputSchema = z.object({
  file_path: z.string().describe('absolute path to the file to edit'),
  old_string: z.string().describe('the exact text to find and replace'),
  new_string: z.string().describe('the text to replace it with'),
  replace_all: z.boolean().optional().describe('replace all occurrences (default: false)'),
})

type EditInput = z.infer<typeof inputSchema>

export const EditTool = buildTool<EditInput>({
  name: 'Edit',
  description: 'Replace exact string matches in a file. Parameters: file_path (absolute path), old_string (exact text to find), new_string (replacement text). old_string must match exactly including whitespace.',

  inputSchema,

  async call(input: EditInput, context: ToolContext): Promise<ToolResult> {
    const filePath = isAbsolute(input.file_path)
      ? input.file_path
      : resolve(context.cwd, input.file_path)

    let content: string
    try {
      content = readFileSync(filePath, 'utf-8')
    } catch {
      return { content: `error: file not found: ${filePath}`, isError: true }
    }

    if (input.old_string === input.new_string) {
      return { content: 'error: old_string and new_string are identical', isError: true }
    }

    if (!content.includes(input.old_string)) {
      return {
        content: `error: old_string not found in ${filePath}. make sure it matches exactly, including whitespace.`,
        isError: true,
      }
    }

    // check uniqueness (unless replace_all)
    if (!input.replace_all) {
      const count = content.split(input.old_string).length - 1
      if (count > 1) {
        return {
          content: `error: old_string found ${count} times. use replace_all: true to replace all, or provide more context to make it unique.`,
          isError: true,
        }
      }
    }

    const updated = input.replace_all
      ? content.split(input.old_string).join(input.new_string)
      : content.replace(input.old_string, input.new_string)

    try {
      writeFileSync(filePath, updated, 'utf-8')
      const replacements = input.replace_all
        ? content.split(input.old_string).length - 1
        : 1
      return { content: `edited ${filePath} (${replacements} replacement${replacements > 1 ? 's' : ''})` }
    } catch (error) {
      return {
        content: `error writing file: ${(error as Error).message}`,
        isError: true,
      }
    }
  },

  checkPermissions(input: EditInput) {
    return { behavior: 'ask' as const, message: `edit ${input.file_path}` }
  },
})
