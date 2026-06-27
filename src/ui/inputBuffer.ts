/**
 * segment-based input buffer. text runs interleave with paste pills; pill
 * content lives in a side store so the rendered buffer stays cheap on huge
 * pastes. pills are atomic for cursor nav, deletion, and word boundaries.
 * pure module: every op returns a new buffer; callers manage the side store.
 */
import { randomUUID } from 'crypto'

// code-point-aware string ops. one atom is one Unicode code point, not one
// UTF-16 code unit: an emoji / astral char is a surrogate pair (2 units) but a
// single atom. slicing or indexing by code unit would split a pair into lone
// surrogates that corrupt the buffer and get submitted to the model.
const cp = (s: string): string[] => Array.from(s)
export const clen = (s: string): number => cp(s).length
export const cslice = (s: string, a?: number, b?: number): string => cp(s).slice(a, b).join('')

export interface TextSegment {
  kind: 'text'
  chars: string
}

export interface PillSegment {
  kind: 'pill'
  id: string
  /** original character count of the pasted content (for the rendered label). */
  size: number
}

export type Segment = TextSegment | PillSegment

/**
 * a buffer is just a list of segments. an empty buffer is the empty list;
 * an all-text buffer is one text segment.
 */
export type Buffer = Segment[]

/** content store: pill id → original pasted text. */
export type PasteStore = Map<string, string>

export function createBuffer(): Buffer {
  return []
}

/** total length in atoms: text chars + 1 per pill. */
export function flatLength(buf: Buffer): number {
  let n = 0
  for (const seg of buf) n += seg.kind === 'text' ? clen(seg.chars) : 1
  return n
}

/**
 * map a flat position to (segment index, offset within segment). out-of-range
 * clamps. boundary positions return the leading segment with offset === its
 * length, making insertions at seams deterministic.
 */
export function locate(buf: Buffer, pos: number): { segIdx: number; offset: number } {
  const clamped = Math.max(0, Math.min(pos, flatLength(buf)))
  let consumed = 0
  for (let i = 0; i < buf.length; i++) {
    const seg = buf[i]!
    const len = seg.kind === 'text' ? clen(seg.chars) : 1
    if (clamped <= consumed + len) {
      return { segIdx: i, offset: clamped - consumed }
    }
    consumed += len
  }
  // empty buffer: position 0, no segments
  return { segIdx: buf.length, offset: 0 }
}

/**
 * normalize adjacent text segments into one and drop empty text segments.
 * called after every mutation so the segment list stays minimal.
 */
function normalize(buf: Buffer): Buffer {
  const out: Buffer = []
  for (const seg of buf) {
    if (seg.kind === 'text' && seg.chars.length === 0) continue
    const last = out[out.length - 1]
    if (last && last.kind === 'text' && seg.kind === 'text') {
      out[out.length - 1] = { kind: 'text', chars: last.chars + seg.chars }
    } else {
      out.push(seg)
    }
  }
  return out
}

/** insert literal text at the given flat position. */
export function insertText(buf: Buffer, pos: number, str: string): Buffer {
  if (!str) return buf
  if (buf.length === 0) return [{ kind: 'text', chars: str }]

  const { segIdx, offset } = locate(buf, pos)
  const next: Buffer = []
  for (let i = 0; i < buf.length; i++) {
    const seg = buf[i]!
    if (i !== segIdx) { next.push(seg); continue }
    if (seg.kind === 'text') {
      next.push({ kind: 'text', chars: cslice(seg.chars, 0, offset) + str + cslice(seg.chars, offset) })
    } else {
      // pill at this index: insert before or after depending on offset
      if (offset === 0) {
        next.push({ kind: 'text', chars: str }, seg)
      } else {
        next.push(seg, { kind: 'text', chars: str })
      }
    }
  }
  // edge case: pos sits at the very end and the loop placed us past the
  // last segment without inserting anything yet.
  if (segIdx === buf.length) {
    next.push({ kind: 'text', chars: str })
  }
  return normalize(next)
}

