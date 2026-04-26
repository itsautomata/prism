/**
 * inline bash execution: typing `!<cmd>` in the prompt runs <cmd> in the shell.
 * pure shell escape, output goes to the UI only, never to the conversation.
 * the model never sees it unless the user describes it in a follow-up message.
 * no permission prompt, you typed it, you trust it (same as your terminal).
 */

import type React from 'react'
import { execSync } from 'child_process'
import type { DisplayMessage } from './MessageList.js'

const MAX_OUTPUT = 512 * 1024
const TIMEOUT_MS = 30_000

export function handleBashCommand(
  input: string,
  setMessages: React.Dispatch<React.SetStateAction<DisplayMessage[]>>,
): boolean {
  if (!input.startsWith('!')) return false
  const cmd = input.slice(1).trim()
  if (!cmd) return true  // bare `!`, no-op so we don't fall through to the model

  setMessages(prev => [...prev, { role: 'tool_call', text: '', toolName: `! ${cmd}` }])

  let output: string
  let isError = false
  try {
    output = execSync(cmd, {
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || '(no output)'
  } catch (e: unknown) {
    isError = true
    const err = e as { status?: number; stdout?: string; stderr?: string; message?: string }
    const stdout = err.stdout?.toString().trim() || ''
    const stderr = err.stderr?.toString().trim() || ''
    const exitCode = err.status ?? 1
    output = [stdout, stderr, `Exit code: ${exitCode}`].filter(Boolean).join('\n').trim()
  }

  setMessages(prev => [...prev, { role: 'tool_result', text: output, isError }])
  return true
}
