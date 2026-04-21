/**
 * Glob tool.
 * find files by pattern.
 * always concurrency-safe, always read-only.
 */

import { z } from 'zod'
import { execSync } from 'child_process'
import { buildTool, type ToolResult, type ToolContext } from './Tool.js'
import { resolve, isAbsolute } from 'path'

const inputSchema = z.object({
  pattern: z.string().describe('glob pattern to match files (e.g. "**/*.ts", "src/**/*.py")'),
  path: z.string().optional().describe('directory to search in (default: cwd)'),
})

type GlobInput = z.infer<typeof inputSchema>

export const GlobTool = buildTool<GlobInput>({
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns file paths sorted by modification time.',

  inputSchema,

  async call(input: GlobInput, context: ToolContext): Promise<ToolResult> {
    const searchPath = input.path
      ? (isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path))
      : context.cwd

    try {
      // use find with glob-like behavior
      // convert glob pattern to find-compatible pattern
      const pattern = input.pattern

      const excludes = [
        'node_modules', '.git', '.venv', 'venv', '__pycache__',
        'dist', 'build', '.next', '.nuxt', 'target', 'coverage',
        '.mypy_cache', '.pytest_cache', '.egg-info',
      ].map(d => `-not -path "*/${d}/*"`).join(' ')

      const output = execSync(
        `find "${searchPath}" -type f -name "${pattern.replace(/\*\*\//g, '')}" ${excludes} 2>/dev/null | head -250 | sort`,
        {
          cwd: searchPath,
          encoding: 'utf-8',
          timeout: 30_000,
          maxBuffer: 512 * 1024,
        }
      ).trim()

      if (!output) {
        return { content: `no files matching "${input.pattern}" in ${searchPath}` }
      }

      const files = output.split('\n')
      let result = files.join('\n')

      if (files.length >= 250) {
        result += '\n\n(results truncated at 250 files)'
      }

      return { content: result }
    } catch (error) {
      return {
        content: `error: ${(error as Error).message}`,
        isError: true,
      }
    }
  },

  isConcurrencySafe: () => true,
  isReadOnly: () => true,

  checkPermissions: () => ({ behavior: 'allow' }),
})