/**
 * register a pasted blob in the store and insert a pill that references it.
 * returns the new buffer; mutates the store. id is generated unless provided
 * (the id override is exposed for tests; production callers omit it).
 */
export function insertPill(
  buf: Buffer,
  pos: number,
  content: string,
  store: PasteStore,
  idOverride?: string,
): Buffer {
  const id = idOverride ?? randomUUID()
  store.set(id, content)
  const pill: PillSegment = { kind: 'pill', id, size: content.length }

  if (buf.length === 0) return [pill]

  const { segIdx, offset } = locate(buf, pos)
  const next: Buffer = []
  for (let i = 0; i < buf.length; i++) {
    const seg = buf[i]!
    if (i !== segIdx) { next.push(seg); continue }
    if (seg.kind === 'text') {
      // split the text segment: head, pill, tail
      next.push({ kind: 'text', chars: cslice(seg.chars, 0, offset) }, pill, { kind: 'text', chars: cslice(seg.chars, offset) })
    } else {
      if (offset === 0) next.push(pill, seg)
      else next.push(seg, pill)
    }
  }
  if (segIdx === buf.length) {
    next.push(pill)
  }
  return normalize(next)
}

/** delete one atom to the left of pos. returns new buffer + new cursor pos. */
export function deleteBack(buf: Buffer, pos: number): { buf: Buffer; pos: number } {
  if (pos <= 0 || buf.length === 0) return { buf, pos: 0 }
  const { segIdx, offset } = locate(buf, pos)

  const next: Buffer = []
  let removed = 0
  for (let i = 0; i < buf.length; i++) {
    const seg = buf[i]!
    if (i === segIdx) {
      if (seg.kind === 'text') {
        if (offset === 0) {
          // boundary: deletion target is the LAST atom of the previous segment.
          // pop the last segment from `next` and re-push it shortened.
          const prev = next.pop()
          if (!prev) { next.push(seg); break }
          if (prev.kind === 'text') {
            next.push({ kind: 'text', chars: cslice(prev.chars, 0, -1) })
          } // pill: just drop it
          removed = 1
        } else {
          next.push({ kind: 'text', chars: cslice(seg.chars, 0, offset - 1) + cslice(seg.chars, offset) })
          removed = 1
        }
      } else {
        // pill at segIdx, offset can be 0 or 1
        if (offset === 0) {
          // cursor is BEFORE this pill: deletion target is in previous segment
          const prev = next.pop()
          if (!prev) { next.push(seg); break }
          if (prev.kind === 'text') {
            next.push({ kind: 'text', chars: cslice(prev.chars, 0, -1) })
          }
          next.push(seg)
          removed = 1
        } else {
          // cursor is AFTER this pill: delete the whole pill
          removed = 1
          continue
        }
      }
    } else {
      next.push(seg)
    }
  }
  return { buf: normalize(next), pos: pos - removed }
}

/** delete one atom to the right of pos. returns new buffer; pos unchanged. */
export function deleteForward(buf: Buffer, pos: number): { buf: Buffer; pos: number } {
  if (pos >= flatLength(buf) || buf.length === 0) return { buf, pos }
  const { segIdx, offset } = locate(buf, pos)

  const next: Buffer = []
  for (let i = 0; i < buf.length; i++) {
    const seg = buf[i]!
    if (i !== segIdx) { next.push(seg); continue }
    if (seg.kind === 'text') {
      if (offset >= clen(seg.chars)) {
        // boundary: cursor is at end of this text segment, target is the next segment's first atom
        next.push(seg)
        const target = buf[i + 1]
        if (target?.kind === 'text') {
          next.push({ kind: 'text', chars: cslice(target.chars, 1) })
          i++ // skip the consumed next segment
        } else if (target?.kind === 'pill') {
          // skip the pill (delete it)
          i++
        }
      } else {
        next.push({ kind: 'text', chars: cslice(seg.chars, 0, offset) + cslice(seg.chars, offset + 1) })
      }
    } else {
      // pill: deletion target depends on offset
      if (offset === 1) {
        // cursor right after pill, target is next segment's first atom
        next.push(seg)
        const target = buf[i + 1]
        if (target?.kind === 'text') {
          next.push({ kind: 'text', chars: cslice(target.chars, 1) })
          i++
        } else if (target?.kind === 'pill') {
          i++
        }
      } else {
        // cursor at offset 0 of pill: delete the whole pill
        continue
      }
    }
  }
  return { buf: normalize(next), pos }
}

