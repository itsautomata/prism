import React, { useRef, useEffect, useState, memo, useCallback, useMemo } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme } from './theme.js'
import { filterSlashCommands } from './commands.js'
import type { SlashCommandSpec } from './commands.js'
import { SlashHints } from './SlashHints.js'
import {
  createBuffer,
  insertText,
  insertPill,
  deleteBack,
  deleteForward,
  deleteWordBack,
  killToEnd,
  expand,
  flatLength,
  locate,
  wordBoundaryLeft,
  wordBoundaryRight,
  moveCursorUp,
  moveCursorDown,
  totalLines,
  flatToLineCol,
  sliceToLines,
  type Buffer as InputBuffer,
  type PasteStore,
  type Segment,
} from './inputBuffer.js'
import { loadConfig } from '../config/config.js'

interface PromptInputProps {
  onSubmit: (text: string) => void
  isLoading: boolean
  inPlanMode?: boolean
  invokeSkills?: SlashCommandSpec[]
}

/**
 * input chunks above this length in a single useInput tick fold into a paste
 * pill instead of being spliced char-by-char. real typists never reach it.
 */
const PASTE_PILL_THRESHOLD = 1000

export const PromptInput = memo(function PromptInput({ onSubmit, isLoading, inPlanMode, invokeSkills = [] }: PromptInputProps) {
  // segment buffer: text runs interleaved with pasted-blob placeholders.
  const bufferRef = useRef<InputBuffer>(createBuffer())
  // pill content store: pill id → original pasted text. expand() resolves
  // pills back to their content when the buffer is submitted.
  const pasteStoreRef = useRef<PasteStore>(new Map())
  // cursor position in flat-atom coordinates (each pill = 1 atom).
  const cursorRef = useRef(0)

  // display state — re-renders on a throttled schedule
  const [displayBuf, setDisplayBuf] = useState<InputBuffer>([])
  const [cursorPos, setCursorPos] = useState(0)
  const [selectedHintIdx, setSelectedHintIdx] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // some terminals split modified-enter (shift / option / alt + enter) into
  // escape-then-return. defer escape's clear by 50ms so a return inside the
  // window can cancel it and insert a newline instead.
  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushNow = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    setDisplayBuf(bufferRef.current)
    setCursorPos(cursorRef.current)
  }, [])

  const scheduleDisplayUpdate = useCallback(() => {
    if (timerRef.current) return
    timerRef.current = setTimeout(() => {
      setDisplayBuf(bufferRef.current)
      setCursorPos(cursorRef.current)
      timerRef.current = null
    }, 16)
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current)
    }
  }, [])

  // clear the buffer immediately. shared between the deferred-escape timer
  // and the pre-empt case where another key arrives while escape is pending.
  const clearBufferNow = useCallback(() => {
    bufferRef.current = createBuffer()
    pasteStoreRef.current = new Map()
    cursorRef.current = 0
    flushNow()
  }, [flushNow])

  // raw stdin tap. ink's parser can strip or split modifier-key chord bytes,
  // so this listener prepends to the 'data' event, matches the chord at the
  // byte level, and sets ignoreNextReturnRef to swallow ink's duplicate
  // return event for the same bytes.
  const ignoreNextReturnRef = useRef(false)
  useEffect(() => {
    if (isLoading) return
    const stdin = process.stdin
    if (!stdin || !stdin.isTTY) return

    const handler = (chunk: Buffer | string) => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      // patterns that mean "newline-enter chord" across the common terminal
      // stacks. matching the raw bytes covers terminals/ssh setups where ink
      // doesn't surface the modifier flag through its keypress parser.
      //   '\x1b\r' / '\x1b\n'   esc-prefix legacy (modified-enter on terminals without kitty)
      //   '\x1b[13;<mod>u'      kitty keyboard protocol: enter with any modifier
      //   '\x1b[27;<mod>;13~'   "modify other keys" mode: enter with any modifier
      const isNewlineEnter =
        s === '\x1b\r' || s === '\x1b\n' ||
        /^\x1b\[13;\d+u$/.test(s) ||
        /^\x1b\[27;\d+;13~$/.test(s)
      if (!isNewlineEnter) return

      bufferRef.current = insertText(bufferRef.current, cursorRef.current, '\n')
      cursorRef.current += 1
      scheduleDisplayUpdate()
      // mark: the next return event coming through useInput is the same chord
      // surfacing through ink's parser. ignore it so we don't double-handle.
      ignoreNextReturnRef.current = true
      setTimeout(() => { ignoreNextReturnRef.current = false }, 50)
    }

    // prepend so this fires before ink's own 'data' listener. that way the
    // ignoreNextReturnRef flag is set before useInput dispatches the return.
    stdin.prependListener('data', handler)
    return () => { stdin.off('data', handler) }
  }, [isLoading, scheduleDisplayUpdate])

  // hint matching looks at the buffer's plain-text projection. pills never
  // appear inside a slash command (slash commands are short typed strings,
  // never pasted), so a buffer with any pill skips hint matching entirely.
  const allText = displayBuf.every(s => s.kind === 'text')
  const displayText = allText
    ? displayBuf.map(s => (s as { chars: string }).chars).join('')
    : ''
  const parts = displayText.split(/\s+/)
  const firstWord = parts[0] || ''

  const isSkillCompletion = allText && firstWord === '/run' && parts.length <= 2
  const isSectionCompletion = allText && firstWord === '/run' && parts.length >= 3
  const isCmdCompletion = allText && displayText.startsWith('/') && !displayText.includes(' ') && parts.length === 1 && !isSkillCompletion
  const showHints = isCmdCompletion || isSkillCompletion || isSectionCompletion

  const matches = useMemo<SlashCommandSpec[]>(() => {
    if (!showHints) return []
    if (isSectionCompletion) {
      const skillName = (parts[1] || '').toLowerCase()
      const partial = (parts[2] || '').toLowerCase()
      const skill = (invokeSkills ?? []).find(s => s.name.toLowerCase() === skillName)
      if (!skill || !skill.sections) return []
      if (!partial) return skill.sections.map(s => ({ name: s, desc: '' }))
      return skill.sections.filter(s => s.toLowerCase().startsWith(partial)).map(s => ({ name: s, desc: '' }))
    }
    if (isSkillCompletion) {
      const partial = (parts.length >= 2 ? (parts[1] || '') : '').toLowerCase()
      if (!partial) return invokeSkills ?? []
      return (invokeSkills ?? []).filter(s => s.name.toLowerCase().startsWith(partial))
    }
    return filterSlashCommands(firstWord)
  }, [showHints, isSkillCompletion, isSectionCompletion, firstWord, parts, invokeSkills])

  useEffect(() => {
    setSelectedHintIdx(0)
  }, [firstWord, showHints])

  // raw-byte chord parsing: terminals send option+arrows / option+backspace as
  // escape sequences that ink does not always normalize into `key.meta` flags.
  // these literal strings cover xterm/iterm/macos-terminal/ghostty/kitty.
  const RAW_WORD_LEFT = '\x1b[1;3D'   // option + left
  const RAW_WORD_RIGHT = '\x1b[1;3C'  // option + right
  const RAW_WORD_LEFT_CTRL = '\x1b[1;5D' // ctrl + left
  const RAW_WORD_RIGHT_CTRL = '\x1b[1;5C' // ctrl + right
  const RAW_DEL_WORD = '\x1b\x7f'      // option + backspace
  const RAW_DEL_WORD_ALT = '\x17'      // ctrl + w
  const RAW_KILL_LINE = '\x0b'         // ctrl + k
  // esc-prefix modified-enter: legacy fallback for terminals without kitty
  const RAW_NEWLINE_ESC_CR = '\x1b\r'
  const RAW_NEWLINE_ESC_LF = '\x1b\n'

  useInput((input, key) => {
    if (isLoading) return

    // the raw-stdin tap already inserted the newline for this chord. ink
    // dispatches a return event for the same bytes a moment later; swallow
    // it so we don't also submit the buffer.
    if (key.return && ignoreNextReturnRef.current) {
      ignoreNextReturnRef.current = false
      return
    }

    // single-event modified-enter (shift / option / alt + enter): terminals
    // either set key.return + key.shift / key.meta, or deliver `\x1b\r` /
    // `\x1b\n` in one input string. checked before hint-commit so multi-line
    // input wins over slash autocomplete.
    const isNewlineChord =
      (key.return && (key.shift || key.meta)) ||
      input === RAW_NEWLINE_ESC_CR ||
      input === RAW_NEWLINE_ESC_LF
    if (isNewlineChord) {
      if (escapeTimerRef.current) { clearTimeout(escapeTimerRef.current); escapeTimerRef.current = null }
      bufferRef.current = insertText(bufferRef.current, cursorRef.current, '\n')
      cursorRef.current += 1
      scheduleDisplayUpdate()
      return
    }

    // split-event chord: escape pending + return arriving means modified-enter,
    // not "clear then submit". any other key fires the deferred clear first.
    if (key.return && escapeTimerRef.current) {
      clearTimeout(escapeTimerRef.current)
      escapeTimerRef.current = null
      bufferRef.current = insertText(bufferRef.current, cursorRef.current, '\n')
      cursorRef.current += 1
      scheduleDisplayUpdate()
      return
    }
    if (escapeTimerRef.current && !key.escape) {
      clearTimeout(escapeTimerRef.current)
      escapeTimerRef.current = null
      clearBufferNow()
      // fall through: the current input (whatever it was) still needs to
      // be processed against the now-empty buffer
    }

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
      if (key.tab || key.return) {
        // recompute matches from the live buffer so a fast typist who presses
        // enter before the next render tick lands on the right hint
        const liveText = bufferRef.current.every(s => s.kind === 'text')
          ? bufferRef.current.map(s => (s as { chars: string }).chars).join('')
          : ''
        const liveParts = liveText.split(/\s+/)
        const liveFirst = liveParts[0] ?? ''
        const liveIsSkillCompletion = liveFirst === '/run' && liveParts.length <= 2
        const liveIsSectionCompletion = liveFirst === '/run' && liveParts.length >= 3
        const liveIsCmdCompletion = liveText.startsWith('/') && !liveText.includes(' ') && liveParts.length === 1 && !liveIsSkillCompletion
        const liveShowHints = liveIsCmdCompletion || liveIsSkillCompletion || liveIsSectionCompletion
        let liveMatches: SlashCommandSpec[]

        if (liveIsSectionCompletion) {
          const skillName = (liveParts[1] || '').toLowerCase()
          const partial = (liveParts[2] || '').toLowerCase()
          const skill = (invokeSkills ?? []).find(s => s.name.toLowerCase() === skillName)
          if (skill && skill.sections) {
            liveMatches = !partial
              ? skill.sections.map(s => ({ name: s, desc: '' }))
              : skill.sections.filter(s => s.toLowerCase().startsWith(partial)).map(s => ({ name: s, desc: '' }))
          } else {
            liveMatches = []
          }
        } else if (liveIsSkillCompletion) {
          const partial = liveParts.length >= 2 ? (liveParts[1] || '').toLowerCase() : ''
          const pool = invokeSkills ?? []
          liveMatches = !partial ? pool : pool.filter(s => s.name.toLowerCase().startsWith(partial))
        } else {
          liveMatches = liveShowHints ? filterSlashCommands(liveFirst) : []
        }

        const selected = liveMatches[selectedHintIdx] ?? liveMatches[0]
        if (selected) {
          const newText = liveIsSectionCompletion
            ? `/run ${liveParts[1]} ${selected.name} `
            : liveIsSkillCompletion
              ? `/run ${selected.name} `
              : selected.name + (selected.args ? ' ' : '')
          if (liveText !== newText) {
            bufferRef.current = [{ kind: 'text', chars: newText }]
            cursorRef.current = newText.length
            flushNow()
            return
          }
        }
        if (key.tab) return
        // enter with nothing to commit: fall through to submit
      }
    }

    if (key.return) {
      const text = expand(bufferRef.current, pasteStoreRef.current).trim()
      if (text) {
        onSubmit(text)
        bufferRef.current = createBuffer()
        pasteStoreRef.current = new Map()
        cursorRef.current = 0
        flushNow()
      }
      return
    }

    // word-back deletion: option+backspace and ctrl+w
    if (input === RAW_DEL_WORD || input === RAW_DEL_WORD_ALT || (key.ctrl && input === 'w')) {
      const { buf, pos } = deleteWordBack(bufferRef.current, cursorRef.current)
      bufferRef.current = buf
      cursorRef.current = pos
      scheduleDisplayUpdate()
      return
    }

    // kill-to-end: ctrl+k
    if (input === RAW_KILL_LINE || (key.ctrl && input === 'k')) {
      bufferRef.current = killToEnd(bufferRef.current, cursorRef.current)
      scheduleDisplayUpdate()
      return
    }

    // word-level cursor motion: option+arrows or ctrl+arrows
    if (input === RAW_WORD_LEFT || input === RAW_WORD_LEFT_CTRL || (key.meta && key.leftArrow)) {
      cursorRef.current = wordBoundaryLeft(bufferRef.current, cursorRef.current)
      scheduleDisplayUpdate()
      return
    }
    if (input === RAW_WORD_RIGHT || input === RAW_WORD_RIGHT_CTRL || (key.meta && key.rightArrow)) {
      cursorRef.current = wordBoundaryRight(bufferRef.current, cursorRef.current)
      scheduleDisplayUpdate()
      return
    }

    if (key.backspace || key.delete) {
      const { buf, pos } = deleteBack(bufferRef.current, cursorRef.current)
      bufferRef.current = buf
      cursorRef.current = pos
      scheduleDisplayUpdate()
      return
    }

    // ctrl+u: immediate clear (no chord ambiguity, no need to defer)
    if (key.ctrl && input === 'u') {
      clearBufferNow()
      return
    }

    // escape arriving on its own: schedule the clear so a follow-up return
    // (the second half of split-event modified-enter) can re-purpose it as a
    // newline insertion. if the timer expires without a chord, clear fires.
    if (key.escape) {
      if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current)
      escapeTimerRef.current = setTimeout(() => {
        clearBufferNow()
        escapeTimerRef.current = null
      }, 50)
      return
    }

    if (key.leftArrow) {
      cursorRef.current = Math.max(0, cursorRef.current - 1)
      scheduleDisplayUpdate()
      return
    }
    if (key.rightArrow) {
      cursorRef.current = Math.min(flatLength(bufferRef.current), cursorRef.current + 1)
      scheduleDisplayUpdate()
      return
    }

    if (key.ctrl && input === 'a') {
      cursorRef.current = 0
      scheduleDisplayUpdate()
      return
    }
    if (key.ctrl && input === 'e') {
      cursorRef.current = flatLength(bufferRef.current)
      scheduleDisplayUpdate()
      return
    }

    // vertical cursor movement: up/down move the cursor between buffer lines
    // when no slash-hint dropdown is showing. hint-nav is handled in the
    // matches.length > 0 branch above; the two paths are mutually exclusive
    // because hints only ever fire on a single-line buffer starting with `/`.
    if (key.upArrow) {
      cursorRef.current = moveCursorUp(bufferRef.current, cursorRef.current)
      scheduleDisplayUpdate()
      return
    }
    if (key.downArrow) {
      cursorRef.current = moveCursorDown(bufferRef.current, cursorRef.current)
      scheduleDisplayUpdate()
      return
    }

    // ignore other control sequences
    if (key.ctrl || key.meta || key.tab) {
      return
    }

    // any remaining input is content to insert. a large single-event chunk is
    // treated as a paste and folded into a pill so the buffer + render path
    // never carries multi-kilobyte strings.
    if (input.length >= PASTE_PILL_THRESHOLD) {
      bufferRef.current = insertPill(bufferRef.current, cursorRef.current, input, pasteStoreRef.current)
      cursorRef.current += 1   // pill is one atom
      flushNow()
      return
    }

    bufferRef.current = insertText(bufferRef.current, cursorRef.current, input)
    cursorRef.current += input.length
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

  // shell mode: first segment starts with '!'. visually hide that one char
  // (so the prompt char does double duty) but keep it in the buffer.
  const firstSeg = displayBuf[0]
  const isShell = firstSeg?.kind === 'text' && firstSeg.chars.startsWith('!')
  const isPlanInput = inPlanMode && !isShell
  const promptChar = isShell ? '$' : (isPlanInput ? '◇' : '◆')
  const accent = isShell ? theme.warning : (isPlanInput ? theme.planMode : theme.prompt)
  // build the visible segment list. in shell mode, the first '!' character
  // is sliced off so it never reaches the renderer.
  const visibleSegs: Segment[] = isShell
    ? [
        { kind: 'text', chars: (firstSeg as { chars: string }).chars.slice(1) },
        ...displayBuf.slice(1),
      ]
    : displayBuf
  const initialVisibleCursor = isShell ? Math.max(0, cursorPos - 1) : cursorPos

  // viewport: when the buffer exceeds the configured max lines, render a
  // window around the cursor instead of the whole buffer. above and below
  // the window, dim indicators show how many lines are hidden.
  const maxLines = loadConfig().tuning.input_viewport_max_lines
  const total = totalLines(visibleSegs)
  let renderSegs = visibleSegs
  let renderCursor = initialVisibleCursor
  let hiddenAbove = 0
  let hiddenBelow = 0
  if (total > maxLines) {
    const { line: curLine } = flatToLineCol(visibleSegs, initialVisibleCursor)
    // center the cursor in the viewport, clamped to buffer edges
    const start = Math.max(0, Math.min(total - maxLines, curLine - Math.floor(maxLines / 2)))
    const end = start + maxLines
    const sliced = sliceToLines(visibleSegs, start, end, initialVisibleCursor)
    renderSegs = sliced.buf
    renderCursor = sliced.cursor
    hiddenAbove = start
    hiddenBelow = total - end
  }

  const renderAtomLen = renderSegs.reduce(
    (acc, s) => acc + (s.kind === 'text' ? s.chars.length : 1),
    0,
  )
  const cursorOnEnd = renderCursor >= renderAtomLen
  const bufferEmpty = visibleSegs.length === 0

  return (
    <Box marginTop={1} flexDirection="column">
      {isShell && (
        <Text color={theme.textMuted}>  shell mode (delete the `!` to exit, or esc to clear. output stays here, the model won't see it)</Text>
      )}
      {isPlanInput && (
        <Text color={theme.planMode}>  plan mode <Text color={theme.textMuted}>(type /exec-plan to execute, /cancel-plan to abandon, or push back to revise)</Text></Text>
      )}
      {hiddenAbove > 0 && (
        <Text color={theme.textMuted}>  ↑ {hiddenAbove} more line{hiddenAbove === 1 ? '' : 's'} above</Text>
      )}
      <Box borderStyle="round" borderColor={accent} paddingX={1}>
        {/* the prompt char, buffer, and cursor live inside one wrappable Text
            run so ink's wrap calculation treats them as a single inline flow.
            siblings would let ink wrap the buffer alone, eating the space
            between the prompt char and the first wrapped line. ink renders
            literal '\n' inside Text as a line break, which is what makes
            multi-line input render correctly inside the bordered box. */}
        <Text wrap="wrap" color={isShell ? theme.warning : undefined}>
          <Text color={accent}>{promptChar} </Text>
          {renderSegments(renderSegs, renderCursor)}
          {cursorOnEnd && <Text inverse> </Text>}
          {bufferEmpty && <Text color={theme.textMuted}>ask anything...   <Text dimColor>(shift+enter for newline)</Text></Text>}
        </Text>
      </Box>
      {hiddenBelow > 0 && (
        <Text color={theme.textMuted}>  ↓ {hiddenBelow} more line{hiddenBelow === 1 ? '' : 's'} below</Text>
      )}
      <SlashHints matches={matches} selectedIdx={selectedHintIdx} />
    </Box>
  )
})

