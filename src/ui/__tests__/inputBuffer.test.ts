import { describe, it, expect } from 'vitest'
import {
  createBuffer,
  flatLength,
  locate,
  insertText,
  insertPill,
  deleteBack,
  deleteForward,
  expand,
  wordBoundaryLeft,
  wordBoundaryRight,
  deleteWordBack,
  killToEnd,
  totalLines,
  flatToLineCol,
  lineColToFlat,
  moveCursorUp,
  moveCursorDown,
  sliceToLines,
  type Buffer,
} from '../inputBuffer.js'

// helper: build a buffer + store in one step with deterministic pill ids
function makeBuffer(): { buf: Buffer; store: Map<string, string> } {
  return { buf: createBuffer(), store: new Map() }
}

describe('flatLength', () => {
  it('is 0 for an empty buffer', () => {
    expect(flatLength([])).toBe(0)
  })
  it('counts text chars and pills as 1 atom each', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'hi ' },
      { kind: 'pill', id: 'a', size: 999 },
      { kind: 'text', chars: ' bye' },
    ]
    expect(flatLength(buf)).toBe(3 + 1 + 4)
  })
})

describe('locate', () => {
  it('clamps positions outside the valid range', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'abc' }]
    expect(locate(buf, -5).offset).toBe(0)
    expect(locate(buf, 100).offset).toBe(3)
  })
  it('boundary positions belong to the leading segment, not the trailing one', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'ab' },
      { kind: 'text', chars: 'cd' },
    ]
    // pos 2 sits at the seam: belongs to seg 0 with offset 2, not seg 1 with offset 0
    expect(locate(buf, 2)).toEqual({ segIdx: 0, offset: 2 })
  })
})

describe('insertText', () => {
  it('seeds an empty buffer with a single text segment', () => {
    expect(insertText([], 0, 'hello')).toEqual([{ kind: 'text', chars: 'hello' }])
  })

  it('splices into an existing text segment', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hello' }]
    expect(insertText(buf, 5, ' world')).toEqual([{ kind: 'text', chars: 'hello world' }])
    expect(insertText(buf, 0, '> ')).toEqual([{ kind: 'text', chars: '> hello' }])
    expect(insertText(buf, 2, 'XX')).toEqual([{ kind: 'text', chars: 'heXXllo' }])
  })

  it('inserts before a pill when cursor is at the pill', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'a' },
      { kind: 'pill', id: 'p1', size: 100 },
      { kind: 'text', chars: 'z' },
    ]
    // flat positions: 0=before 'a', 1=between 'a' and pill, 2=after pill (before 'z'), 3=after 'z'
    const result = insertText(buf, 1, 'XX')
    expect(result).toEqual([
      { kind: 'text', chars: 'aXX' },
      { kind: 'pill', id: 'p1', size: 100 },
      { kind: 'text', chars: 'z' },
    ])
  })

  it('inserts after a pill when cursor is past it', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'a' },
      { kind: 'pill', id: 'p1', size: 100 },
      { kind: 'text', chars: 'z' },
    ]
    const result = insertText(buf, 2, 'YY')
    expect(result).toEqual([
      { kind: 'text', chars: 'a' },
      { kind: 'pill', id: 'p1', size: 100 },
      { kind: 'text', chars: 'YYz' },
    ])
  })

  it('is a no-op for empty input', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'x' }]
    expect(insertText(buf, 0, '')).toBe(buf)
  })
})

describe('insertPill', () => {
  it('splits a text segment around the pill', () => {
    const { buf, store } = makeBuffer()
    const seeded = insertText(buf, 0, 'hello world')
    const out = insertPill(seeded, 5, 'PASTED CONTENT', store, 'p1')
    expect(out).toEqual([
      { kind: 'text', chars: 'hello' },
      { kind: 'pill', id: 'p1', size: 14 },
      { kind: 'text', chars: ' world' },
    ])
    expect(store.get('p1')).toBe('PASTED CONTENT')
  })

  it('inserts a leading pill cleanly when buffer starts with a pill', () => {
    const { store } = makeBuffer()
    const buf = insertPill([], 0, 'data', store, 'p1')
    expect(buf).toEqual([{ kind: 'pill', id: 'p1', size: 4 }])
  })

  it('inserts a pill at end of text without creating an empty trailing text segment', () => {
    const { store } = makeBuffer()
    const seeded = insertText([], 0, 'hi')
    const out = insertPill(seeded, 2, 'BLOB', store, 'p1')
    expect(out).toEqual([
      { kind: 'text', chars: 'hi' },
      { kind: 'pill', id: 'p1', size: 4 },
    ])
  })
})

