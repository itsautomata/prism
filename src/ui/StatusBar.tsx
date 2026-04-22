import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'

interface StatusBarProps {
  turnCount: number
  tokenInfo: string
}

export function StatusBar({ turnCount, tokenInfo }: StatusBarProps) {
  if (turnCount === 0 && !tokenInfo) return null

  return (
    <Box marginTop={0}>
      <Text color={theme.textMuted}>
        turns: {turnCount}
        {tokenInfo ? ` · tokens: ${tokenInfo}` : ''}
      </Text>
    </Box>
  )
}