/**
 * render the buffer as a flat list of Text elements, with the cursor position
 * (in flat-atom coordinates) inverted. text segments are split around the
 * cursor; pills render as a single inverted unit when the cursor sits on them.
 */
function renderSegments(segs: Segment[], cursor: number): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let pos = 0
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]!
    if (seg.kind === 'text') {
      const len = seg.chars.length
      if (cursor >= pos && cursor < pos + len) {
        const off = cursor - pos
        const before = seg.chars.slice(0, off)
        const ch = seg.chars[off] ?? ' '
        const after = seg.chars.slice(off + 1)
        if (before) nodes.push(<Text key={`t-${i}-pre`}>{before}</Text>)
        if (ch === '\n') {
          // cursor on a newline: show an inverted-space marker so the cursor
          // is visible at end of line, then emit the literal newline so the
          // line break still happens. inverting the newline directly would
          // either swallow the break or render an empty inverted line.
          nodes.push(<Text key={`t-${i}-cur`} inverse> </Text>)
          nodes.push(<Text key={`t-${i}-nl`}>{'\n'}</Text>)
        } else {
          nodes.push(<Text key={`t-${i}-cur`} inverse>{ch}</Text>)
        }
        if (after) nodes.push(<Text key={`t-${i}-post`}>{after}</Text>)
      } else {
        nodes.push(<Text key={`t-${i}`}>{seg.chars}</Text>)
      }
      pos += len
    } else {
      const label = `[paste ${seg.size} chars]`
      const onPill = cursor === pos
      nodes.push(
        <Text key={`p-${seg.id}`} color={theme.prompt} dimColor inverse={onPill}>
          {label}
        </Text>,
      )
      pos += 1
    }
  }
  return nodes
}
