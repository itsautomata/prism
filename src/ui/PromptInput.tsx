import React, { useRef, useEffect, useState, memo, useCallback, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'
import { filterSlashCommands } from './commands.js'
import { SlashHints } from './SlashHints.js'

interface PromptInputProps {
  onSubmit: (text: string) => void
  isLoading: boolean
  inPlanMode?: boolean
}

export const PromptInput = memo(function PromptInput({ onSubmit, isLoading, inPlanMode }: PromptInputProps) {
  // buffer stores keystrokes without triggering re-renders
  const bufferRef = useRef('')
  // display state updates on a throttled schedule
  const [display, setDisplay] = useState('')
  const [selectedHintIdx, setSelectedHintIdx] = useState(0)
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

  // slash-completion state derived from the current display.
  // hide hints once the user adds a space (we're past the command name into args).
  const firstWord = display.split(' ')[0] || ''
  const showHints = display.startsWith('/') && !display.includes(' ')
  const matches = useMemo(() => {
    if (!showHints) return []
    return filterSlashCommands(firstWord)
  }, [showHints, firstWord])

  // reset selection whenever the filter changes
  useEffect(() => {
    setSelectedHintIdx(0)
  }, [firstWord, showHints])

  useInput((input, key) => {
    if (isLoading) return

    // hint navigation: only when hints are showing
    if (matches.length > 0) {
      if (key.upArrow) {
        setSelectedHintIdx(prev => Math.max(0, prev - 1))
        return
      }
      if (key.downArrow) {
        setSelectedHintIdx(prev => Math.min(matches.length - 1, prev + 1))
        return
      }
      if (key.tab) {
        const selected = matches[selectedHintIdx]
        if (selected) {
          bufferRef.current = selected.name + (selected.args ? ' ' : '')
          setDisplay(bufferRef.current)
        }
        return
      }
    }

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

    // ctrl+u OR esc: clear line (esc also exits shell mode by removing the `!`)
    if ((key.ctrl && input === 'u') || key.escape) {
      bufferRef.current = ''
      setDisplay('')
      return
    }

    // ignore other control sequences (arrows, tab, etc) when no hint context
    if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
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

  const isShell = display.startsWith('!')
  const isPlanInput = inPlanMode && !isShell
  const promptChar = isShell ? '$' : (isPlanInput ? '◇' : '◆')
  const accent = isShell ? theme.warning : (isPlanInput ? theme.planMode : theme.prompt)
  const visible = isShell ? display.slice(1) : display

  return (
    <Box marginTop={1} flexDirection="column">
      {isShell && (
        <Text color={theme.textMuted}>  shell mode (delete the `!` to exit, or esc to clear. output stays here, the model won't see it)</Text>
      )}
      {isPlanInput && (
        <Text color={theme.planMode}>  plan mode <Text color={theme.textMuted}>(type /exec-plan to execute, /cancel-plan to abandon, or push back to revise)</Text></Text>
      )}
      <Box>
        <Text color={accent}>{promptChar} </Text>
        <Text wrap="wrap" color={isShell ? theme.warning : undefined}>
          {visible}
          <Text color={accent}>▎</Text>
          {!display && <Text color={theme.textMuted}> ask anything...</Text>}
        </Text>
      </Box>
      <SlashHints matches={matches} selectedIdx={selectedHintIdx} />
    </Box>
  )
})
