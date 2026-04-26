import { describe, it, expect } from 'vitest'
import { emitBash } from '../bash.js'

describe('emitBash', () => {
  const script = emitBash()

  it('declares the completion function', () => {
    expect(script).toContain('_prism_complete()')
    expect(script).toContain('complete -F _prism_complete prism')
  })

  it('lists all flags for tab completion', () => {
    expect(script).toContain('--or')
    expect(script).toContain('--openrouter')
    expect(script).toContain('--max-tokens')
    expect(script).toContain('--continue')
  })

  it('routes value-taking flags to the right completer', () => {
    expect(script).toContain('--or)')
    expect(script).toContain('prism --complete model-openrouter')
  })

  it('handles --max-tokens with empty completion (number expected)', () => {
    expect(script).toContain('--max-tokens)')
    expect(script).toMatch(/--max-tokens\)\s*\n\s*COMPREPLY=\(\)/)
  })

  it('uses prism --complete model-ollama for positional', () => {
    expect(script).toContain('prism --complete model-ollama')
  })
})
