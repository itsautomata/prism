/**
 * read confinement for the permission gate.
 *
 * auto-allowed reads (Read, Grep, Glob, safe Bash) are otherwise unbounded —
 * a prompt-injected agent can pull ~/.ssh/id_rsa or ~/.prism/config.toml into
 * context with no prompt, then exfiltrate. classifyRead bounds the auto-allow:
 * reads inside the project tree pass; reads outside it, and in-project files
 * that look like secrets, require an explicit prompt.
 *
 * the resolution defends against a repo-planted symlink (./innocent -> ~/.ssh/
 * id_rsa) by following links before deciding, and against a literal "~/" path
 * by expanding it the way the shell would.
 */

import { resolve, relative, isAbsolute, basename, join } from 'path'
import { homedir } from 'os'
import { realpathSync } from 'fs'

// secret-looking filenames that warrant a prompt even inside the project.
const SECRET_NAME = /^(\.env(\..+)?|\.netrc|\.git-credentials|\.npmrc|id_(rsa|ed25519|ecdsa|dsa)|credentials)$/i
const SECRET_EXT = /\.(pem|key|p12|pfx|keystore)$/i

export type ReadReason = 'in-project' | 'outside-project' | 'secret-name'

export interface ReadClass {
  allow: boolean
  reason: ReadReason
}

/** expand a leading ~ the way the shell would, so "~/.ssh/x" isn't mistaken
 *  for an in-project directory literally named "~". */
function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** resolve symlinks when the path exists; fall back to the lexical path so a
 *  not-yet-existing target still gets classified. */
function realOrLexical(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/**
 * classify a read target for the permission gate. inside the project tree →
 * allow; outside it, or an in-project secret file → ask.
 */
export function classifyRead(targetPath: string, cwd: string): ReadClass {
  // the shell also expands ~user/ to that user's home, which we can't resolve
  // portably. treat any tilde form other than ~ and ~/… as outside the project
  // so `cat ~dora/.ssh/id_rsa` can't slip past as an in-project literal.
  if (targetPath.startsWith('~') && targetPath !== '~' && !targetPath.startsWith('~/')) {
    return { allow: false, reason: 'outside-project' }
  }

  const expanded = expandHome(targetPath)
  const abs = realOrLexical(isAbsolute(expanded) ? expanded : resolve(cwd, expanded))
  const root = realOrLexical(resolve(cwd))

  const rel = relative(root, abs)
  // rel's first segment is '..' when abs escapes root. split on both separators
  // so this holds on Windows too, where path.relative yields '..\\foo'.
  const outside = rel.split(/[\\/]/)[0] === '..' || isAbsolute(rel)
  if (outside) return { allow: false, reason: 'outside-project' }

  const name = basename(abs)
  if (SECRET_NAME.test(name) || SECRET_EXT.test(name)) {
    return { allow: false, reason: 'secret-name' }
  }

  return { allow: true, reason: 'in-project' }
}

/** the prompt message for a read that needs confirmation. */
export function readAskMessage(targetPath: string, reason: ReadReason): string {
  return reason === 'secret-name'
    ? `read possible secret file: ${targetPath}`
    : `read file outside the project: ${targetPath}`
}
