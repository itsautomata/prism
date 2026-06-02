/**
 * project context types.
 * what prism knows about the directory it's running in.
 */

export interface ProjectContext {
  project: ProjectInfo
  structure: StructureInfo
  git: GitInfo | null
  deps: DepsInfo
  prism: PrismState
  runtime: RuntimeInfo
  testing: TestingInfo
}

export interface ProjectInfo {
  name: string
  language: string | null
  framework: string | null
  entryPoint: string | null
}

export interface StructureInfo {
  totalFiles: number
  filesByType: Record<string, number>
  directories: string[]
  configFiles: string[]
}

export interface GitInfo {
  branch: string
  clean: boolean
  recentCommits: string[]
  remote: string | null
  statusLines: string[]
  diffStat: string | null
}

export interface DepsInfo {
  file: string | null
  count: number
  names: string[]
}

export interface PrismState {
  learnedRules: number
}

export interface RuntimeInfo {
  shell: string
  node: string | null
  python: string | null
  docker: boolean
}

/**
 * test-suite signal for the agent. populated by the scanner so the
 * Verify tool's caller (the model) can derive the right command without
 * guessing. `hasTests` is true when the walk found at least one test file.
 * `command` is the literal verbatim text from package.json scripts.test
 * (or null when not present); the model can use it, ignore it, or refine
 * it (e.g. `npx vitest run` instead of the unqualified `vitest`).
 */
export interface TestingInfo {
  hasTests: boolean
  testFileCount: number
  framework: string | null   // 'vitest' | 'pytest' | 'cargo-test' | 'go-test' | etc.
  command: string | null     // verbatim from package.json scripts.test, if present
}
