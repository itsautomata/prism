import React, { useRef, useEffect, useState, memo, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'

interface PromptInputProps {
  onSubmit: (text: string) => void
  isLoading: boolean
}

export const PromptInput = memo(function PromptInput({ onSubmit, isLoading }: PromptInputProps) {
  // buffer stores keystrokes without triggering re-renders
  const bufferRef = useRef('')
  // display state updates on a throttled schedule
  const [display, setDisplay] = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleDisplayUpdate = useCallback(() => {
    if (timerRef.current) return // already scheduled
    timerRef.current = setTimeout(() => {
      setDisplay(bufferRef.current)
      timerRef.current = null
    }, 16) // ~60fps max
  }, [])

  // cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  useInput((input, key) => {
    if (isLoading) return

    // enter: submit
    if (key.return) {
      const text = bufferRef.current.trim()
      if (text) {
        onSubmit(text)
        bufferRef.current = ''
        setDisplay('')
      }
      return
    }

    // backspace
    if (key.backspace || key.delete) {
      bufferRef.current = bufferRef.current.slice(0, -1)
      setDisplay(bufferRef.current) // immediate for backspace (visual feedback matters)
      return
    }

    // ctrl+u: clear line
    if (key.ctrl && input === 'u') {
      bufferRef.current = ''
      setDisplay('')
      return
    }

    // ignore control sequences (arrows, escape, etc)
    if (key.ctrl || key.meta || key.escape || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
      return
    }

    // regular character: buffer it, throttle display
    bufferRef.current += input
    scheduleDisplayUpdate()
  }, { isActive: !isLoading })

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
      <Text wrap="wrap">{display}<Text color={theme.primary}>▎</Text>{!display && <Text color={theme.textMuted}> ask anything...</Text>}</Text>
    </Box>
  )
})
