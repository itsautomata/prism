import React from 'react'
import { Box, Text } from 'ink'
import { theme } from './theme.js'
import type { SlashCommandSpec } from './commands.js'

interface SlashHintsProps {
  matches: SlashCommandSpec[]
  selectedIdx: number
}

/**
 * dropdown of slash commands rendered above the prompt while the user is
 * typing the first token of a slash command. hides itself once the user
 * adds a space (entering args territory) or types a non-/ first char.
 */
export function SlashHints({ matches, selectedIdx }: SlashHintsProps) {
  if (matches.length === 0) return null

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.textMuted}>  ↑/↓ to navigate, tab to complete</Text>
      {matches.map((cmd, i) => {
        const selected = i === selectedIdx
        const fullName = cmd.args ? `${cmd.name} ${cmd.args}` : cmd.name
        return (
          <Box key={cmd.name}>
            <Text color={selected ? theme.primary : theme.textMuted}>
              {selected ? '▸ ' : '  '}
              {fullName.padEnd(24)}
            </Text>
            <Text color={selected ? theme.text : theme.textDim}>
              {cmd.desc}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
