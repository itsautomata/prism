import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { atomicWriteFileSync } from '../atomic.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'atomic-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('atomicWriteFileSync', () => {
  it('writes the content and leaves no temp file behind', () => {
    const p = join(dir, 'f.txt')
    atomicWriteFileSync(p, 'hello')
    expect(readFileSync(p, 'utf-8')).toBe('hello')
    expect(readdirSync(dir)).toEqual(['f.txt'])
  })

  it('replaces an existing file', () => {
    const p = join(dir, 'f.txt')
    writeFileSync(p, 'old', 'utf-8')
    atomicWriteFileSync(p, 'new')
    expect(readFileSync(p, 'utf-8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['f.txt'])
  })

  it('throws on an unwritable path and leaves no stray temp file', () => {
    const p = join(dir, 'missing', 'f.txt') // parent dir does not exist
    expect(() => atomicWriteFileSync(p, 'x')).toThrow()
    expect(readdirSync(dir)).toEqual([])
  })
})
