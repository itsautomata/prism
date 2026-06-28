import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// redirect homedir() before importing the registry so user-scope lookups land
// inside a temp dir, never the operator's real ~/.prism.
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import {
  resolveAgent,
  listAgents,
  loadDefinition,
  AgentNotFoundError,
  AgentValidationError,
} from '../registry.js'
import { DEFAULT_AGENT, RECOVERY_AGENT } from '../definition.js'

const USER_AGENTS_DIR = join(TEST_HOME, '.prism', 'agents')

let projectRoot: string
let projectAgentsDir: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'prism-registry-project-'))
  projectAgentsDir = join(projectRoot, 'agents')
  rmSync(USER_AGENTS_DIR, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

function writeUserAgent(name: string, content: string): string {
  mkdirSync(USER_AGENTS_DIR, { recursive: true })
  const p = join(USER_AGENTS_DIR, `${name}.md`)
  writeFileSync(p, content, 'utf-8')
  return p
}

function writeProjectAgent(name: string, content: string): string {
  mkdirSync(projectAgentsDir, { recursive: true })
  const p = join(projectAgentsDir, `${name}.md`)
  writeFileSync(p, content, 'utf-8')
  return p
}

function fullAgentBody(): string {
  return `---
description: review code for OWASP-class vulnerabilities; never edits
tools: [Read, Glob, Grep, Bash]
permissions: deny-writes
max_turns: 8
model: anthropic/claude-haiku-4.5
---

you are a focused security auditor. report file:line and severity.`
}

function minimalBody(): string {
  return `---
description: a minimal agent that relies on defaults
---

you are a minimal agent. respond concisely.`
}

describe('resolveAgent', () => {
  it('returns DEFAULT_AGENT for undefined name', () => {
    expect(resolveAgent(undefined, projectRoot)).toBe(DEFAULT_AGENT)
  })

  it('returns DEFAULT_AGENT for the literal "default"', () => {
    expect(resolveAgent('default', projectRoot)).toBe(DEFAULT_AGENT)
  })

  it('returns RECOVERY_AGENT for "recovery"', () => {
    expect(resolveAgent('recovery', projectRoot)).toBe(RECOVERY_AGENT)
  })

  it('throws AgentNotFoundError when the name is unknown', () => {
    expect(() => resolveAgent('does-not-exist', projectRoot)).toThrow(AgentNotFoundError)
  })

  it('rejects a path-traversing name instead of reading outside the agents dirs', () => {
    // a valid agent file planted one level above the agents dir; "../evil"
    // would resolve to <projectRoot>/evil.md without confinement.
    writeFileSync(join(projectRoot, 'evil.md'), fullAgentBody(), 'utf-8')
    expect(() => resolveAgent('../evil', projectRoot)).toThrow(AgentNotFoundError)
  })

  it('finds a project-scoped agent', () => {
    writeProjectAgent('security-auditor', fullAgentBody())
    const agent = resolveAgent('security-auditor', projectRoot)
    expect(agent.name).toBe('security-auditor')
    expect(agent.tools).toEqual(['Read', 'Glob', 'Grep', 'Bash'])
    expect(agent.permissions).toBe('deny-writes')
    expect(agent.maxTurns).toBe(8)
    expect(agent.model).toBe('anthropic/claude-haiku-4.5')
  })

  it('falls back to a user-scoped agent when no project file exists', () => {
    writeUserAgent('researcher', minimalBody())
    const agent = resolveAgent('researcher', projectRoot)
    expect(agent.name).toBe('researcher')
    expect(agent.description).toContain('minimal agent')
  })

  it('project scope shadows user scope for the same name', () => {
    writeUserAgent('reviewer', `---
description: from user scope
---
user body.`)
    writeProjectAgent('reviewer', `---
description: from project scope
---
project body.`)
    const agent = resolveAgent('reviewer', projectRoot)
    expect(agent.description).toBe('from project scope')
  })

  it('reserved built-in names cannot be overridden by user files', () => {
    writeUserAgent('recovery', minimalBody())
    // resolveAgent should still return the built-in, never touching the file.
    expect(resolveAgent('recovery', projectRoot)).toBe(RECOVERY_AGENT)
  })
})

describe('listAgents', () => {
  it('returns at least the built-in default when no user files exist', () => {
    const agents = listAgents(projectRoot)
    expect(agents).toContain(DEFAULT_AGENT)
    expect(agents.find(a => a.name === RECOVERY_AGENT.name)).toBeUndefined()
  })

  it('includes both project and user agents, deduped by name', () => {
    writeProjectAgent('refactorer', minimalBody())
    writeUserAgent('researcher', minimalBody())
    writeUserAgent('refactorer', minimalBody()) // duplicate of project; project wins

    const agents = listAgents(projectRoot)
    const names = agents.map(a => a.name).sort()
    expect(names).toEqual(['default', 'refactorer', 'researcher'])
  })

  it('skips broken files instead of crashing the listing', () => {
    writeUserAgent('working', minimalBody())
    writeUserAgent('broken', `not even close to valid frontmatter`)

    const agents = listAgents(projectRoot)
    const names = agents.map(a => a.name)
    expect(names).toContain('working')
    expect(names).not.toContain('broken')
  })
})

describe('loadDefinition: defaults', () => {
  it('fills defaults for a minimal file with only a description', () => {
    const path = writeUserAgent('minimal', minimalBody())
    const agent = loadDefinition(path)
    expect(agent.name).toBe('minimal')
    expect(agent.description).toBe('a minimal agent that relies on defaults')
    expect(agent.tools).toBe('*')
    expect(agent.permissions).toBe('deny-writes')
    expect(agent.maxTurns).toBe(5)
    expect(agent.model).toBeUndefined()
  })

  it('synthesizes a description when one is not provided', () => {
    const path = writeUserAgent('skeleton', `---
---

you are a skeleton agent.`)
    const agent = loadDefinition(path)
    expect(agent.description).toBe('user-defined agent skeleton')
  })

  it('parses tools as an inline array', () => {
    const path = writeUserAgent('reader', `---
description: read-only research
tools: [Read, Glob, Grep]
---
research only.`)
    const agent = loadDefinition(path)
    expect(agent.tools).toEqual(['Read', 'Glob', 'Grep'])
  })

  it('parses tools as the wildcard string', () => {
    const path = writeUserAgent('wide', `---
description: wide tool access
tools: '*'
---
do everything.`)
    const agent = loadDefinition(path)
    expect(agent.tools).toBe('*')
  })
})

describe('loadDefinition: validation', () => {
  it('rejects a file with no frontmatter delimiter', () => {
    const path = writeUserAgent('no-frontmatter', 'just a body, no fence at the top.')
    expect(() => loadDefinition(path)).toThrow(AgentValidationError)
  })

  it('rejects a file with an unterminated frontmatter block', () => {
    const path = writeUserAgent('open-ended', `---
description: forgot to close the frontmatter
the body is here but the fence never closes.`)
    expect(() => loadDefinition(path)).toThrow(/unterminated frontmatter/)
  })

  it('rejects an empty body', () => {
    const path = writeUserAgent('hollow', `---
description: hollow agent
---
`)
    expect(() => loadDefinition(path)).toThrow(/system prompt body is empty/)
  })

  it('rejects a frontmatter name that does not match the filename', () => {
    const path = writeUserAgent('alpha', `---
name: beta
description: name disagreement
---
body content.`)
    expect(() => loadDefinition(path)).toThrow(/does not match filename/)
  })

  it('rejects an invalid permissions value', () => {
    const path = writeUserAgent('bad-perms', `---
description: bad permissions
permissions: yolo
---
body content.`)
    expect(() => loadDefinition(path)).toThrow(/permissions must be one of/)
  })

  it('rejects max_turns that is not a positive integer', () => {
    const path = writeUserAgent('bad-turns', `---
description: bad turns
max_turns: -3
---
body content.`)
    expect(() => loadDefinition(path)).toThrow(/positive integer/)
  })

  it('rejects reserved names', () => {
    const path = writeUserAgent('default', minimalBody())
    expect(() => loadDefinition(path)).toThrow(/reserved/)
  })
})
