/**
 * tool result trimmer.
 * old tool results eat context. trim them.
 * keeps recent results full, trims old ones to first/last few lines.
 */

import type { Message, ContentBlock, ToolResultBlock } from '../types/index.js'

const KEEP_RECENT = 4 // keep last N messages' tool results untrimmed
const TRIM_TO_LINES = 10 // trim old tool results to first + last N lines

/**
 * trim old tool results in the conversation.
 * recent results stay full. old ones get compressed.
 */
export function trimOldToolResults(messages: Message[]): Message[] {
  if (messages.length <= KEEP_RECENT) return messages

  const cutoff = messages.length - KEEP_RECENT

  return messages.map((msg, i) => {
    if (i >= cutoff) return msg // recent, keep full

    const trimmedContent = msg.content.map(block => {
      if (block.type === 'tool_result' && typeof block.content === 'string') {
        return trimToolResult(block)
      }
      return block
    })

    return { ...msg, content: trimmedContent }
  })
}

function trimToolResult(block: ToolResultBlock): ToolResultBlock {
  if (typeof block.content !== 'string') return block

  const lines = block.content.split('\n')
  if (lines.length <= TRIM_TO_LINES * 2) return block // already small

  const first = lines.slice(0, TRIM_TO_LINES).join('\n')
  const last = lines.slice(-TRIM_TO_LINES).join('\n')
  const trimmed = `${first}\n\n[${lines.length - TRIM_TO_LINES * 2} lines trimmed]\n\n${last}`

  return { ...block, content: trimmed }
}
