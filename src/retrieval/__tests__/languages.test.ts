import { describe, it, expect } from 'vitest'
import { detectLanguage, knownLanguages } from '../languages.js'

describe('detectLanguage', () => {
  it('maps common typescript paths', () => {
    expect(detectLanguage('src/cli.ts')).toBe('typescript')
    expect(detectLanguage('foo.mts')).toBe('typescript')
    expect(detectLanguage('App.tsx')).toBe('tsx')
  })

  it('maps python by extension', () => {
    expect(detectLanguage('a/b/main.py')).toBe('python')
    expect(detectLanguage('x.pyw')).toBe('python')
  })

  it('maps rust, go, c, cpp', () => {
    expect(detectLanguage('lib.rs')).toBe('rust')
    expect(detectLanguage('main.go')).toBe('go')
    expect(detectLanguage('lib.c')).toBe('c')
    expect(detectLanguage('foo.cpp')).toBe('cpp')
    expect(detectLanguage('foo.hpp')).toBe('cpp')
  })

  it('maps shell variants to bash', () => {
    expect(detectLanguage('install.sh')).toBe('bash')
    expect(detectLanguage('script.bash')).toBe('bash')
    expect(detectLanguage('config.zsh')).toBe('bash')
  })

  it('matches filename-based mappings (Dockerfile, Makefile)', () => {
    expect(detectLanguage('path/to/Dockerfile')).toBe('dockerfile')
    expect(detectLanguage('Containerfile')).toBe('dockerfile')
    expect(detectLanguage('Makefile')).toBe('make')
    expect(detectLanguage('makefile')).toBe('make')
  })

  it('returns null for unmapped extensions', () => {
    expect(detectLanguage('foo.xyz')).toBeNull()
    expect(detectLanguage('no-extension')).toBeNull()
  })

  it('case-insensitive on the extension', () => {
    expect(detectLanguage('SOURCE.PY')).toBe('python')
    expect(detectLanguage('Main.TS')).toBe('typescript')
  })
})

describe('knownLanguages', () => {
  it('returns a deduplicated set of grammar names', () => {
    const langs = knownLanguages()
    // typescript maps from .ts, .mts, .cts → one entry
    const tsEntries = [...langs].filter(l => l === 'typescript').length
    expect(tsEntries).toBe(1)
    // sanity: contains the core ones
    expect(langs.has('typescript')).toBe(true)
    expect(langs.has('python')).toBe(true)
    expect(langs.has('rust')).toBe(true)
    expect(langs.has('dockerfile')).toBe(true)
  })
})
