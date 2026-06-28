import { Readable } from 'node:stream'

// kitty keyboard protocol reports numpad keys as private-use codepoints in a
// CSI-u sequence (`\x1b[<code>u`) rather than the digit byte. ink's parser maps
// these to functional-key names (kp1, kpadd, …) with isPrintable=false, so the
// character never reaches useInput's `input` and the keypress is dropped. we
// translate the keypad block back to the literal characters before ink parses.
//
// reference: kitty functional key codes 57399 (KP_0) … 57416 (KP_SEPARATOR).
const KEYPAD: Record<number, string> = {
  57399: '0', 57400: '1', 57401: '2', 57402: '3', 57403: '4',
  57404: '5', 57405: '6', 57406: '7', 57407: '8', 57408: '9',
  57409: '.', 57410: '/', 57411: '*', 57412: '-', 57413: '+',
  57414: '\r', 57415: '=', 57416: ',',
}

// a CSI-u keypress: `\x1b[<code>` then optional `;modifiers`/`:event`/`text`
// fields, terminated by `u`. only the keypad codes are rewritten; every other
// CSI-u sequence (notably the `\x1b[13;<mod>u` enter chord) passes through.
const CSI_U = /\x1b\[(\d+)(?:[;:][0-9;:]*)?u/g

export function translateKeypad(s: string): string {
  if (!s.includes('\x1b[')) return s
  return s.replace(CSI_U, (whole, code: string) => {
    const ch = KEYPAD[Number(code)]
    return ch !== undefined ? ch : whole
  })
}

/**
 * wrap a TTY input stream so ink reads numpad digits as their characters.
 *
 * ink reads from the returned stream via 'readable' + read(); we feed it from
 * `real`'s 'data' events, rewriting the kitty keypad block on the way through.
 * the TTY surface ink touches (isTTY, setRawMode, ref, unref) is forwarded to
 * `real` so raw mode still toggles the actual terminal. chunks with no escape
 * byte pass through untouched, byte-for-byte, so pastes stay exact.
 */
export function wrapStdinForKeypad(real: NodeJS.ReadStream): NodeJS.ReadStream {
  if (!real.isTTY) return real

  const wrapped = new Readable({ read() {} })

  real.on('data', (chunk: Buffer | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    if (!buf.includes(0x1b)) {
      wrapped.push(buf)
      return
    }
    wrapped.push(Buffer.from(translateKeypad(buf.toString('utf8')), 'utf8'))
  })

  const w = wrapped as unknown as NodeJS.ReadStream & {
    setRawMode: (mode: boolean) => NodeJS.ReadStream
  }
  w.isTTY = true
  w.setRawMode = (mode: boolean) => { real.setRawMode(mode); return w }
  w.ref = () => { real.ref?.(); return w }
  w.unref = () => { real.unref?.(); return w }
  return w
}
