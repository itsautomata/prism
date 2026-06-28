/**
 * agent registry and definition file loader.
 *
 * resolves named agents from disk and exposes them as Agent values the
 * runtime can consume directly. project scope at <cwd>/agents/<name>.md
 * shadows user scope at ~/.prism/agents/<name>.md.
 *
 * agent files are markdown with YAML frontmatter. only a small YAML subset
 * is supported (one-line key/value, inline arrays, no nested objects or
 * anchors). the parser lives at the bottom of this file; if richer YAML
 * features are ever needed, swap it for a real library.
 */

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import type { Agent, PermissionPolicy } from './definition.js'
import { DEFAULT_AGENT, RECOVERY_AGENT, AGENT_DEFAULTS } from './definition.js'

export class AgentNotFoundError extends Error {
  constructor(name: string) {
    super(`agent "${name}" not found. checked project (./agents/) and user scope (~/.prism/agents/).`)
    this.name = 'AgentNotFoundError'
  }
}

export class AgentValidationError extends Error {
  constructor(filePath: string, reason: string) {
    super(`invalid agent definition at ${filePath}: ${reason}`)
    this.name = 'AgentValidationError'
  }
}

const VALID_PERMISSIONS: ReadonlySet<PermissionPolicy> = new Set(['deny-writes', 'inherit'])
const RESERVED_NAMES: ReadonlySet<string> = new Set(['default', 'recovery'])

function projectAgentsDir(cwd: string): string {
  return join(cwd, 'agents')
}

function userAgentsDir(): string {
  return join(homedir(), '.prism', 'agents')
}

/**
 * resolve an agent by name. built-in names ('default', 'recovery') resolve
 * to the in-code constants without touching disk and cannot be overridden
 * by user files. for any other name, project scope is checked before user
 * scope, and the project file wins on a same-name collision.
 */
export function resolveAgent(name: string | undefined, cwd: string): Agent {
  if (!name) return DEFAULT_AGENT
  if (name === DEFAULT_AGENT.name) return DEFAULT_AGENT
  if (name === RECOVERY_AGENT.name) return RECOVERY_AGENT
  if (name !== basename(name)) throw new AgentNotFoundError(name)

  const project = join(projectAgentsDir(cwd), `${name}.md`)
  if (existsSync(project)) return loadDefinition(project)

  const user = join(userAgentsDir(), `${name}.md`)
  if (existsSync(user)) return loadDefinition(user)

  throw new AgentNotFoundError(name)
}

/**
 * list all available agents: the built-in default plus everything found in
 * the project and user agent directories. agents are deduped by name with
 * project files shadowing user files. the recovery agent is intentionally
 * omitted; it's an internal flow, not user-callable.
 *
 * files that fail to parse are skipped silently here. callers that need to
 * surface those errors should call loadDefinition directly.
 */
export function listAgents(cwd: string): Agent[] {
  const project = readAgentDir(projectAgentsDir(cwd))
  const user = readAgentDir(userAgentsDir())

  const seen = new Set<string>([DEFAULT_AGENT.name])
  const result: Agent[] = [DEFAULT_AGENT]

  for (const agent of project) {
    if (seen.has(agent.name)) continue
    seen.add(agent.name)
    result.push(agent)
  }
  for (const agent of user) {
    if (seen.has(agent.name)) continue
    seen.add(agent.name)
    result.push(agent)
  }

  return result
}

function readAgentDir(dir: string): Agent[] {
  if (!existsSync(dir)) return []
  let entries: string[] = []
  try {
    entries = readdirSync(dir).filter(f => f.endsWith('.md'))
  } catch {
    return []
  }

  const agents: Agent[] = []
  for (const file of entries) {
    try {
      agents.push(loadDefinition(join(dir, file)))
    } catch {
      // a broken file should not crash the listing.
      // resolveAgent surfaces the error when the user invokes the broken agent by name.
    }
  }
  return agents
}

/**
 * load and validate an agent file. fills AGENT_DEFAULTS for fields the user
 * omitted from the frontmatter. throws AgentValidationError with a precise
 * reason when the file is malformed.
 */
export function loadDefinition(filePath: string): Agent {
  const content = readFileSync(filePath, 'utf-8')
  const { frontmatter, body } = splitFrontmatter(filePath, content)

  const name = basename(filePath, '.md')
  if (RESERVED_NAMES.has(name)) {
    throw new AgentValidationError(filePath, `name "${name}" is reserved for a built-in agent`)
  }

  if (frontmatter.name !== undefined && frontmatter.name !== name) {
    throw new AgentValidationError(
      filePath,
      `frontmatter name "${String(frontmatter.name)}" does not match filename "${name}"`,
    )
  }

  const trimmedBody = body.trim()
  if (trimmedBody.length === 0) {
    throw new AgentValidationError(filePath, 'system prompt body is empty')
  }

  const description = typeof frontmatter.description === 'string' && frontmatter.description.length > 0
    ? frontmatter.description
    : AGENT_DEFAULTS.description(name)

  const tools = parseTools(filePath, frontmatter.tools)
  const permissions = parsePermissions(filePath, frontmatter.permissions)
  const maxTurns = parseMaxTurns(filePath, frontmatter.max_turns)
  const model = parseModel(filePath, frontmatter.model)

  return {
    name,
    description,
    systemPrompt: trimmedBody,
    tools,
    permissions,
    maxTurns,
    ...(model !== undefined ? { model } : {}),
  }
}

