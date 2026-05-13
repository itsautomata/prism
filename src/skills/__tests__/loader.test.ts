import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// redirect homedir() before importing the loader so user-scope lookups land
// inside a temp dir, never the operator's real ~/.prism.
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import {
  loadSkill,
  listSkills,
  SkillNotFoundError,
  SkillLoadError,
} from '../loader.js'

const USER_SKILLS_DIR = join(TEST_HOME, '.prism', 'skills')

let projectRoot: string
let projectSkillsDir: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'prism-skills-project-'))
  projectSkillsDir = join(projectRoot, 'skills')
  rmSync(USER_SKILLS_DIR, { recursive: true, force: true })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

function writeUserSkill(name: string, content: string): string {
  mkdirSync(USER_SKILLS_DIR, { recursive: true })
  const p = join(USER_SKILLS_DIR, `${name}.md`)
  writeFileSync(p, content, 'utf-8')
  return p
}

function writeProjectSkill(name: string, content: string): string {
  mkdirSync(projectSkillsDir, { recursive: true })
  const p = join(projectSkillsDir, `${name}.md`)
  writeFileSync(p, content, 'utf-8')
  return p
}

function exampleBody(): string {
  return `security review with OWASP-class vulnerability checks

when active, before suggesting any change:
1. read the file fully and trace data flow from input boundaries.
2. flag SSRF, injection, path traversal, auth bypass, secret leakage.
3. report file:line and severity for each finding.`
}

describe('loadSkill', () => {
  it('throws SkillNotFoundError when the name is unknown', () => {
    expect(() => loadSkill('does-not-exist', projectRoot)).toThrow(SkillNotFoundError)
  })

  it('reads a project-scoped skill', () => {
    writeProjectSkill('security', exampleBody())
    const skill = loadSkill('security', projectRoot)
    expect(skill.name).toBe('security')
    expect(skill.description).toBe('security review with OWASP-class vulnerability checks')
    expect(skill.body).toContain('trace data flow from input boundaries')
  })

  it('falls back to a user-scoped skill when no project file exists', () => {
    writeUserSkill('triage', `triage incoming issues by severity\n\nwhen active, sort issues into P0/P1/P2 and propose first responders.`)
    const skill = loadSkill('triage', projectRoot)
    expect(skill.name).toBe('triage')
    expect(skill.description).toContain('triage incoming issues')
  })

  it('project scope shadows user scope for the same name', () => {
    writeUserSkill('reviewer', 'from user scope\n\nuser body.')
    writeProjectSkill('reviewer', 'from project scope\n\nproject body.')
    const skill = loadSkill('reviewer', projectRoot)
    expect(skill.description).toBe('from project scope')
  })

  it('rejects an empty file with SkillLoadError', () => {
    writeUserSkill('hollow', '')
    expect(() => loadSkill('hollow', projectRoot)).toThrow(SkillLoadError)
  })

  it('uses the first line of the file as the description', () => {
    writeUserSkill('terse', 'one-line summary here\n\nactual instructions follow.')
    const skill = loadSkill('terse', projectRoot)
    expect(skill.description).toBe('one-line summary here')
  })

  it('includes the entire content in the body, not just the body after the description', () => {
    writeUserSkill('whole', `first line is the description

rest of the body lives here.`)
    const skill = loadSkill('whole', projectRoot)
    expect(skill.body).toContain('first line is the description')
    expect(skill.body).toContain('rest of the body lives here')
  })
})

describe('listSkills', () => {
  it('returns an empty array when nothing is defined', () => {
    expect(listSkills(projectRoot)).toEqual([])
  })

  it('returns project + user skills, deduped by name', () => {
    writeProjectSkill('refactor', 'refactor focus\n\nbody.')
    writeUserSkill('triage', 'triage incoming\n\nbody.')
    writeUserSkill('refactor', 'should be shadowed\n\nbody.')

    const skills = listSkills(projectRoot)
    const names = skills.map(s => s.name).sort()
    expect(names).toEqual(['refactor', 'triage'])

    const refactor = skills.find(s => s.name === 'refactor')!
    // the project version wins
    expect(refactor.description).toBe('refactor focus')
  })

  it('skips broken files instead of crashing the listing', () => {
    writeUserSkill('working', 'a working skill\n\nbody.')
    writeUserSkill('broken', '')

    const skills = listSkills(projectRoot)
    const names = skills.map(s => s.name)
    expect(names).toContain('working')
    expect(names).not.toContain('broken')
  })
})