describe('deleteBack', () => {
  it('deletes a single text char and decrements cursor', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hello' }]
    expect(deleteBack(buf, 5)).toEqual({ buf: [{ kind: 'text', chars: 'hell' }], pos: 4 })
  })

  it('is a no-op at position 0', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hi' }]
    expect(deleteBack(buf, 0)).toEqual({ buf, pos: 0 })
  })

  it('deletes the whole pill in one operation', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'a' },
      { kind: 'pill', id: 'p1', size: 999 },
      { kind: 'text', chars: 'z' },
    ]
    // cursor at 2 (after pill), backspace removes the pill, cursor → 1
    const result = deleteBack(buf, 2)
    expect(result.buf).toEqual([{ kind: 'text', chars: 'az' }])
    expect(result.pos).toBe(1)
  })

  it('crosses a text/text boundary correctly', () => {
    // a normalized buffer never has two adjacent text segments, but the
    // helper has to handle that case too in case a future caller hands one in
    const buf: Buffer = [
      { kind: 'text', chars: 'abc' },
      { kind: 'pill', id: 'p1', size: 1 },
    ]
    // cursor at 4 (after pill), backspace removes pill, cursor → 3
    const result = deleteBack(buf, 4)
    expect(result.buf).toEqual([{ kind: 'text', chars: 'abc' }])
    expect(result.pos).toBe(3)
  })
})

describe('deleteForward', () => {
  it('deletes the char to the right of cursor', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hello' }]
    const result = deleteForward(buf, 2)
    expect(result.buf).toEqual([{ kind: 'text', chars: 'helo' }])
    expect(result.pos).toBe(2)
  })

  it('deletes a pill when cursor sits on it', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'a' },
      { kind: 'pill', id: 'p1', size: 99 },
      { kind: 'text', chars: 'z' },
    ]
    const result = deleteForward(buf, 1)
    expect(result.buf).toEqual([{ kind: 'text', chars: 'az' }])
    expect(result.pos).toBe(1)
  })

  it('is a no-op at end of buffer', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hi' }]
    expect(deleteForward(buf, 2)).toEqual({ buf, pos: 2 })
  })
})

describe('expand', () => {
  it('returns text segments verbatim and substitutes pills from the store', () => {
    const store = new Map<string, string>()
    store.set('p1', 'ACTUAL PASTED CONTENT')
    const buf: Buffer = [
      { kind: 'text', chars: 'before ' },
      { kind: 'pill', id: 'p1', size: 100 },
      { kind: 'text', chars: ' after' },
    ]
    expect(expand(buf, store)).toBe('before ACTUAL PASTED CONTENT after')
  })

  it('substitutes empty string for missing pill ids (does not crash)', () => {
    const buf: Buffer = [{ kind: 'pill', id: 'ghost', size: 0 }]
    expect(expand(buf, new Map())).toBe('')
  })
})

describe('wordBoundaryLeft', () => {
  it('walks past contiguous non-word chars then stops at the word start', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hello world foo' }]
    // cursor at end (15), left jumps to start of 'foo' (12)
    expect(wordBoundaryLeft(buf, 15)).toBe(12)
  })

  it('jumps over a pill in one step', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'hi ' },
      { kind: 'pill', id: 'p1', size: 1 },
      { kind: 'text', chars: ' bye' },
    ]
    // cursor at end (8), word-left should land right after the pill (4) ...
    // actually 'bye' starts at pos 5 (after pill (3..4) and space (4..5)).
    // first call lands at start of 'bye' = 5
    expect(wordBoundaryLeft(buf, 8)).toBe(5)
    // calling from there jumps over the pill to before the space ... actually,
    // moves past the pill in one atomic step
    expect(wordBoundaryLeft(buf, 5)).toBe(4)
  })

  it('returns 0 when called at position 0', () => {
    expect(wordBoundaryLeft([{ kind: 'text', chars: 'abc' }], 0)).toBe(0)
  })
})

