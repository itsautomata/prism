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
 * read-only tools auto-allow. everything else checks rules then asks.
 */
export function needsPermission(
  toolName: string,
  permissionResult: PermissionResult,
  isReadOnly: boolean,
): boolean {
  // read-only tools never ask
  if (isReadOnly) return false

  // already allowed for this session
  if (isSessionAllowed(toolName)) return false

  // tool says allow
  if (permissionResult.behavior === 'allow') return false

  // tool says deny — don't ask, just block
  if (permissionResult.behavior === 'deny') return false

  // ask
  return true
}