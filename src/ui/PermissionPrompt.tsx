/**
 * permission prompt.
 * shown when a tool needs approval before executing.
 * three options: yes (once), yes (session), no.
 *
 * always mounted so useInput is always live — no render-cycle gap on keypress.
 */

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'

export type PermissionChoice = 'allow_once' | 'allow_session' | 'deny'

interface PermissionPromptProps {
  toolName: string | null
  description: string | null
  onDecision: (choice: PermissionChoice) => void
}

const OPTIONS: { key: string; value: PermissionChoice; label: string }[] = [
  { key: 'y', value: 'allow_once', label: 'yes (once)' },
  { key: 'a', value: 'allow_session', label: 'yes (always this session)' },
  { key: 'n', value: 'deny', label: 'no' },
]

// the selection defaults to deny: a reflexive Enter must not approve a tool.
// approval is explicit (press y or a, or arrow up to a yes then Enter).
const DENY_INDEX = OPTIONS.findIndex(o => o.value === 'deny')

export function PermissionPrompt({ toolName, description, onDecision }: PermissionPromptProps) {
  const selectedRef = useRef(DENY_INDEX)
  const [selected, setSelected] = useState(DENY_INDEX)
  const resolverRef = useRef<((choice: PermissionChoice) => void) | null>(null)

  // forward the onDecision through a ref so useInput always calls the latest
  useEffect(() => {
    resolverRef.current = onDecision
  }, [onDecision])

  const move = useCallback((dir: -1 | 1) => {
    const next = Math.max(0, Math.min(OPTIONS.length - 1, selectedRef.current + dir))
    selectedRef.current = next
    setSelected(next)
  }, [])

  useInput((input, key) => {
    if (!toolName) return // no active prompt, ignore keys
    if (key.escape) {
      resolverRef.current?.('deny')
      return
    }
    if (key.upArrow) {
      move(-1)
    } else if (key.downArrow) {
      move(1)
    } else if (key.return) {
      resolverRef.current?.(OPTIONS[selectedRef.current]!.value)
    } else {
      const option = OPTIONS.find(o => o.key === input.toLowerCase())
      if (option) resolverRef.current?.(option.value)
    }
  })

  if (!toolName) return null

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