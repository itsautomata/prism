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
  // cursor position within bufferRef. drives where new chars splice in and where
  // the ▎ caret renders. left/right arrows move it; typing/backspace mutate it.
  const cursorRef = useRef(0)
  // display state updates on a throttled schedule
  const [display, setDisplay] = useState('')
  const [cursorPos, setCursorPos] = useState(0)
  const [selectedHintIdx, setSelectedHintIdx] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushNow = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    setDisplay(bufferRef.current)
    setCursorPos(cursorRef.current)
  }, [])

  const scheduleDisplayUpdate = useCallback(() => {
    if (timerRef.current) return // already scheduled
    timerRef.current = setTimeout(() => {
      setDisplay(bufferRef.current)
      setCursorPos(cursorRef.current)
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
          cursorRef.current = bufferRef.current.length
          flushNow()
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
        cursorRef.current = 0
        flushNow()
      }
      return
    }

    // backspace: delete char left of cursor
    if (key.backspace || key.delete) {
      const c = cursorRef.current
      if (c > 0) {
        bufferRef.current = bufferRef.current.slice(0, c - 1) + bufferRef.current.slice(c)
        cursorRef.current = c - 1
        flushNow()
      }
      return
    }

    // ctrl+u OR esc: clear line (esc also exits shell mode by removing the `!`)
    if ((key.ctrl && input === 'u') || key.escape) {
      bufferRef.current = ''
      cursorRef.current = 0
      flushNow()
      return
    }

    // left/right: move cursor within buffer
    if (key.leftArrow) {
      cursorRef.current = Math.max(0, cursorRef.current - 1)
      flushNow()
      return
    }
    if (key.rightArrow) {
      cursorRef.current = Math.min(bufferRef.current.length, cursorRef.current + 1)
      flushNow()
      return
    }

    // ctrl+a / ctrl+e: jump to start / end (readline convention)
    if (key.ctrl && input === 'a') {
      cursorRef.current = 0
      flushNow()
      return
    }
    if (key.ctrl && input === 'e') {
      cursorRef.current = bufferRef.current.length
      flushNow()
      return
    }

    // ignore other control sequences (up/down/tab without hints, ctrl combos we don't handle)
    if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.tab) {
      return
    }

    // regular character: splice at cursor, advance cursor, throttle display
    const c = cursorRef.current
    bufferRef.current = bufferRef.current.slice(0, c) + input + bufferRef.current.slice(c)
    cursorRef.current = c + input.length
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
  // cursor is in buffer coordinates; in shell mode the leading `!` is hidden,
  // so the visible-space cursor is one to the left (clamped at 0).
  const visibleCursor = isShell ? Math.max(0, cursorPos - 1) : cursorPos
  // block cursor: highlight the char at the cursor (or a space if cursor is at
  // end of buffer). a thin caret like `▎` between chars takes its own cell and
  // visibly pushes letters apart in monospace; inverting the cell stays on the
  // grid and matches the standard terminal cursor convention.
  const before = visible.slice(0, visibleCursor)
  const cursorChar = visible[visibleCursor] ?? ' '
  const after = visible.slice(visibleCursor + 1)

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
          {before}
          <Text inverse>{cursorChar}</Text>
          {after}
          {!display && <Text color={theme.textMuted}>ask anything...</Text>}
        </Text>
      </Box>
      <SlashHints matches={matches} selectedIdx={selectedHintIdx} />
    </Box>
  )
})
