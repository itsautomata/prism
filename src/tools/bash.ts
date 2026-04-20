/**
 * Bash tool.
 * execute shell commands. the most impactful tool.
 * each command is evaluated for safety independently.
 */

import { z } from 'zod'
import { execSync, execFileSync } from 'child_process'
import { buildTool, type ToolResult, type ToolContext, type PermissionResult } from './Tool.js'

const MAX_OUTPUT = 512 * 1024 // 512KB

// commands that are safe to run concurrently (read-only)
const SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'rg',
  'which', 'whereis', 'file', 'stat', 'du', 'df',
  'git status', 'git log', 'git diff', 'git branch', 'git show',
  'echo', 'printf', 'date', 'pwd', 'whoami', 'uname',
  'node --version', 'python3 --version', 'npm --version',
])

// commands that should never auto-approve
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\brm\s+.*\//,
  /\bgit\s+push\s+--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-f/,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bcurl\b.*\|\s*(?:bash|sh)\b/,
  /\beval\b/,
  /\b>\s*\/etc\//,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bkill\s+-9\b/,
]

const inputSchema = z.object({
  command: z.string().describe('the shell command to execute'),
  description: z.string().optional().describe('what this command does'),
  timeout: z.number().optional().describe('timeout in milliseconds (max 600000)'),
})

type BashInput = z.infer<typeof inputSchema>

export const BashTool = buildTool<BashInput>({
  name: 'Bash',
  description: 'Execute a shell command and return its output.',

  inputSchema,

  async call(input: BashInput, context: ToolContext): Promise<ToolResult> {
    const timeout = Math.min(input.timeout || 120_000, 600_000)

    try {
      const output = execSync(input.command, {
        cwd: context.cwd,
        timeout,
        maxBuffer: MAX_OUTPUT,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      })

      const stderr = '' // execSync throws on non-zero, stderr captured in error
      const result = output.trim()

      if (result.length > MAX_OUTPUT) {
        return {
          content: result.slice(0, MAX_OUTPUT) + '\n\n[output truncated]',
        }
      }

      return { content: result || '(no output)' }
    } catch (error: unknown) {
      const execError = error as {
        status?: number
        stdout?: string
        stderr?: string
        message?: string
      }

      const stdout = execError.stdout?.toString().trim() || ''
      const stderr = execError.stderr?.toString().trim() || ''
      const exitCode = execError.status ?? 1

      let content = ''
      if (stdout) content += stdout + '\n'
      if (stderr) content += stderr + '\n'
      content += `\nExit code: ${exitCode}`

      return { content: content.trim(), isError: exitCode !== 0 }
    }
  },

  isConcurrencySafe(input: BashInput): boolean {
    const cmd = input.command.trim().split(/\s+/)[0] || ''
    return SAFE_COMMANDS.has(cmd) || SAFE_COMMANDS.has(input.command.trim())
  },

  isReadOnly(input: BashInput): boolean {
    const cmd = input.command.trim().split(/\s+/)[0] || ''
    return SAFE_COMMANDS.has(cmd) || SAFE_COMMANDS.has(input.command.trim())
  },

  checkPermissions(input: BashInput): PermissionResult {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(input.command)) {
        return {
          behavior: 'ask',
          message: `dangerous command detected: ${input.command}`,
        }
      }
    }

    // read-only commands auto-allow
    if (SAFE_COMMANDS.has(input.command.trim().split(/\s+/)[0] || '')) {
      return { behavior: 'allow' }
    }

    return { behavior: 'ask', message: `run: ${input.command}` }
  },
})
