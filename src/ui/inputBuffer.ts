/**
 * segment-based input buffer. text runs interleave with paste pills; pill
 * content lives in a side store so the rendered buffer stays cheap on huge
 * pastes. pills are atomic for cursor nav, deletion, and word boundaries.
 * pure module: every op returns a new buffer; callers manage the side store.
 */
import { randomUUID } from 'crypto'

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
  for (const seg of buf) n += seg.kind === 'text' ? seg.chars.length : 1
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
    const len = seg.kind === 'text' ? seg.chars.length : 1
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
      next.push({ kind: 'text', chars: seg.chars.slice(0, offset) + str + seg.chars.slice(offset) })
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
      next.push({ kind: 'text', chars: seg.chars.slice(0, offset) }, pill, { kind: 'text', chars: seg.chars.slice(offset) })
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
            next.push({ kind: 'text', chars: prev.chars.slice(0, -1) })
          } // pill: just drop it
          removed = 1
        } else {
          next.push({ kind: 'text', chars: seg.chars.slice(0, offset - 1) + seg.chars.slice(offset) })
          removed = 1
        }
      } else {
        // pill at segIdx, offset can be 0 or 1
        if (offset === 0) {
          // cursor is BEFORE this pill: deletion target is in previous segment
          const prev = next.pop()
          if (!prev) { next.push(seg); break }
          if (prev.kind === 'text') {
            next.push({ kind: 'text', chars: prev.chars.slice(0, -1) })
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
      if (offset >= seg.chars.length) {
        // boundary: cursor is at end of this text segment, target is the next segment's first atom
        next.push(seg)
        const target = buf[i + 1]
        if (target?.kind === 'text') {
          next.push({ kind: 'text', chars: target.chars.slice(1) })
          i++ // skip the consumed next segment
        } else if (target?.kind === 'pill') {
          // skip the pill (delete it)
          i++
        }
      } else {
        next.push({ kind: 'text', chars: seg.chars.slice(0, offset) + seg.chars.slice(offset + 1) })
      }
    } else {
      // pill: deletion target depends on offset
      if (offset === 1) {
        // cursor right after pill, target is next segment's first atom
        next.push(seg)
        const target = buf[i + 1]
        if (target?.kind === 'text') {
          next.push({ kind: 'text', chars: target.chars.slice(1) })
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
      off = prev.kind === 'text' ? prev.chars.length : 1
      continue
    }
    const ch = cur.chars[off - 1]!
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
    if (off >= cur.chars.length) {
      i += 1
      off = 0
      continue
    }
    const ch = cur.chars[off]!
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
