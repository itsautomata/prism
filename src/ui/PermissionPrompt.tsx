/**
 * permission prompt.
 * shown when a tool needs approval before executing.
 * three options: yes (once), yes (session), no.
 */

import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'

export type PermissionChoice = 'allow_once' | 'allow_session' | 'deny'

interface PermissionPromptProps {
  toolName: string
  description: string
  onDecision: (choice: PermissionChoice) => void
}

const OPTIONS: { key: string; value: PermissionChoice; label: string }[] = [
  { key: 'y', value: 'allow_once', label: 'yes (once)' },
  { key: 'a', value: 'allow_session', label: 'yes (always this session)' },
  { key: 'n', value: 'deny', label: 'no' },
]

export function PermissionPrompt({ toolName, description, onDecision }: PermissionPromptProps) {
  const [selected, setSelected] = useState(0)

  useInput((input, key) => {
    if (key.upArrow) {
      setSelected(s => Math.max(0, s - 1))
    } else if (key.downArrow) {
      setSelected(s => Math.min(OPTIONS.length - 1, s + 1))
    } else if (key.return) {
      onDecision(OPTIONS[selected]!.value)
    } else {
      // quick keys
      const option = OPTIONS.find(o => o.key === input.toLowerCase())
      if (option) onDecision(option.value)
    }
  })

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Box>
        <Text color={theme.warning}>◆ </Text>
        <Text color={theme.warning} bold>{toolName}</Text>
        <Text color={theme.textDim}> wants to: </Text>
        <Text color={theme.text}>{description}</Text>
      </Box>
      <Box flexDirection="column" marginTop={0} marginLeft={2}>
        {OPTIONS.map((opt, i) => (
          <Box key={opt.key}>
            <Text color={i === selected ? theme.primary : theme.textDim}>
              {i === selected ? '▸ ' : '  '}
            </Text>
            <Text color={i === selected ? theme.primary : theme.textDim}>
              [{opt.key}] {opt.label}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}