import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'
import { homedir } from 'os'

interface BannerProps {
  model: string
  provider: string
  maxTools: number
  rulesCount: number
  isResumed?: boolean
  inPlanMode?: boolean
}

function shortenPath(cwd: string): string {
  const home = homedir()
  if (cwd.startsWith(home)) {
    return '~' + cwd.slice(home.length)
  }
  return cwd
}

export function Banner({ model, provider, maxTools, rulesCount, isResumed, inPlanMode }: BannerProps) {
  const cwd = shortenPath(process.cwd())

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={theme.primary} bold>◆ prism</Text>
        <Text color={theme.textMuted}>  ◈  </Text>
        <Text color={theme.textDim}>local-first AI coding assistant</Text>
      </Box>
      <Box>
        <Text color={theme.textMuted}>  </Text>
        <Text color={theme.primaryDim}>{model}</Text>
        {provider !== 'ollama' && (
          <>
            <Text color={theme.textMuted}> via </Text>
            <Text color={theme.textDim}>{provider}</Text>
          </>
        )}
        <Text color={theme.textMuted}> / tools: {maxTools}</Text>
        {rulesCount > 0 && (
          <>
            <Text color={theme.textMuted}> / </Text>
            <Text color={theme.primaryDim}>{rulesCount} learned</Text>
          </>
        )}
        {isResumed && (
          <>
            <Text color={theme.textMuted}> / </Text>
            <Text color={theme.textDim}>resumed</Text>
          </>
        )}
        {inPlanMode && (
          <>
            <Text color={theme.textMuted}> / </Text>
            <Text color={theme.warning} bold>plan mode</Text>
          </>
        )}
      </Box>
      <Box>
        <Text color={theme.textMuted}>  {cwd}</Text>
      </Box>
    </Box>
  )
}
