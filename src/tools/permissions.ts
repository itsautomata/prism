/**
 * permission system.
 * model proposes, system disposes.
 * read-only tools auto-allow. write tools always ask.
 *
 * three options: yes (once), yes (session), no.
 */

import type { PermissionResult } from './Tool.js'

export type PermissionDecision = 'allow' | 'deny'

export interface PermissionRequest {
  toolName: string
  description: string
  input: Record<string, unknown>
}

// session-level allow rules (in-memory, not persisted)
const sessionRules = new Set<string>()

/**
 * check if a tool call is auto-allowed by session rules.
 */
export function isSessionAllowed(toolName: string): boolean {
  return sessionRules.has(toolName)
}

/**
 * add a session-level allow rule.
 * "yes for this session" — never ask again for this tool until prism restarts.
 */
export function allowForSession(toolName: string): void {
  sessionRules.add(toolName)
}

/**
 * clear all session rules.
 */
export function clearSessionRules(): void {
  sessionRules.clear()
}

/**
 * determine if a tool needs permission.
 *
 * the tool's checkPermissions result is the single source of truth: read-only
 * tools return 'allow' (their auto-allow path), everything else returns 'ask'
 * or 'deny'. a tool's isReadOnly flag is a concurrency/UI hint and deliberately
 * does not gate here — letting it short-circuit let a command like
 * `echo ok && rm -rf ~` (first token "safe") skip the prompt entirely.
 */
export function needsPermission(
  toolName: string,
  permissionResult: PermissionResult,
): boolean {
  // already allowed for this session
  if (isSessionAllowed(toolName)) return false

  // tool says allow
  if (permissionResult.behavior === 'allow') return false

  // tool says deny — don't ask, just block (handled upstream)
  if (permissionResult.behavior === 'deny') return false

  // ask
  return true
}