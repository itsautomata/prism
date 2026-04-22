/**
 * token counting.
 * uses gpt-tokenizer for ~85-95% accuracy across models.
 * serves both compression decisions and user display.
 */

import { encode } from 'gpt-tokenizer'
import type { Message, ContentBlock } from '../types/index.js'

/**
 * count tokens in a string.
 */
export function countTokens(text: string): number {
  return encode(text).length
}

/**
 * count tokens in a content block.
 */
function countBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return countTokens(block.text)
    case 'tool_use':
      return countTokens(block.name) + countTokens(JSON.stringify(block.input))
    case 'tool_result':
      return typeof block.content === 'string'
        ? countTokens(block.content)
        : block.content.reduce((sum, b) => sum + countBlockTokens(b), 0)
    case 'thinking':
      return countTokens(block.text)
    case 'image':
      return 100 // approximate, images are resized by the API
  }
}

/**
 * count tokens in a single message.
 */
export function countMessageTokens(msg: Message): number {
  return msg.content.reduce((sum, block) => sum + countBlockTokens(block), 0) + 4 // +4 for role/formatting overhead
}

/**
 * count total tokens in a conversation.
 */
export function countConversationTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + countMessageTokens(msg), 0)
}

/**
 * format token count for display.
 */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return String(count)
}
