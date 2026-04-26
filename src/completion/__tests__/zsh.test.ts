import { describe, it, expect } from 'vitest'
import { emitZsh } from '../zsh.js'

describe('emitZsh', () => {
  const script = emitZsh()

  it('registers the completion via compdef', () => {
    expect(script).toContain('compdef _prism prism')
  })

  it('declares the completion function', () => {
    expect(script).toContain('_prism()')
  })

  it('ensures compinit is loaded before using compdef', () => {
    expect(script).toContain('autoload -Uz compinit')
  })

  it('declares ollama and openrouter model fetchers', () => {
    expect(script).toContain('_prism_models_model_ollama()')
    expect(script).toContain('_prism_models_model_openrouter()')
    expect(script).toContain('prism --complete model-ollama')
    expect(script).toContain('prism --complete model-openrouter')
  })

  it('lists flags with descriptions', () => {
    expect(script).toContain('--or,--openrouter')
    expect(script).toContain('--continue')
    expect(script).toContain('--max-tokens')
    expect(script).toContain('use OpenRouter provider')
  })

  it('routes --or to the openrouter model completer', () => {
    expect(script).toContain('{--or,--openrouter}')
    expect(script).toContain('_prism_models_model_openrouter')
    // exclusion list prevents suggesting both forms after one is given
    expect(script).toContain("'(--or --openrouter)'")
  })

  it('positional args fall through to ollama models', () => {
    expect(script).toContain("'*::model:_prism_models_model_ollama'")
  })
})
