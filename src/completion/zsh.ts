/**
 * emit zsh completion script.
 * sourced via: eval "$(prism --completion zsh)"
 */

import { FLAGS, type ValueKind } from './spec.js'

function escapeDesc(s: string): string {
  return s.replace(/'/g, "'\\''").replace(/:/g, '\\:')
}

function helperName(kind: ValueKind): string {
  return `_prism_complete_${kind.replace(/-/g, '_')}`
}

export function emitZsh(): string {
  // collect every value context that needs a dynamic completer
  const dynamicKinds = new Set<ValueKind>()
  // model-ollama is always declared because the positional fallback uses it
  dynamicKinds.add('model-ollama')
  for (const f of FLAGS) {
    if (f.takesValue && f.takesValue !== 'number') dynamicKinds.add(f.takesValue)
  }

  const flagSpecs: string[] = []
  for (const f of FLAGS) {
    const tokens = [f.flag, f.alias].filter(Boolean) as string[]
    const desc = escapeDesc(f.desc)

    // body after the flag spec: [description]:value-name:value-completer
    let body: string
    if (f.takesValue === 'number') {
      body = `[${desc}]:number:`
    } else if (f.takesValue) {
      body = `[${desc}]:value:${helperName(f.takesValue)}`
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

  // emit a helper function per dynamic context
  const helpers: string[] = []
  for (const kind of dynamicKinds) {
    helpers.push(`${helperName(kind)}() {
  local -a items
  items=(\${(f)"$(prism --complete ${kind} 2>/dev/null)"})
  compadd -a items
}`)
  }

  return `# prism shell completion (zsh)
# sourced via: eval "$(prism --completion zsh)"

# ensure compinit has run so compdef is available
autoload -Uz compinit
(( $+functions[compdef] )) || compinit

${helpers.join('\n\n')}

_prism() {
  _arguments \\
${flagSpecs.join(' \\\n')} \\
    '*::model:${helperName('model-ollama')}'
}

compdef _prism prism
`
}
