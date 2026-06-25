/**
 * tool-call pairing for compaction.
 *
 * a turn spans two messages: an assistant message carrying tool_use blocks,
 * then a user message carrying the matching tool_result blocks. cutting history
 * by raw index can land the cut *between* them, leaving the kept slice opening
 * with a tool_result whose tool_use was dropped. strict providers (Anthropic,
 * OpenAI) reject that orphan with a 400 — killing the session exactly when
 * compaction was meant to rescue it.
 *
 * safeKeepStart finds a cut that never orphans a tool_result.
 */

import type { Message } from '../types/index.js'

function isToolResultBearingUser(msg: Message): boolean {
  return msg.role === 'user' && msg.content.some(b => b.type === 'tool_result')
}

/**
 * given a desired number of trailing messages to keep, return the actual slice
 * start index such that the kept slice does not begin with a user message that
 * carries a tool_result (an orphan). advances forward past any such message —
 * dropping a few extra messages is safe; keeping an orphan is not.
 */
export function safeKeepStart(messages: Message[], desiredKeepCount: number): number {
  let start = Math.max(0, messages.length - desiredKeepCount)
  while (start < messages.length && isToolResultBearingUser(messages[start])) {
    start++
  }
  return start
}