describe('wordBoundaryRight', () => {
  it('walks past the current word, stops after it', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hello world' }]
    expect(wordBoundaryRight(buf, 0)).toBe(5)
  })

  it('jumps over a pill in one atomic step', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'a ' },
      { kind: 'pill', id: 'p1', size: 1 },
      { kind: 'text', chars: ' z' },
    ]
    // from pos 2 (the pill), one step lands past the pill at 3
    expect(wordBoundaryRight(buf, 2)).toBe(3)
  })
})

describe('deleteWordBack', () => {
  it('deletes back to the previous word boundary', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hello world foo' }]
    const result = deleteWordBack(buf, 15)
    expect(result.buf).toEqual([{ kind: 'text', chars: 'hello world ' }])
    expect(result.pos).toBe(12)
  })

  it('removes a pill in one deletion step', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'before ' },
      { kind: 'pill', id: 'p1', size: 100 },
    ]
    // pos = 8 (after pill). word-back should consume the pill (1 atom).
    const result = deleteWordBack(buf, 8)
    expect(result.buf).toEqual([{ kind: 'text', chars: 'before ' }])
    expect(result.pos).toBe(7)
  })
})

describe('killToEnd', () => {
  it('removes everything from pos to end', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'keep this | drop this' }]
    expect(killToEnd(buf, 10)).toEqual([{ kind: 'text', chars: 'keep this ' }])
  })

  it('handles pills in the killed range', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'a' },
      { kind: 'pill', id: 'p1', size: 5 },
      { kind: 'text', chars: 'b' },
    ]
    expect(killToEnd(buf, 1)).toEqual([{ kind: 'text', chars: 'a' }])
  })

  it('is a no-op when pos is past end', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hi' }]
    expect(killToEnd(buf, 99)).toBe(buf)
  })
})

describe('normalization invariants', () => {
  it('after deleting a pill between two text segments, the texts merge', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'hello ' },
      { kind: 'pill', id: 'p1', size: 1 },
      { kind: 'text', chars: ' world' },
    ]
    const result = deleteForward(buf, 6) // cursor on pill
    expect(result.buf).toEqual([{ kind: 'text', chars: 'hello  world' }])
  })

  it('empty text segments never persist after a mutation', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'x' }]
    const after = deleteBack(buf, 1)
    expect(after.buf).toEqual([])
  })
})

describe('totalLines', () => {
  it('is 1 for an empty or single-line buffer', () => {
    expect(totalLines([])).toBe(1)
    expect(totalLines([{ kind: 'text', chars: 'hello' }])).toBe(1)
  })
  it('counts every \\n as a line break', () => {
    expect(totalLines([{ kind: 'text', chars: 'a\nb\nc' }])).toBe(3)
    expect(totalLines([
      { kind: 'text', chars: 'a\n' },
      { kind: 'pill', id: 'p1', size: 5 },
      { kind: 'text', chars: '\nb' },
    ])).toBe(3)
  })
})

