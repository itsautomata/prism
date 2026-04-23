import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// detectGit is not exported directly, so we test via scanProject
// which calls detectGit internally
import { scanProject } from '../scanner.js'

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

describe('git detection', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prism-git-test-'))
    git(dir, 'init')
    git(dir, 'config user.email "test@test.com"')
    git(dir, 'config user.name "test"')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns null for non-git directory', () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'prism-nogit-'))
    const ctx = scanProject(nonGit)
    expect(ctx.git).toBeNull()
    rmSync(nonGit, { recursive: true, force: true })
  })

  it('detects branch name', () => {
    writeFileSync(join(dir, 'init.txt'), 'hello')
    git(dir, 'add .')
    git(dir, 'commit -m "init"')

    const ctx = scanProject(dir)
    expect(ctx.git).not.toBeNull()
    expect(ctx.git!.branch).toMatch(/main|master/)
  })

  it('detects clean repo', () => {
    writeFileSync(join(dir, 'init.txt'), 'hello')
    git(dir, 'add .')
    git(dir, 'commit -m "init"')

    const ctx = scanProject(dir)
    expect(ctx.git!.clean).toBe(true)
    expect(ctx.git!.statusLines).toEqual([])
    expect(ctx.git!.diffStat).toBeNull()
  })

  it('detects dirty repo with statusLines', () => {
    writeFileSync(join(dir, 'init.txt'), 'hello')
    git(dir, 'add .')
    git(dir, 'commit -m "init"')

    // modify tracked file
    writeFileSync(join(dir, 'init.txt'), 'changed')

    const ctx = scanProject(dir)
    expect(ctx.git!.clean).toBe(false)
    expect(ctx.git!.statusLines.length).toBeGreaterThan(0)
    expect(ctx.git!.statusLines.some(l => l.includes('init.txt'))).toBe(true)
  })

  it('detects untracked files in statusLines', () => {
    writeFileSync(join(dir, 'init.txt'), 'hello')
    git(dir, 'add .')
    git(dir, 'commit -m "init"')

    writeFileSync(join(dir, 'new.txt'), 'new file')

    const ctx = scanProject(dir)
    expect(ctx.git!.statusLines.some(l => l.startsWith('??') && l.includes('new.txt'))).toBe(true)
  })

  it('captures diffStat for modified files', () => {
    writeFileSync(join(dir, 'init.txt'), 'hello')
    git(dir, 'add .')
    git(dir, 'commit -m "init"')

    writeFileSync(join(dir, 'init.txt'), 'changed content here')

    const ctx = scanProject(dir)
    expect(ctx.git!.diffStat).not.toBeNull()
    expect(ctx.git!.diffStat).toContain('1 file changed')
  })

  it('diffStat is null when clean', () => {
    writeFileSync(join(dir, 'init.txt'), 'hello')
    git(dir, 'add .')
    git(dir, 'commit -m "init"')

    const ctx = scanProject(dir)
    expect(ctx.git!.diffStat).toBeNull()
  })

  it('captures recent commits', () => {
    writeFileSync(join(dir, 'a.txt'), 'a')
    git(dir, 'add .')
    git(dir, 'commit -m "first"')

    writeFileSync(join(dir, 'b.txt'), 'b')
    git(dir, 'add .')
    git(dir, 'commit -m "second"')

    const ctx = scanProject(dir)
    expect(ctx.git!.recentCommits.length).toBe(2)
    expect(ctx.git!.recentCommits[0]).toContain('second')
    expect(ctx.git!.recentCommits[1]).toContain('first')
  })

  it('caps statusLines at 10', () => {
    writeFileSync(join(dir, 'init.txt'), 'hello')
    git(dir, 'add .')
    git(dir, 'commit -m "init"')

    // create 15 untracked files
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(dir, `file${i}.txt`), `content ${i}`)
    }

    const ctx = scanProject(dir)
    expect(ctx.git!.statusLines.length).toBeLessThanOrEqual(10)
  })
})
