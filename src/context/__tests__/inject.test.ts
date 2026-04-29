import { describe, it, expect } from 'vitest'
import { formatContext } from '../inject.js'
import type { ProjectContext } from '../types.js'

function makeContext(overrides: Partial<ProjectContext> = {}): ProjectContext {
  return {
    project: { name: 'test-project', language: 'typescript', framework: 'react', entryPoint: 'src/index.ts' },
    structure: { totalFiles: 42, filesByType: {}, directories: ['src', 'tests'], configFiles: [] },
    git: null,
    deps: { file: 'package.json', count: 5, names: [] },
    prism: { learnedRules: 0 },
    runtime: { shell: 'zsh', node: '20.0.0', python: null, docker: false },
    ...overrides,
  }
}

describe('formatContext', () => {
  it('includes project identity', () => {
    const output = formatContext(makeContext())
    expect(output).toContain('test-project (typescript) / react')
    expect(output).toContain('entry: src/index.ts')
  })

  it('omits git section when null', () => {
    const output = formatContext(makeContext({ git: null }))
    expect(output).not.toContain('branch:')
  })

  it('shows minimal output for clean repo', () => {
    const output = formatContext(makeContext({
      git: {
        branch: 'main',
        clean: true,
        recentCommits: ['abc1234 init commit'],
        remote: null,
        statusLines: [],
        diffStat: null,
      },
    }))
    expect(output).toContain('branch: main (clean)')
    expect(output).toContain('last: abc1234 init commit')
    expect(output).not.toContain('status:')
    expect(output).not.toContain('diff:')
  })

  it('shows full git state for dirty repo', () => {
    const output = formatContext(makeContext({
      git: {
        branch: 'feature',
        clean: false,
        recentCommits: ['abc1234 first', 'def5678 second', 'ghi9012 third'],
        remote: 'https://github.com/test/repo.git',
        statusLines: [' M src/foo.ts', '?? new.txt'],
        diffStat: '2 files changed, 10 insertions(+), 3 deletions(-)',
      },
    }))
    expect(output).toContain('branch: feature (2 uncommitted changes)')
    expect(output).toContain('status:')
    expect(output).toContain(' M src/foo.ts')
    expect(output).toContain('?? new.txt')
    expect(output).toContain('recent commits:')
    expect(output).toContain('abc1234 first')
    expect(output).toContain('diff: 2 files changed, 10 insertions(+), 3 deletions(-)')
  })

  it('shows singular "change" for one modified file', () => {
    const output = formatContext(makeContext({
      git: {
        branch: 'main',
        clean: false,
        recentCommits: [],
        remote: null,
        statusLines: [' M only.ts'],
        diffStat: '1 file changed, 1 insertion(+)',
      },
    }))
    expect(output).toContain('1 uncommitted change)')
    expect(output).not.toContain('changes)')
  })

  it('shows max 3 recent commits in dirty state', () => {
    const output = formatContext(makeContext({
      git: {
        branch: 'main',
        clean: false,
        recentCommits: ['a first', 'b second', 'c third', 'd fourth', 'e fifth'],
        remote: null,
        statusLines: [' M file.ts'],
        diffStat: null,
      },
    }))
    expect(output).toContain('a first')
    expect(output).toContain('b second')
    expect(output).toContain('c third')
    expect(output).not.toContain('d fourth')
  })
})
