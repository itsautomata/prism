import { describe, it, expect } from 'vitest'
import { translateKeypad } from '../keypadStdin.js'

describe('translateKeypad', () => {
  it('maps each numpad digit code to its character', () => {
    const digits: Array<[number, string]> = [
      [57399, '0'], [57400, '1'], [57401, '2'], [57402, '3'], [57403, '4'],
      [57404, '5'], [57405, '6'], [57406, '7'], [57407, '8'], [57408, '9'],
    ]
    for (const [code, ch] of digits) {
      expect(translateKeypad(`\x1b[${code}u`)).toBe(ch)
    }
  })

  it('maps the numpad operators and decimal', () => {
    expect(translateKeypad('\x1b[57409u')).toBe('.')
    expect(translateKeypad('\x1b[57410u')).toBe('/')
    expect(translateKeypad('\x1b[57411u')).toBe('*')
    expect(translateKeypad('\x1b[57412u')).toBe('-')
    expect(translateKeypad('\x1b[57413u')).toBe('+')
    expect(translateKeypad('\x1b[57415u')).toBe('=')
    expect(translateKeypad('\x1b[57416u')).toBe(',')
  })

  it('maps numpad enter to carriage return', () => {
    expect(translateKeypad('\x1b[57414u')).toBe('\r')
  })

  it('translates the digit even when modifiers/fields are present', () => {
    expect(translateKeypad('\x1b[57400;2u')).toBe('1')   // shift
    expect(translateKeypad('\x1b[57400;1:1u')).toBe('1') // modifier + event type
  })

  it('leaves the enter chord and other CSI-u sequences untouched', () => {
    expect(translateKeypad('\x1b[13;2u')).toBe('\x1b[13;2u')  // shift+enter chord
    expect(translateKeypad('\x1b[27;2;13~')).toBe('\x1b[27;2;13~')
    expect(translateKeypad('\x1b[97u')).toBe('\x1b[97u')      // 'a' as csi-u, not keypad
  })

  it('leaves plain text and non-keypad escape sequences unchanged', () => {
    expect(translateKeypad('hello')).toBe('hello')
    expect(translateKeypad('\x1b[A')).toBe('\x1b[A')   // up arrow
    expect(translateKeypad('\x1b[1;3D')).toBe('\x1b[1;3D') // option+left chord
  })

  it('rewrites keypad codes embedded among other characters', () => {
    expect(translateKeypad('a\x1b[57400ub')).toBe('a1b')
    expect(translateKeypad('\x1b[57400u\x1b[57401u\x1b[57402u')).toBe('123')
  })
})
