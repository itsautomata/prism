/**
 * Glob tool.
 * find files by pattern.
 * always concurrency-safe, always read-only.
 */

import { z } from 'zod'
import { execFileSync } from 'child_process'
import { buildTool, type ToolResult, type ToolContext } from './Tool.js'
import { resolve, isAbsolute } from 'path'

const inputSchema = z.object({
  pattern: z.string().describe('glob pattern to match files (e.g. "**/*.ts", "src/**/*.py")'),
  path: z.string().optional().describe('directory to search in (default: cwd)'),
})

type GlobInput = z.infer<typeof inputSchema>

export const GlobTool = buildTool<GlobInput>({
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns file paths sorted by modification time. Parameters: pattern (glob pattern like "*.py"), path (optional, directory to search).',

  inputSchema,

  async call(input: GlobInput, context: ToolContext): Promise<ToolResult> {
    const searchPath = input.path
      ? (isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path))
      : context.cwd

    try {
      const pattern = input.pattern.replace(/\*\*\//g, '')

      const excludeDirs = [
        'node_modules', '.git', '.venv', 'venv', '__pycache__',
        'dist', 'build', '.next', '.nuxt', 'target', 'coverage',
        '.mypy_cache', '.pytest_cache', '.egg-info',
      ]
      const excludeArgs: string[] = []
      for (const d of excludeDirs) {
        excludeArgs.push('-not', '-path', `*/${d}/*`)
      }

      // execFileSync (not execSync(string)): args never touch a shell, so
      // metacharacters in path/pattern can't trigger command substitution.
      const output = execFileSync(
        'find',
        [searchPath, '-type', 'f', '-name', pattern, ...excludeArgs],
        {
          cwd: searchPath,
          encoding: 'utf-8',
          timeout: 30_000,
          maxBuffer: 512 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'], // suppress stderr (replaces `2>/dev/null`)
        }
      ).trim()

      if (!output) {
        return { content: `no files matching "${input.pattern}" in ${searchPath}` }
      }

      // sort + truncate in JS (replaces shell `| head -250 | sort`)
      const allFiles = output.split('\n').filter(Boolean).sort()
      const files = allFiles.slice(0, 250)
      let result = files.join('\n')

      if (allFiles.length > 250) {
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
