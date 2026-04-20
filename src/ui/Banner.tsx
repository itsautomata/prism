import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'

interface BannerProps {
  model: string
  provider: string
  maxTools: number
  accuracy: number
  rulesCount: number
}

export function Banner({ model, provider, maxTools, accuracy, rulesCount }: BannerProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.primary} bold>◆ prism</Text>
        <Text color={theme.textDim}> — local-first AI assistant</Text>
      </Box>
      <Box>
        <Text color={theme.textDim}>  {provider}</Text>
        <Text color={theme.textMuted}> / </Text>
        <Text color={theme.primaryDim}>{model}</Text>
        <Text color={theme.textMuted}> / </Text>
        <Text color={theme.textDim}>tools: {maxTools}</Text>
        <Text color={theme.textMuted}> / </Text>
        <Text color={theme.textDim}>accuracy: {Math.round(accuracy * 100)}%</Text>
        {rulesCount > 0 && (
          <>
            <Text color={theme.textMuted}> / </Text>
            <Text color={theme.primaryDim}>{rulesCount} learned</Text>
          </>
        )}
      </Box>
    </Box>
  )
}