/** flat string with every pill expanded to its stored content. */
export function expand(buf: Buffer, store: PasteStore): string {
  let out = ''
  for (const seg of buf) {
    out += seg.kind === 'text' ? seg.chars : (store.get(seg.id) ?? '')
  }
  return out
}

/**
 * nearest word boundary at or before pos. pills are atomic: walking left over
 * a pill is one step. word = run of \w+ surrounded by anything else.
 */
export function wordBoundaryLeft(buf: Buffer, pos: number): number {
  if (pos <= 0) return 0
  const { segIdx, offset } = locate(buf, pos)
  const seg = buf[segIdx]

  if (seg?.kind === 'pill') {
    // anywhere on a pill, left moves to before the pill
    return pos - offset
  }

  // walk left through text, possibly crossing pills (each pill = one atom step)
  let i = segIdx
  let off = offset
  let cursor = pos
  let inWord = false

  while (cursor > 0) {
    const cur = buf[i]
    if (!cur) break
    if (cur.kind === 'pill') {
      // hitting a pill from the right: stop right after the pill
      return cursor
    }
    if (off === 0) {
      i -= 1
      if (i < 0) return 0
      const prev = buf[i]!
      off = prev.kind === 'text' ? clen(prev.chars) : 1
      continue
    }
    const ch = cp(cur.chars)[off - 1]!
    const isWordChar = /\w/.test(ch)
    if (isWordChar) inWord = true
    else if (inWord) return cursor
    cursor -= 1
    off -= 1
  }
  return cursor
}

/** symmetric right-walking word boundary. */
export function wordBoundaryRight(buf: Buffer, pos: number): number {
  const total = flatLength(buf)
  if (pos >= total) return total
  const { segIdx, offset } = locate(buf, pos)
  const seg = buf[segIdx]

  if (seg?.kind === 'pill') {
    // anywhere on a pill, right moves to after the pill
    return pos + (1 - offset)
  }

  let i = segIdx
  let off = offset
  let cursor = pos
  let inWord = false

  while (cursor < total) {
    const cur = buf[i]
    if (!cur) break
    if (cur.kind === 'pill') {
      // pills are atomic for word navigation: cross the pill in a single step.
      // the left walker has the symmetric rule (lands at the position past the
      // pill in one move). returning unchanged here would leave the cursor
      // pinned at the pill seam, which is not what readline-style nav expects.
      return cursor + 1
    }
    if (off >= clen(cur.chars)) {
      i += 1
      off = 0
      continue
    }
    const ch = cp(cur.chars)[off]!
    const isWordChar = /\w/.test(ch)
    if (isWordChar) inWord = true
    else if (inWord) return cursor
    cursor += 1
    off += 1
  }
  return cursor
}

/** delete the run from word-boundary-left to pos. returns updated buf + new pos. */
export function deleteWordBack(buf: Buffer, pos: number): { buf: Buffer; pos: number } {
  const target = wordBoundaryLeft(buf, pos)
  if (target >= pos) return { buf, pos }
  // delete one atom at a time from pos back to target. simple, slow on huge
  // ranges but a typical word is <20 chars.
  let cur = pos
  let working = buf
  while (cur > target) {
    const step = deleteBack(working, cur)
    working = step.buf
    cur = step.pos
  }
  return { buf: working, pos: cur }
}

/** delete from pos to end-of-buffer (ctrl+k). */
export function killToEnd(buf: Buffer, pos: number): Buffer {
  const total = flatLength(buf)
  if (pos >= total) return buf
  let working = buf
  let n = total - pos
  while (n-- > 0) {
    const step = deleteForward(working, pos)
    working = step.buf
  }
  return working
}

