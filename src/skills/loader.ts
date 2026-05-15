/**
 * skill loader.
 *
 * a skill is a markdown file the operator invokes on demand or sets to passive
 * injection. the primary mode is invocation: `/run <name>` fires the body as
 * a one-shot instruction. passive mode (`mode: passive` in frontmatter) biases
 * every turn, same as the old toggle behavior.
 *
 * scoping mirrors subagent definitions:
 * - <cwd>/skills/<name>.md (project, git-committed by convention)
 * - ~/.prism/skills/<name>.md (user, applies to every project)
 *
 * project scope shadows user scope. frontmatter is optional and enclosed in
 * `---` delimiters (same format as agent files). recognized keys:
 *   mode: invoke | passive (default: invoke)
 * the first non-frontmatter line is the description shown in listings.
 *
 * skills are distinct from subagents (which run their own conversation) and
 * personas (which wrap the whole session).
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

export type SkillMode = 'invoke' | 'passive'

export interface Skill {
  /** invocation key. matches the filename without `.md`. */
  name: string
  /** one-line summary; the first non-frontmatter line. */
  description: string
  /** full file content, trimmed, excluding frontmatter. */
  body: string
  /** how the skill is delivered: invoke (one-shot) or passive (always-on). */
  mode: SkillMode
  /** `## heading` lines extracted from the body, for autocomplete. */
  sections: string[]
}

export class SkillNotFoundError extends Error {
  constructor(name: string) {
    super(`skill "${name}" not found. checked project (./skills/) and user scope (~/.prism/skills/).`)
    this.name = 'SkillNotFoundError'
  }
}

export class SkillLoadError extends Error {
  constructor(filePath: string, reason: string) {
    super(`failed to load skill at ${filePath}: ${reason}`)
    this.name = 'SkillLoadError'
  }
}

function projectSkillsDir(cwd: string): string {
  return join(cwd, 'skills')
}

function userSkillsDir(): string {
  return join(homedir(), '.prism', 'skills')
}

/**
 * load a skill by name. project scope wins on a same-name collision.
 * throws SkillNotFoundError when neither scope has the file.
 */
export function loadSkill(name: string, cwd: string): Skill {
  const project = join(projectSkillsDir(cwd), `${name}.md`)
  if (existsSync(project)) return readSkillFile(project)

  const user = join(userSkillsDir(), `${name}.md`)
  if (existsSync(user)) return readSkillFile(user)

  throw new SkillNotFoundError(name)
}

/**
 * list every available skill. project + user scopes, deduped by name (project
 * wins). files that fail to load are skipped silently here; callers that need
 * to surface the error should call loadSkill directly.
 */
export function listSkills(cwd: string): Skill[] {
  const project = readSkillsDir(projectSkillsDir(cwd))
  const user = readSkillsDir(userSkillsDir())

  const seen = new Set<string>()
  const result: Skill[] = []
  for (const skill of [...project, ...user]) {
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    result.push(skill)
  }
  return result
}

function readSkillsDir(dir: string): Skill[] {
  if (!existsSync(dir)) return []
  let files: string[] = []
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.md'))
  } catch {
    return []
  }

  const skills: Skill[] = []
  for (const file of files) {
    try {
      skills.push(readSkillFile(join(dir, file)))
    } catch {
      // broken files should not crash the listing; callers see them
      // via loadSkill if they actually try to use the broken name.
    }
  }
  return skills
}

/**
 * parse YAML frontmatter from markdown content.
 * only handles `key: value` lines. no arrays, no nesting.
 * returns the frontmatter map and the body (everything after frontmatter).
 */
interface ParsedResult {
  frontmatter: Record<string, string>
  body: string
}

function parseFrontmatter(text: string): ParsedResult {
  const lines = text.split('\n')
  if (lines.length < 2 || lines[0]!.trim() !== '---') {
    return { frontmatter: {}, body: text.trim() }
  }

  let endIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') {
      endIdx = i
      break
    }
  }

  if (endIdx === -1) {
    // opening fence but no closing fence — treat whole file as body
    return { frontmatter: {}, body: text.trim() }
  }

  const frontmatter: Record<string, string> = {}
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i]!.trim()
    if (!line || line.startsWith('#')) continue
    const sep = line.indexOf(':')
    if (sep === -1) continue
    const key = line.slice(0, sep).trim()
    const value = line.slice(sep + 1).trim()
    if (key) frontmatter[key] = value
  }

  const body = lines.slice(endIdx + 1).join('\n').trim()
  return { frontmatter, body }
}

function readSkillFile(filePath: string): Skill {
  const raw = readFileSync(filePath, 'utf-8')
  const name = basename(filePath, '.md')

  if (raw.trim().length === 0) {
    throw new SkillLoadError(filePath, 'file is empty')
  }

  const { frontmatter, body } = parseFrontmatter(raw)

  if (body.length === 0) {
    throw new SkillLoadError(filePath, 'no content after frontmatter')
  }

  const modeRaw = (frontmatter['mode'] || '').toLowerCase()
  const mode: SkillMode = modeRaw === 'passive' ? 'passive' : 'invoke'

  const firstLine = body.split('\n')[0]!.trim()
  const description = firstLine.length > 0 ? firstLine : `skill ${name}`

  // extract ## headings for section autocomplete
  const sections: string[] = []
  for (const line of body.split('\n')) {
    const m = line.match(/^##\s+(.+)/)
    if (m) sections.push(m[1]!.trim())
  }

  return { name, description, body, mode, sections }
}
