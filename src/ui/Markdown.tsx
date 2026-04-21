/**
 * markdown renderer for Ink.
 * parses markdown into React/Ink components.
 * handles only what the model actually outputs:
 * bold, italic, code spans, code blocks, headers, lists, links.
 */

import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'

interface MarkdownProps {
  text: string
}

export function Markdown({ text }: MarkdownProps) {
  const blocks = parseBlocks(text)
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <MarkdownBlock key={i} block={block} />
      ))}
    </Box>
  )
}

// block types
type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; language: string; code: string }
  | { type: 'list'; items: string[] }
  | { type: 'empty' }

function parseBlocks(text: string): Block[] {
  const lines = text.split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]!

    // empty line
    if (line.trim() === '') {
      blocks.push({ type: 'empty' })
      i++
      continue
    }

    // code block
    if (line.trimStart().startsWith('```')) {
      const language = line.trim().slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        codeLines.push(lines[i]!)
        i++
      }
      i++ // skip closing ```
      blocks.push({ type: 'code', language, code: codeLines.join('\n') })
      continue
    }

    // heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1]!.length, text: headingMatch[2]! })
      i++
      continue
    }

    // list item (-, *, or numbered)
    if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && (/^\s*[-*]\s/.test(lines[i]!) || /^\s*\d+\.\s/.test(lines[i]!))) {
        items.push(lines[i]!.replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push({ type: 'list', items })
      continue
    }

    // paragraph — single line, preserve each line individually
    blocks.push({ type: 'paragraph', text: line })
    i++
  }

  return blocks
}

function MarkdownBlock({ block }: { block: Block }) {
  switch (block.type) {
    case 'empty':
      return <Text>{''}</Text>

    case 'heading':
      return (
        <Box marginTop={1}>
          <Text color={theme.primary} bold>{block.text}</Text>
        </Box>
      )

    case 'code':
      return (
        <Box marginTop={0} marginBottom={0} paddingLeft={2} flexDirection="column">
          {block.language && <Text color={theme.textMuted}>{block.language}</Text>}
          <Text color={theme.accent}>{block.code}</Text>
        </Box>
      )

    case 'list':
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Box key={i}>
              <Text color={theme.primary}>  • </Text>
              <InlineMarkdown text={item} />
            </Box>
          ))}
        </Box>
      )

    case 'paragraph':
      return <InlineMarkdown text={block.text} />
  }
}

/**
 * inline markdown: bold, italic, code spans, links.
 * parsed into Ink <Text> components with appropriate styling.
 */
function InlineMarkdown({ text }: { text: string }) {
  const parts = parseInline(text)
  return (
    <Text>
      {parts.map((part, i) => {
        switch (part.type) {
          case 'text':
            return <Text key={i}>{part.text}</Text>
          case 'bold':
            return <Text key={i} bold>{part.text}</Text>
          case 'italic':
            return <Text key={i} italic>{part.text}</Text>
          case 'code':
            return <Text key={i} color={theme.accent}>{part.text}</Text>
          case 'link':
            return <Text key={i} color={theme.accent} underline>{part.text}</Text>
          case 'bolditalic':
            return <Text key={i} bold italic>{part.text}</Text>
        }
      })}
    </Text>
  )
}

type InlinePart =
  | { type: 'text'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'italic'; text: string }
  | { type: 'bolditalic'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string }

function parseInline(text: string): InlinePart[] {
  const parts: InlinePart[] = []
  // regex handles: ***bold italic***, **bold**, *italic*, `code`, [text](url), $math$
  const pattern = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\$([^$]+)\$)/g

  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    // text before match
    if (match.index > lastIndex) {
      parts.push({ type: 'text', text: text.slice(lastIndex, match.index) })
    }

    if (match[2]) {
      parts.push({ type: 'bolditalic', text: match[2] })
    } else if (match[3]) {
      parts.push({ type: 'bold', text: match[3] })
    } else if (match[4]) {
      parts.push({ type: 'italic', text: match[4] })
    } else if (match[5]) {
      parts.push({ type: 'code', text: match[5] })
    } else if (match[6] && match[7]) {
      parts.push({ type: 'link', text: match[6], url: match[7] })
    } else if (match[8]) {
      // math ($...$) rendered as code
      parts.push({ type: 'code', text: match[8] })
    }

    lastIndex = match.index + match[0].length
  }

  // remaining text
  if (lastIndex < text.length) {
    parts.push({ type: 'text', text: text.slice(lastIndex) })
  }

  if (parts.length === 0) {
    parts.push({ type: 'text', text })
  }

  return parts
}