/**
 * memory injection: formats the `# project memory` block for the system prompt.
 * combines lens.md (user-enforced rules) and memo.md (accumulated learning)
 * into a single section. each source rendered with its own subheading so the
 * model knows the provenance of each fact.
 */

export interface Memory {
  lens: string | null
  memo: string | null
}

export function isEmpty(m: Memory): boolean {
  return !m.lens && !m.memo
}

export function formatMemory(m: Memory): string | null {
  if (isEmpty(m)) return null

  const sections: string[] = ['# project memory']

  if (m.lens) {
    sections.push('')
    sections.push('## lens.md (user-enforced rules)')
    sections.push(m.lens)
  }

  if (m.memo) {
    sections.push('')
    sections.push('## memo (learned across sessions)')
    sections.push(m.memo)
  }

  return sections.join('\n')
}
