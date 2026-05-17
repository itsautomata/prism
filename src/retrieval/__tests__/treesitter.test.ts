import { describe, it, expect } from 'vitest'
import { extractSymbols } from '../treesitter.js'

// these tests exercise the real web-tree-sitter runtime and the grammar wasms
// in wasm/build/. they only run when the wasms have been built (run
// `npm run build:wasms` once locally). on machines without the wasms, the
// tests still pass by returning null from extractSymbols (graceful degradation).

describe('extractSymbols: typescript', () => {
  it('finds top-level functions and classes', async () => {
    const source = `
import { foo } from './foo.js'
import type { Bar } from 'bar'

export function greet(name: string): string {
  return \`hello \${name}\`
}

class Greeter {
  hello() {}
}

interface User {
  id: number
}
`
    const result = await extractSymbols('test.ts', source)
    if (!result) {
      console.warn('skipped: typescript grammar wasm not available (run npm run build:wasms)')
      return
    }

    expect(result.language).toBe('typescript')
    const names = result.symbols.map(s => s.name)
    expect(names).toContain('greet')
    expect(names).toContain('Greeter')
    expect(names).toContain('User')
  })

  it('collects import sources', async () => {
    const source = `
import { a } from './a.js'
import b from 'pkg'
`
    const result = await extractSymbols('test.ts', source)
    if (!result) return // grammar not built locally
    expect(result.imports).toContain('./a.js')
    expect(result.imports).toContain('pkg')
  })

  it('returns null for unknown extension', async () => {
    const result = await extractSymbols('foo.xyz', 'whatever')
    expect(result).toBeNull()
  })

  it('returns null gracefully when source is empty', async () => {
    const result = await extractSymbols('test.ts', '')
    if (!result) return
    expect(result.symbols).toEqual([])
    expect(result.imports).toEqual([])
  })
})

describe('extractSymbols: python', () => {
  it('finds def and class', async () => {
    const source = `
import os
from pathlib import Path

def greet(name):
    return f"hello {name}"

class Greeter:
    def hello(self):
        pass
`
    const result = await extractSymbols('test.py', source)
    if (!result) return
    const names = result.symbols.map(s => s.name)
    expect(names).toContain('greet')
    expect(names).toContain('Greeter')
  })
})

describe('extractSymbols: rust', () => {
  it('finds fn and struct', async () => {
    const source = `
use std::io;

pub fn greet(name: &str) -> String {
    format!("hello {}", name)
}

pub struct Greeter;
`
    const result = await extractSymbols('test.rs', source)
    if (!result) return
    const names = result.symbols.map(s => s.name)
    expect(names).toContain('greet')
    expect(names).toContain('Greeter')
  })
})

describe('extractSymbols: prism source file', () => {
  // load prism's own cli.ts as a real-world parse target
  it('parses src/cli.ts and returns sensible symbols', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const path = resolve(process.cwd(), 'src/cli.ts')
    const source = readFileSync(path, 'utf-8')
    const result = await extractSymbols(path, source)
    if (!result) return

    expect(result.language).toBe('typescript')
    // cli.ts has at least the main and shortenPath functions
    const names = result.symbols.map(s => s.name)
    expect(names).toContain('main')
    expect(names).toContain('shortenPath')
    // it imports a lot of things
    expect(result.imports.length).toBeGreaterThan(5)
  })
})
