/**
 * skill loader.
 *
 * a skill is a markdown file the operator toggles on or off mid-session. when
 * active, its body is appended to the system prompt under an `# active skills`
 * section, biasing the parent agent toward whatever workflow the skill encodes.
 *
 * scoping mirrors subagent definitions:
 * - <cwd>/skills/<name>.md (project, git-committed by convention)
 * - ~/.prism/skills/<name>.md (user, applies to every project)
 *
 * project scope shadows user scope. no frontmatter is required: the first line
 * of the file is the description shown in `/skill list`, the whole content is
 * the body that lands in the prompt.
 *
 * skills are distinct from subagents (which run their own conversation) and
 * personas (which wrap the whole session). they are session-scoped instruction
 * fragments toggled by the operator.
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'

export interface Skill {
  /** invocation key. matches the filename without `.md`. */
  name: string
  /** one-line summary; the first line of the file. shown in `/skill list`. */
  description: string
  /** full file content, trimmed. injected into the system prompt when active. */
  body: string
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

function readSkillFile(filePath: string): Skill {
  const content = readFileSync(filePath, 'utf-8').trim()
  const name = basename(filePath, '.md')

  if (content.length === 0) {
    throw new SkillLoadError(filePath, 'file is empty')
  }

  const firstLine = content.split('\n')[0]!.trim()
  const description = firstLine.length > 0 ? firstLine : `skill ${name}`

  return { name, description, body: content }
}
