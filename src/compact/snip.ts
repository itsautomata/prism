/**
 * snip: drop old turns when context is getting full.
 * keeps system prompt + most recent turns.
 * fast, free, lossy.
 */

import type { Message } from '../types/index.js'
import { safeKeepStart } from './pairing.js'

/**
 * snip oldest messages to fit within token budget.
 * keeps the most recent half of the conversation.
 */
export function snipOldTurns(messages: Message[]): Message[] {
  if (messages.length <= 4) return messages

  // keep the most recent half, but never cut between a tool_use and its
  // tool_result (would orphan the result and make the provider reject the turn)
  const keepCount = Math.ceil(messages.length / 2)
  const snipped = messages.slice(safeKeepStart(messages, keepCount))

  // insert a marker so the model knows context was lost
  const marker: Message = {
    role: 'user',
    content: [{
      type: 'text',
      text: '[earlier conversation was compressed. only recent turns are shown.]',
    }],
  }

  return [marker, ...snipped]
}