/** clear the buffer entirely. */
export function clearBuffer(): Buffer {
  return []
}

/** total logical lines (count of \n + 1; minimum 1). */
export function totalLines(buf: Buffer): number {
  let n = 1
  for (const seg of buf) {
    if (seg.kind === 'text') {
      for (const ch of cp(seg.chars)) {
        if (ch === '\n') n++
      }
    }
  }
  return n
}

/** map a flat cursor position to (line, column). pills count as one atom on
 *  their line. \n advances line and resets col to 0. */
export function flatToLineCol(buf: Buffer, pos: number): { line: number; col: number } {
  let line = 0
  let col = 0
  let consumed = 0
  for (const seg of buf) {
    if (consumed >= pos) return { line, col }
    if (seg.kind === 'text') {
      for (const ch of cp(seg.chars)) {
        if (consumed >= pos) return { line, col }
        if (ch === '\n') { line++; col = 0 } else { col++ }
        consumed++
      }
    } else {
      if (consumed >= pos) return { line, col }
      col++
      consumed++
    }
  }
  return { line, col }
}

/** inverse of flatToLineCol. if the target line is shorter than targetCol,
 *  returns the end of that line. */
export function lineColToFlat(buf: Buffer, targetLine: number, targetCol: number): number {
  let line = 0
  let col = 0
  let pos = 0
  for (const seg of buf) {
    if (seg.kind === 'text') {
      for (const ch of cp(seg.chars)) {
        if (line === targetLine && col >= targetCol) return pos
        if (line === targetLine && ch === '\n') return pos
        if (line > targetLine) return pos
        if (ch === '\n') { line++; col = 0 } else { col++ }
        pos++
      }
    } else {
      if (line === targetLine && col >= targetCol) return pos
      if (line > targetLine) return pos
      col++
      pos++
    }
  }
  return pos
}

/** one line up, preserving column. no-op on line 0. */
export function moveCursorUp(buf: Buffer, pos: number): number {
  const { line, col } = flatToLineCol(buf, pos)
  if (line === 0) return pos
  return lineColToFlat(buf, line - 1, col)
}

/** one line down, preserving column. no-op on the last line. */
export function moveCursorDown(buf: Buffer, pos: number): number {
  const { line, col } = flatToLineCol(buf, pos)
  if (line >= totalLines(buf) - 1) return pos
  return lineColToFlat(buf, line + 1, col)
}

/** slice the buffer to a line range [startLine, endLine). returns the
 *  sub-buffer plus the cursor position adjusted into its atom space. used by
 *  the input renderer to render a viewport over a tall multi-line buffer. */
export function sliceToLines(
  buf: Buffer,
  startLine: number,
  endLine: number,
  cursor: number,
): { buf: Buffer; cursor: number } {
  const result: Segment[] = []
  let line = 0
  let consumed = 0
  let cursorDropped = 0

  for (const seg of buf) {
    if (line >= endLine) break
    if (seg.kind === 'text') {
      let chunk = ''
      for (const ch of cp(seg.chars)) {
        if (line < startLine) {
          if (consumed < cursor) cursorDropped++
        } else if (line < endLine) {
          chunk += ch
        }
        consumed++
        if (ch === '\n') line++
        if (line >= endLine) break
      }
      // drop a trailing \n: it counted toward advancing past the viewport's
      // last line; rendering it would add an extra blank line at the bottom.
      if (chunk.endsWith('\n')) chunk = chunk.slice(0, -1)
      if (chunk) result.push({ kind: 'text', chars: chunk })
    } else {
      if (line < startLine) {
        if (consumed < cursor) cursorDropped++
      } else if (line < endLine) {
        result.push(seg)
      }
      consumed++
    }
  }

  let cursorOut = Math.max(0, cursor - cursorDropped)
  const newLen = result.reduce((n, s) => n + (s.kind === 'text' ? clen(s.chars) : 1), 0)
  if (cursorOut > newLen) cursorOut = newLen
  return { buf: result, cursor: cursorOut }
}