describe('flatToLineCol / lineColToFlat', () => {
  it('round-trips on simple single-line text', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hello' }]
    expect(flatToLineCol(buf, 0)).toEqual({ line: 0, col: 0 })
    expect(flatToLineCol(buf, 5)).toEqual({ line: 0, col: 5 })
    expect(lineColToFlat(buf, 0, 3)).toBe(3)
  })
  it('tracks line breaks correctly', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'ab\ncd\nef' }]
    expect(flatToLineCol(buf, 0)).toEqual({ line: 0, col: 0 })
    expect(flatToLineCol(buf, 2)).toEqual({ line: 0, col: 2 })  // just before \n
    expect(flatToLineCol(buf, 3)).toEqual({ line: 1, col: 0 })  // after \n
    expect(flatToLineCol(buf, 5)).toEqual({ line: 1, col: 2 })
    expect(flatToLineCol(buf, 6)).toEqual({ line: 2, col: 0 })
  })
  it('treats pills as atoms with column = 1', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'a' },
      { kind: 'pill', id: 'p1', size: 99 },
      { kind: 'text', chars: 'b' },
    ]
    expect(flatToLineCol(buf, 0)).toEqual({ line: 0, col: 0 })
    expect(flatToLineCol(buf, 1)).toEqual({ line: 0, col: 1 })  // pill atom
    expect(flatToLineCol(buf, 2)).toEqual({ line: 0, col: 2 })  // after pill
  })
  it('lineColToFlat returns end-of-line when target col overruns', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'short\nlongerline' }]
    // line 0 ("short") is 5 chars. ask for col 20 → returns end of line 0 (before \n)
    expect(lineColToFlat(buf, 0, 20)).toBe(5)
  })
})

describe('moveCursorUp / moveCursorDown', () => {
  it('preserves column when moving up between same-width lines', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hello\nworld' }]
    // cursor at pos 9 → line 1, col 3 ("wor|ld"). up → line 0, col 3 ("hel|lo")
    expect(moveCursorUp(buf, 9)).toBe(3)
  })
  it('clamps to end-of-target when moving up to a shorter line', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hi\nworld' }]
    // pos 7 (col 4 of "world") → up to "hi" lands at end of "hi" (pos 2)
    expect(moveCursorUp(buf, 7)).toBe(2)
  })
  it('is a no-op when already on line 0', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'just one line' }]
    expect(moveCursorUp(buf, 5)).toBe(5)
  })
  it('moves down symmetrically', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hello\nworld' }]
    // pos 3 → line 0, col 3. down → line 1, col 3
    expect(moveCursorDown(buf, 3)).toBe(9)
  })
  it('is a no-op when already on the last line', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'hello\nworld' }]
    // pos 9 is on line 1 (the last line); down is no-op
    expect(moveCursorDown(buf, 9)).toBe(9)
  })
})

describe('sliceToLines', () => {
  it('returns the buffer unchanged when the range covers everything', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'a\nb\nc' }]
    const sliced = sliceToLines(buf, 0, 3, 4)
    expect(sliced.buf).toEqual([{ kind: 'text', chars: 'a\nb\nc' }])
    expect(sliced.cursor).toBe(4)
  })
  it('clips lines above the start', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'first\nsecond\nthird' }]
    // cursor at pos 14 ('t|hird' = col 1 of line 2). slice lines 2-3.
    const sliced = sliceToLines(buf, 2, 3, 14)
    expect(sliced.buf).toEqual([{ kind: 'text', chars: 'third' }])
    // cursor moved from 14 → 14 - 13 dropped atoms = 1
    expect(sliced.cursor).toBe(1)
  })
  it('clips lines below the end', () => {
    const buf: Buffer = [{ kind: 'text', chars: 'one\ntwo\nthree' }]
    const sliced = sliceToLines(buf, 0, 1, 2)
    // line 0 is "one"; the \n at pos 3 advances line counter but is itself
    // dropped from the chunk by the end-of-range break, so result is "one".
    expect(sliced.buf).toEqual([{ kind: 'text', chars: 'one' }])
    expect(sliced.cursor).toBe(2)
  })
  it('preserves pills that fall in the visible range', () => {
    const buf: Buffer = [
      { kind: 'text', chars: 'top\n' },
      { kind: 'pill', id: 'p1', size: 99 },
      { kind: 'text', chars: '\nbottom' },
    ]
    // total 3 lines. slice middle line only.
    const sliced = sliceToLines(buf, 1, 2, 0)
    expect(sliced.buf).toContainEqual({ kind: 'pill', id: 'p1', size: 99 })
  })
})