function parseTools(filePath: string, value: unknown): string[] | '*' {
  if (value === undefined) return AGENT_DEFAULTS.tools
  if (value === '*') return '*'
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
    return value as string[]
  }
  throw new AgentValidationError(
    filePath,
    `tools must be an array of strings or "*", got ${JSON.stringify(value)}`,
  )
}

function parsePermissions(filePath: string, value: unknown): PermissionPolicy {
  if (value === undefined) return AGENT_DEFAULTS.permissions
  if (typeof value === 'string' && VALID_PERMISSIONS.has(value as PermissionPolicy)) {
    return value as PermissionPolicy
  }
  throw new AgentValidationError(
    filePath,
    `permissions must be one of ${[...VALID_PERMISSIONS].join(', ')}, got ${JSON.stringify(value)}`,
  )
}

function parseMaxTurns(filePath: string, value: unknown): number {
  if (value === undefined) return AGENT_DEFAULTS.maxTurns
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  throw new AgentValidationError(
    filePath,
    `max_turns must be a positive integer, got ${JSON.stringify(value)}`,
  )
}

function parseModel(filePath: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && value.length > 0) return value
  throw new AgentValidationError(filePath, `model must be a non-empty string, got ${JSON.stringify(value)}`)
}

// --- frontmatter / YAML parsing ---

interface SplitResult {
  frontmatter: Record<string, unknown>
  body: string
}

const FRONTMATTER_DELIM = /^---\s*$/

function splitFrontmatter(filePath: string, content: string): SplitResult {
  const lines = content.split('\n')
  if (lines.length === 0 || !FRONTMATTER_DELIM.test(lines[0]!)) {
    throw new AgentValidationError(filePath, 'missing frontmatter (file must start with ---)')
  }

  let closeIdx = -1
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_DELIM.test(lines[i]!)) {
      closeIdx = i
      break
    }
  }
  if (closeIdx === -1) {
    throw new AgentValidationError(filePath, 'unterminated frontmatter (no closing ---)')
  }

  const frontmatterText = lines.slice(1, closeIdx).join('\n')
  const body = lines.slice(closeIdx + 1).join('\n')

  return {
    frontmatter: parseYamlSubset(filePath, frontmatterText),
    body,
  }
}

/**
 * minimal YAML parser covering the subset used by agent frontmatter:
 * - one key per line
 * - bare strings, single- or double-quoted strings
 * - integers
 * - booleans
 * - inline arrays of strings: [a, b, c] or ["a", "b"]
 * - blank lines and # comments are skipped
 *
 * not supported: multi-line values, nested objects, YAML anchors and
 * references, multi-line arrays, floats, dates, comments inside values.
 * unrecognized shapes throw AgentValidationError.
 */
function parseYamlSubset(filePath: string, text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) {
      throw new AgentValidationError(
        filePath,
        `frontmatter line ${i + 1}: expected "key: value", got ${JSON.stringify(line)}`,
      )
    }

    const key = line.slice(0, colonIdx).trim()
    const valueText = line.slice(colonIdx + 1).trim()

    if (!/^[a-z_][a-z0-9_]*$/i.test(key)) {
      throw new AgentValidationError(filePath, `frontmatter line ${i + 1}: invalid key ${JSON.stringify(key)}`)
    }

    result[key] = parseScalar(filePath, valueText, i + 1)
  }

  return result
}

function parseScalar(filePath: string, text: string, lineNumber: number): unknown {
  if (text === '') return ''

  if (text.startsWith('[')) {
    if (!text.endsWith(']')) {
      throw new AgentValidationError(filePath, `frontmatter line ${lineNumber}: unterminated array`)
    }
    const inside = text.slice(1, -1).trim()
    if (inside === '') return []
    return inside.split(',').map(item => unquote(item.trim()))
  }

  if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
      (text.startsWith("'") && text.endsWith("'") && text.length >= 2)) {
    return text.slice(1, -1)
  }

  if (/^-?\d+$/.test(text)) {
    return parseInt(text, 10)
  }

  if (text === 'true') return true
  if (text === 'false') return false

  return text
}

function unquote(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
      (text.startsWith("'") && text.endsWith("'") && text.length >= 2)) {
    return text.slice(1, -1)
  }
  return text
}
