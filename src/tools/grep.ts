/**
 * Grep tool.
 * search file contents using ripgrep or grep.
 * always concurrency-safe, always read-only.
 */

import { z } from 'zod'
import { execFileSync } from 'child_process'
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
    execFileSync('which', ['rg'], { stdio: 'pipe' })
    useRipgrep = true
  } catch {
    useRipgrep = false
  }
  return useRipgrep
}

export const GrepTool = buildTool<GrepInput>({
  name: 'Grep',
  description: 'Search file contents for a regex pattern. Uses ripgrep if available.',

  inputSchema,

  async call(input: GrepInput, context: ToolContext): Promise<ToolResult> {
    const searchPath = input.path
      ? (isAbsolute(input.path) ? input.path : resolve(context.cwd, input.path))
      : context.cwd

    const mode = input.output_mode ?? 'files_with_matches'

    try {
      const useRg = hasRipgrep()
      const bin = useRg ? 'rg' : 'grep'
      const args = useRg
        ? buildRgArgs(input.pattern, searchPath, mode, input.glob, input.context)
        : buildGrepArgs(input.pattern, searchPath, mode, input.glob, input.context)

      // execFileSync (not execSync(string)): args never touch a shell, so
      // metacharacters in pattern/path/glob can't trigger command substitution.
      const output = execFileSync(bin, args, {
        cwd: context.cwd,
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 512 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'], // suppress stderr (replaces `2>/dev/null`)
      }).trim()

      if (!output) {
        return { content: `no matches for "${input.pattern}"` }
      }

      // truncation done in JS (replaces shell `| head -250`)
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

function buildRgArgs(
  pattern: string,
  path: string,
  mode: string,
  glob?: string,
  ctx?: number,
): string[] {
  const args: string[] = []

  switch (mode) {
    case 'files_with_matches': args.push('-l'); break
    case 'count': args.push('-c'); break
    case 'content': args.push('-n'); break
  }

  if (glob) args.push('--glob', glob)
  if (ctx && mode === 'content') args.push('-C', String(ctx))

  args.push(pattern)
  args.push(path)

  return args
}

function buildGrepArgs(
  pattern: string,
  path: string,
  mode: string,
  glob?: string,
  ctx?: number,
): string[] {
  const args: string[] = ['-r', '-E']

  switch (mode) {
    case 'files_with_matches': args.push('-l'); break
    case 'count': args.push('-c'); break
    case 'content': args.push('-n'); break
  }

  if (glob) args.push(`--include=${glob}`)
  if (ctx && mode === 'content') args.push('-C', String(ctx))

  args.push(pattern)
  args.push(path)

  return args
}
