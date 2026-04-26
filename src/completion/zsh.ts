/**
 * emit zsh completion script.
 * sourced via: eval "$(prism --completion zsh)"
 */

import { FLAGS } from './spec.js'

function escapeDesc(s: string): string {
  return s.replace(/'/g, "'\\''").replace(/:/g, '\\:')
}

export function emitZsh(): string {
  const flagSpecs: string[] = []
  for (const f of FLAGS) {
    const tokens = [f.flag, f.alias].filter(Boolean) as string[]
    const desc = escapeDesc(f.desc)

    // body after the flag spec: [description]:value-name:value-completer
    let body: string
    if (f.takesValue === 'number') {
      body = `[${desc}]:number:`
    } else if (f.takesValue) {
      body = `[${desc}]:model:_prism_models_${f.takesValue.replace('-', '_')}`
    } else {
      body = `[${desc}]`
    }

    if (tokens.length > 1) {
      // alias form: (exclusion-list){flag,alias}'[body]'
      // brace expansion must live OUTSIDE the quoted string for _arguments to
      // expand it into two distinct option specs sharing the same body.
      const exclusion = tokens.join(' ')
      flagSpecs.push(`  '(${exclusion})'{${tokens.join(',')}}"${body}"`)
    } else {
      flagSpecs.push(`  '${tokens[0]}${body}'`)
    }
  }

  return `# prism shell completion (zsh)
# sourced via: eval "$(prism --completion zsh)"

# ensure compinit has run so compdef is available
autoload -Uz compinit
(( $+functions[compdef] )) || compinit

_prism_models_model_ollama() {
  local -a models
  models=(\${(f)"$(prism --complete model-ollama 2>/dev/null)"})
  compadd -a models
}

_prism_models_model_openrouter() {
  local -a models
  models=(\${(f)"$(prism --complete model-openrouter 2>/dev/null)"})
  compadd -a models
}

_prism() {
  _arguments \\
${flagSpecs.join(' \\\n')} \\
    '*::model:_prism_models_model_ollama'
}

compdef _prism prism
`
}
