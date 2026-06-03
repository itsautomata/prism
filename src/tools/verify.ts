/**
 * Verify tool. runs a project verification command (tests, typecheck, lint)
 * and surfaces the result. semantically distinct from Bash so the trajectory
 * log can distinguish verification steps from arbitrary shell, and so the
 * system prompt can name a dedicated affordance for "confirm before claiming
 * done."
 *
 * the agent derives the command from `# project scan` and `# repo map` in
 * the system prompt. prism does not auto-detect the framework; the model has
 * full context already and chooses per project (e.g. `npx vitest run` for
 * vision, `pytest tests/` for a python project).
 */

import { z } from 'zod'
import { exec } from 'child_process'
import { promisify } from 'util'
import { buildTool, type ToolResult, type ToolContext, type PermissionResult } from './Tool.js'
import { loadConfig } from '../config/config.js'

// promisified exec keeps the node event loop free during the command
// (execSync blocks the UI render loop, including the spinner animation).
const execAsync = promisify(exec)

const inputSchema = z.object({
  command: z.string().describe('the verification command to run (e.g. `npx vitest run`, `pytest`, `cargo test`)'),
  description: z.string().optional().describe('one-line description of what is being verified'),
  timeout: z.number().optional().describe('timeout in milliseconds (default 60s, max 600s)'),
})

type VerifyInput = z.infer<typeof inputSchema>

export const VerifyTool = buildTool<VerifyInput>({
  name: 'Verify',
  description: 'Run a project verification command (tests, typecheck, lint) and return its output. Derive the command from project scan and repo map. Use before claiming done after a non-trivial edit.',

  inputSchema,

  async call(input: VerifyInput, context: ToolContext): Promise<ToolResult> {
    const maxOutput = loadConfig().tuning.bash_max_output_bytes
    const timeout = Math.min(input.timeout || 60_000, 600_000)

    try {
      const { stdout } = await execAsync(input.command, {
        cwd: context.cwd,
        timeout,
        maxBuffer: maxOutput,
        env: { ...process.env },
      })
      const result = stdout.trim()
      if (result.length > maxOutput) {
        return { content: result.slice(0, maxOutput) + '\n\n[output truncated]' }
      }
      return { content: `verified: ${input.command}\n\n${result || '(no output)'}` }
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
      const parts = [
        `verification failed: ${input.command}`,
        '',
        stdout && stdout,
        stderr && stderr,
        `exit code: ${exitCode}`,
      ].filter(Boolean)
      return { content: parts.join('\n'), isError: true }
    }
  },

  // verification commands are observation, not mutation of the working tree.
  // they may have incidental side effects (cache writes, coverage reports)
  // but do not change source files the operator is authoring.
  isReadOnly(): boolean {
    return true
  },

  isConcurrencySafe(): boolean {
    // verify runs build/test pipelines that often hold global locks
    // (node_modules access, port binding, db setup). serialize them.
    return false
  },

  checkPermissions(input: VerifyInput): PermissionResult {
    return { behavior: 'ask', message: `verify: ${input.command}` }
  },
})
