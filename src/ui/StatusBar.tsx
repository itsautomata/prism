import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'

interface StatusBarProps {
  turnCount: number
  inputTokens: number
  outputTokens: number
}

export function StatusBar({ turnCount, inputTokens, outputTokens }: StatusBarProps) {
  if (turnCount === 0 && inputTokens === 0) return null

  return (
    <Box marginTop={0}>
      <Text color={theme.textMuted}>
        turns: {turnCount} · tokens: {inputTokens} in / {outputTokens} out
      </Text>
    </Box>
  )
}
