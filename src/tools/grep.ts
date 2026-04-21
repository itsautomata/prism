/**
 * Grep tool.
 * search file contents using ripgrep or grep.
 * always concurrency-safe, always read-only.
 */

import { z } from 'zod'
import { execSync } from 'child_process'
import { buildTool, type ToolResult, type ToolContext } from './Tool.js'
import { resolve, isAbsolute } from 'path'

const inputSchema = z.object({
  pattern: z.string().describe('regex pattern to search for'),
  path: z.string().optional().describe('file or directory to search in (default: cwd)'),
  glob: z.string().optional().describe('file pattern filter (e.g. "*.ts", "*.py")'),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional()
    .describe('output mode: content (matching lines), files_with_matches (file paths only), count (match counts). default: files_with_matches'),
  context: z.number().optional().describe('lines of context around each match'),
})

type GrepInput = z.infer<typeof inputSchema>

// detect if ripgrep is available
let useRipgrep: boolean | null = null

function hasRipgrep(): boolean {
  if (useRipgrep !== null) return useRipgrep
  try {
    execSync('which rg', { stdio: 'pipe' })
    useRipgrep = true
  } catch {
    useRipgrep = false
  }
  return useRipgrep
}

export const GrepTool = buildTool<GrepInput>({
  name: 'Grep',
  description: 'Search file contents for a regex pattern. Uses ripgrep if available. Parameters: pattern (regex), path (optional, directory), glob (optional, file filter like "*.py"), output_mode (optional: files_with_matches, content, count).',

  inputSchema,

  async call(input: GrepInput, context: ToolContext): Promise<ToolResult> {
    const searchPath = input.path
      ? (isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path))
      : context.cwd

    const mode = input.output_mode ?? 'files_with_matches'

    try {
      let cmd: string

      if (hasRipgrep()) {
        cmd = buildRgCommand(input.pattern, searchPath, mode, input.glob, input.context)
      } else {
        cmd = buildGrepCommand(input.pattern, searchPath, mode, input.glob, input.context)
      }

      const output = execSync(cmd, {
        cwd: context.cwd,
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 512 * 1024,
      }).trim()

      if (!output) {
        return { content: `no matches for "${input.pattern}"` }
      }

      // limit output
      const lines = output.split('\n')
      if (lines.length > 250) {
        return { content: lines.slice(0, 250).join('\n') + `\n\n(${lines.length - 250} more lines truncated)` }
      }

      return { content: output }
    } catch (error) {
      const execError = error as { status?: number; stdout?: string }
      // grep returns exit code 1 for no matches
      if (execError.status === 1) {
        return { content: `no matches for "${input.pattern}"` }
      }
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

function buildRgCommand(
  pattern: string,
  path: string,
  mode: string,
  glob?: string,
  ctx?: number,
): string {
  const parts = ['rg']

  switch (mode) {
    case 'files_with_matches': parts.push('-l'); break
    case 'count': parts.push('-c'); break
    case 'content': parts.push('-n'); break
  }

  if (glob) parts.push(`--glob "${glob}"`)
  if (ctx && mode === 'content') parts.push(`-C ${ctx}`)

  parts.push(`"${pattern.replace(/"/g, '\\"')}"`)
  parts.push(`"${path}"`)
  parts.push('2>/dev/null')
  parts.push('| head -250')

  return parts.join(' ')
}

function buildGrepCommand(
  pattern: string,
  path: string,
  mode: string,
  glob?: string,
  ctx?: number,
): string {
  const parts = ['grep', '-r', '-E']

  switch (mode) {
    case 'files_with_matches': parts.push('-l'); break
    case 'count': parts.push('-c'); break
    case 'content': parts.push('-n'); break
  }

  if (glob) parts.push(`--include="${glob}"`)
  if (ctx && mode === 'content') parts.push(`-C ${ctx}`)

  parts.push(`"${pattern.replace(/"/g, '\\"')}"`)
  parts.push(`"${path}"`)
  parts.push('2>/dev/null')
  parts.push('| head -250')

  return parts.join(' ')
}
