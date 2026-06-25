/**
 * Bash tool.
 * execute shell commands. the most impactful tool.
 * each command is evaluated for safety independently.
 */

import { z } from 'zod'
import { exec } from 'child_process'
import { promisify } from 'util'
import { buildTool, type ToolResult, type ToolContext, type PermissionResult } from './Tool.js'
import { classifyRead } from './sensitivePaths.js'
import { loadConfig } from '../config/config.js'

// promisified exec keeps the node event loop free during the command
// (execSync blocks the UI render loop, including the spinner animation).
const execAsync = promisify(exec)

// commands that are safe to run concurrently (read-only)
const SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'rg',
  'which', 'whereis', 'file', 'stat', 'du', 'df',
  'git status', 'git log', 'git diff', 'git branch', 'git show',
  'git blame', 'git stash list', 'git remote', 'git rev-parse',
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

// shell metacharacters that turn a safe-looking first token into a compound
// command: chaining (; && ||), piping (|), redirection (< >), substitution
// ($ ` $(...)), subshells ( ), background (&), and newlines. their presence
// means the command is not a single safe invocation, whatever it starts with.
const SHELL_METACHARS = /[;&|<>$`\n()]/

/**
 * a command is simple-safe only when the entire trimmed command is one known
 * safe command, carries no shell operators, and matches no dangerous pattern.
 * first-token matching alone is unsafe: `echo ok && rm -rf ~` starts with a
 * safe token but is destructive. this is the single source of truth for both
 * the read-only/concurrency hints and the auto-allow decision.
 */
function isSimpleSafeCommand(command: string): boolean {
  const cmd = command.trim()
  if (SHELL_METACHARS.test(cmd)) return false
  if (DANGEROUS_PATTERNS.some(p => p.test(cmd))) return false
  const firstToken = cmd.split(/\s+/)[0] || ''
  return SAFE_COMMANDS.has(firstToken) || SAFE_COMMANDS.has(cmd)
}

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
    const maxOutput = loadConfig().tuning.bash_max_output_bytes
    const timeout = Math.min(input.timeout || 120_000, 600_000)

    try {
      const { stdout } = await execAsync(input.command, {
        cwd: context.cwd,
        timeout,
        maxBuffer: maxOutput,
        env: { ...process.env },
      })

      const result = stdout.trim()

      if (result.length > maxOutput) {
        return {
          content: result.slice(0, maxOutput) + '\n\n[output truncated]',
        }
      }

      return { content: result || '(no output)' }
    } catch (error: unknown) {
      const execError = error as {
        code?: number
        stdout?: string
        stderr?: string
        message?: string
      }

      const stdout = execError.stdout?.toString().trim() || ''
      const stderr = execError.stderr?.toString().trim() || ''
      const exitCode = execError.code ?? 1

      let content = ''
      if (stdout) content += stdout + '\n'
      if (stderr) content += stderr + '\n'
      content += `\nExit code: ${exitCode}`

      return { content: content.trim(), isError: exitCode !== 0 }
    }
  },

  isConcurrencySafe(input: BashInput): boolean {
    return isSimpleSafeCommand(input.command)
  },

  isReadOnly(input: BashInput): boolean {
    return isSimpleSafeCommand(input.command)
  },

  checkPermissions(input: BashInput, context: ToolContext): PermissionResult {
    // dangerous patterns always prompt, even when they start with a safe token
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(input.command)) {
        return {
          behavior: 'ask',
          message: `dangerous command detected: ${input.command}`,
        }
      }
    }

    // a simple safe command auto-allows — unless a path argument escapes the
    // project (e.g. `cat ~/.ssh/id_rsa`). a safe read command pointed outside
    // the project is a secret-read channel, so it prompts.
    if (isSimpleSafeCommand(input.command)) {
      const args = input.command.trim().split(/\s+/).slice(1)
      for (const arg of args) {
        if (arg.startsWith('-')) continue // flag, not a path
        if (!classifyRead(arg, context.cwd).allow) {
          return { behavior: 'ask', message: `run: ${input.command}` }
        }
      }
      return { behavior: 'allow' }
    }

    return { behavior: 'ask', message: `run: ${input.command}` }
  },
})
