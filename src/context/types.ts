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
  hasLensMd: boolean
  lensContent: string | null
  learnedRules: number
}

export interface RuntimeInfo {
  shell: string
  node: string | null
  python: string | null
  docker: boolean
}
