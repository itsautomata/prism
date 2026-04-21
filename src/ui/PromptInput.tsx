import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'
import { theme } from './theme.js'

interface PromptInputProps {
  onSubmit: (text: string) => void
  isLoading: boolean
}

export function PromptInput({ onSubmit, isLoading }: PromptInputProps) {
  const [value, setValue] = useState('')

  if (isLoading) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={theme.spinner}>◇ </Text>
          <Text color={theme.textDim}>thinking...</Text>
        </Box>
        <Box>
          <Text color={theme.textMuted}>  esc to interrupt</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box marginTop={1}>
      <Text color={theme.prompt}>◆ </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(text) => {
          if (text.trim()) {
            onSubmit(text.trim())
            setValue('')
          }
        }}
        placeholder="ask anything..."
      />
    </Box>
  )
}
