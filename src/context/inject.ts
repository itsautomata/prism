/**
 * format project context for system prompt injection.
 * compact. every line earns its place.
 */

import type { ProjectContext } from './types.js'

export function formatContext(ctx: ProjectContext): string {
  const lines: string[] = ['# project context']

  // project identity
  const { project } = ctx
  let identity = project.name
  if (project.language) identity += ` (${project.language})`
  if (project.framework) identity += ` / ${project.framework}`
  lines.push(identity)
  if (project.entryPoint) lines.push(`entry: ${project.entryPoint}`)

  // structure
  const { structure } = ctx
  lines.push(`${structure.totalFiles} files`)
  if (structure.directories.length > 0) {
    lines.push(`dirs: ${structure.directories.join(', ')}`)
  }

  // git
  if (ctx.git) {
    const { git } = ctx
    const status = git.clean ? 'clean' : 'uncommitted changes'
    lines.push(`branch: ${git.branch} (${status})`)
    if (git.recentCommits.length > 0) {
      lines.push(`last: ${git.recentCommits[0]}`)
    }
  }

  // deps
  if (ctx.deps.count > 0) {
    lines.push(`deps: ${ctx.deps.count} (${ctx.deps.file})`)
  }

  // prism state
  if (ctx.prism.learnedRules > 0) {
    lines.push(`learned rules: ${ctx.prism.learnedRules}`)
  }

  // lens.md — project-specific instructions, injected directly
  if (ctx.prism.lensContent) {
    lines.push('')
    lines.push('# project instructions (from lens.md)')
    lines.push(ctx.prism.lensContent)
  }

  return lines.join('\n')
}
