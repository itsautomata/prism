import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'
import { Markdown } from './Markdown.js'

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result'
  text: string
  toolName?: string
  isError?: boolean
  isStreaming?: boolean
}

interface MessageListProps {
  messages: DisplayMessage[]
}

export function MessageList({ messages }: MessageListProps) {
  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => (
        <MessageBlock key={i} message={msg} />
      ))}
    </Box>
  )
}

function MessageBlock({ message }: { message: DisplayMessage }) {
  switch (message.role) {
    case 'user':
      return (
        <Box marginTop={1} marginBottom={1}>
          <Text color={theme.primary} bold>❯ </Text>
          <Text color={theme.text}>{message.text}</Text>
        </Box>
      )

    case 'assistant':
      return (
        <Box marginTop={0} marginBottom={0} marginLeft={2}>
          <Markdown text={message.text} />
        </Box>
      )

    case 'tool_call':
      return (
        <Box marginTop={0} marginBottom={0} marginLeft={2}>
          <Text color={theme.accent}>⚡ </Text>
          <Text color={theme.accent} bold>{message.toolName}</Text>
        </Box>
      )

    case 'tool_result':
      if (message.isError) {
        return (
          <Box marginTop={0} marginBottom={0} marginLeft={4}>
            <Text color={theme.error}>✗ {message.text}</Text>
          </Box>
        )
      }
      return (
        <Box marginTop={0} marginBottom={0} marginLeft={4}>
          <Text color={theme.toolOutput}>
            {message.text.length > 500
              ? message.text.slice(0, 500) + '\n...(truncated)'
              : message.text}
          </Text>
        </Box>
      )

    default:
      return null
  }
}
