/**
 * lens loader.
 *
 * a lens is a markdown file the operator drops into the `.prism/` directory
 * at the project root. every `.md` file found there (direct children only,
 * subdirectories like `agents/` and `skills/` are excluded) is treated as
 * authored context and injected into the system prompt under `# project context`.
 *
 * `lens.md` is the conventional primary file, but any name works. multiple
 * files are concatenated in order: `lens.md` first, then alphabetical.
 * empty files are ignored.
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, basename } from 'path'

export interface Lens {
  /** filename without `.md` extension. */
  name: string
  /** trimmed file content. */
  content: string
}

/**
 * load all lens files from `<cwd>/.prism/`. returns an empty array when the
 * directory does not exist or contains no readable `.md` files.
 */
export function loadLenses(cwd: string): Lens[] {
  const dir = join(cwd, '.prism')
  if (!existsSync(dir)) return []

  let files: string[]
  try {
    files = readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name)
  } catch {
    return []
  }

  // lens.md leads; rest is alphabetical
  files.sort((a, b) => {
    if (a === 'lens.md') return -1
    if (b === 'lens.md') return 1
    return a.localeCompare(b)
  })

  const lenses: Lens[] = []
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), 'utf-8').trim()
      if (content.length > 0) {
        lenses.push({ name: basename(file, '.md'), content })
      }
    } catch {
      // unreadable files silently skipped
    }
  }
  return lenses
}
