/**
 * shell completion installer.
 * detects the user's shell, finds the right rc file, appends the eval line.
 * idempotent: safe to run more than once.
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir, platform } from 'os'
import { basename } from 'path'

const FIRST_RUN_FLAG = join(homedir(), '.prism', '.completion-installed')

export type SupportedShell = 'bash' | 'zsh'

export interface InstallResult {
  shell: SupportedShell
  rcPath: string
  status: 'installed' | 'already-installed'
}

export function detectShell(): SupportedShell | null {
  const sh = process.env.SHELL || ''
  const name = basename(sh)
  if (name === 'zsh') return 'zsh'
  if (name === 'bash') return 'bash'
  return null
}

export function rcPathFor(shell: SupportedShell): string {
  if (shell === 'zsh') {
    const zdotdir = process.env.ZDOTDIR
    return join(zdotdir || homedir(), '.zshrc')
  }
  // bash: macOS terminals run login shells (which load .bash_profile, not .bashrc)
  if (platform() === 'darwin') {
    const profile = join(homedir(), '.bash_profile')
    if (existsSync(profile)) return profile
  }
  return join(homedir(), '.bashrc')
}

const MARKER = '# prism shell completion'

function evalLineFor(shell: SupportedShell): string {
  return `eval "$(prism --completion ${shell})"`
}

export function installCompletion(requested?: SupportedShell): InstallResult {
  const shell = requested || detectShell()
  if (!shell) {
    throw new Error(`could not detect shell from $SHELL (${process.env.SHELL || 'unset'}). pass bash or zsh explicitly.`)
  }

  const rcPath = rcPathFor(shell)
  const evalLine = evalLineFor(shell)

  // idempotence: check if the eval line is already present
  if (existsSync(rcPath)) {
    const contents = readFileSync(rcPath, 'utf-8')
    if (contents.includes(evalLine)) {
      return { shell, rcPath, status: 'already-installed' }
    }
  }

  const block = `\n${MARKER}\n${evalLine}\n`
  appendFileSync(rcPath, block, 'utf-8')

  return { shell, rcPath, status: 'installed' }
}

/**
 * called once on prism startup. if completion has never been auto-installed,
 * and the user's shell is supported, install it silently and write a flag file
 * so we never do it again. opt out via PRISM_NO_AUTO_COMPLETION=1.
 *
 * returns the result if an install actually happened (so the caller can print
 * a notice), null otherwise (already-done, unsupported shell, or opted out).
 */
export function maybeAutoInstall(): InstallResult | null {
  if (process.env.PRISM_NO_AUTO_COMPLETION) return null
  if (existsSync(FIRST_RUN_FLAG)) return null

  const shell = detectShell()
  if (!shell) {
    // mark as done so we don't re-check every run for shells we can't support
    markFirstRunDone()
    return null
  }

  try {
    const result = installCompletion(shell)
    markFirstRunDone()
    return result.status === 'installed' ? result : null
  } catch {
    return null
  }
}

function markFirstRunDone(): void {
  try {
    const dir = join(homedir(), '.prism')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(FIRST_RUN_FLAG, new Date().toISOString(), 'utf-8')
  } catch {}
}
