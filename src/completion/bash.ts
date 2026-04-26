/**
 * emit bash completion script.
 * sourced via: eval "$(prism --completion bash)"
 */

import { FLAGS, allFlagTokens } from './spec.js'

export function emitBash(): string {
  const flagList = allFlagTokens().join(' ')

  // build case branches for flags that take values
  const valueBranches: string[] = []
  for (const f of FLAGS) {
    if (!f.takesValue) continue
    const tokens = [f.flag, f.alias].filter(Boolean) as string[]
    for (const t of tokens) {
      let body: string
      if (f.takesValue === 'number') {
        body = '    COMPREPLY=()\n    return 0\n    ;;'
      } else {
        body = `    COMPREPLY=( $(compgen -W "$(prism --complete ${f.takesValue} 2>/dev/null)" -- "$cur") )\n    return 0\n    ;;`
      }
      valueBranches.push(`  ${t})\n${body}`)
    }
  }

  return `# prism shell completion (bash)
_prism_complete() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "$prev" in
${valueBranches.join('\n')}
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "${flagList}" -- "$cur") )
    return 0
  fi

  # positional: ollama model name
  COMPREPLY=( $(compgen -W "$(prism --complete model-ollama 2>/dev/null)" -- "$cur") )
}
complete -F _prism_complete prism
`
}
