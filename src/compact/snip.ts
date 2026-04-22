/**
 * snip: drop old turns when context is getting full.
 * keeps system prompt + most recent turns.
 * fast, free, lossy.
 */

import type { Message } from '../types/index.js'

/**
 * snip oldest messages to fit within token budget.
 * keeps the most recent half of the conversation.
 */
export function snipOldTurns(messages: Message[]): Message[] {
  if (messages.length <= 4) return messages

  // keep the most recent half
  const keepCount = Math.ceil(messages.length / 2)
  const snipped = messages.slice(-keepCount)

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
