/**
 * summary compaction.
 * asks the model to summarize old turns.
 * costs 1 API call. preserves what matters.
 */

import type { ProviderBridge, Message } from '../types/index.js'

const SUMMARY_PROMPT = `this summary replaces the original session messages. dropped or inaccurate information is permanently lost. prioritize accuracy over brevity.

extract from the conversation above:

1. every file created, modified, or deleted with its absolute path and what changed.
2. every decision made and its rationale. include rejected alternatives if discussed.
3. every error encountered and how it was resolved. if unresolved, mark as OPEN.
4. any rules, preferences, or patterns the user expressed (e.g. "use pytest", "no abstractions", naming conventions).
5. any open items: incomplete work, deferred tasks, unanswered questions.

synthesize into one dense paragraph. no headers, no bullet points, no markdown. every sentence must be a fact. use exact file paths and exact command names. one line per distinct action or decision.

target: under 200 words. exceed if accuracy requires it.

this summary replaces the original messages. nothing outside it is preserved.`

/**
 * summarize old messages into a compact summary.
 * keeps recent turns intact. replaces old turns with one summary message.
 */
export async function summarizeOldTurns(
  messages: Message[],
  provider: ProviderBridge,
  model: string,
  keepRecent: number = 10,
): Promise<Message[]> {
  if (messages.length <= keepRecent + 2) return messages

  const oldMessages = messages.slice(0, -keepRecent)
  const recentMessages = messages.slice(-keepRecent)

  // build the conversation text to summarize
  const conversationText = oldMessages.map(msg => {
    const role = msg.role
    const text = msg.content
      .map(b => {
        if (b.type === 'text') return b.text
        if (b.type === 'tool_use') return `[called ${b.name}(${JSON.stringify(b.input).slice(0, 100)})]`
        if (b.type === 'tool_result') {
          const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
          return `[result: ${content.slice(0, 300)}${content.length > 300 ? '...' : ''}]`
        }
        return ''
      })
      .filter(Boolean)
      .join(' ')
    return `${role}: ${text}`
  }).join('\n')

  try {
    const response = await provider.createMessage({
      model,
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: `${conversationText}\n\n---\n\n${SUMMARY_PROMPT}` }],
      }],
      system: undefined,
      maxTokens: 500,
    })

    const summaryText = response.content
      .filter(b => b.type === 'text')
      .map(b => b.type === 'text' ? b.text : '')
      .join(' ')
      .trim()

    if (!summaryText) return messages

    const summary: Message = {
      role: 'user',
      content: [{
        type: 'text',
        text: `[session summary]\n${summaryText}\n[end summary]`,
      }],
    }

    return [summary, ...recentMessages]
  } catch {
    return messages
  }
}
