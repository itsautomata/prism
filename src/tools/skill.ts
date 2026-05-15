/**
 * skill tool.
 * lets the model invoke a skill autonomously: same logic as /run.
 * skills with `require-permission: true` in frontmatter gate on user approval.
 */

import { z } from 'zod'
import { buildTool, type ToolResult, type Tool } from './Tool.js'
import { loadSkill, SkillNotFoundError, SkillLoadError } from '../skills/loader.js'

export function createSkillTool(cwd: string): Tool<{ name: string; section?: string; task?: string }> {
  return buildTool({
    name: 'useSkill',
    description: 'invoke a skill by name, optionally with a section and task. skills are markdown files with instructions the model follows — like /run in the prompt. use when you need to follow a documented workflow.',
    inputSchema: z.object({
      name: z.string().describe('skill name (filename without .md)'),
      section: z.string().optional().describe('section heading to focus on'),
      task: z.string().optional().describe('optional task description for the skill'),
    }),
    call: async (input, context): Promise<ToolResult> => {
      const { name, section, task } = input

      let skill
      try {
        skill = loadSkill(name, cwd)
      } catch (e) {
        if (e instanceof SkillNotFoundError || e instanceof SkillLoadError) {
          return { content: `skill "${name}" not found. available: run /skill to list them.`, isError: true }
        }
        throw e
      }

      // passive-mode skills are already in the system prompt under `# active skills`.
      // re-injecting them as a tool result duplicates context and confuses framing.
      if (skill.mode !== 'invoke') {
        return {
          content: `skill "${name}" is passive-mode and either already active in the system prompt or available via /skill toggle. useSkill is for invoke-mode skills only.`,
          isError: true,
        }
      }

      // validate section if given
      let matchedSection: string | null = null
      if (section && skill.sections.length > 0) {
        matchedSection = skill.sections.find(s =>
          s.toLowerCase() === section.toLowerCase()
          || s.split(/\s+/).pop()?.replace(/[()]/g, '').toLowerCase() === section.toLowerCase()
        ) ?? null
        if (!matchedSection) {
          return { content: `section "${section}" not found in skill "${name}". available: ${skill.sections.join(', ')}`, isError: true }
        }
      }

      // build body: replace $ARGUMENTS, append section note and task
      let body = skill.body
      const sectionNote = matchedSection ? `\n\n[section: ${matchedSection}]` : ''
      const taskNote = task ? `\n\ntask: ${task}` : ''

      if (body.includes('$ARGUMENTS')) {
        body = body.replace(/\$ARGUMENTS/g, task || matchedSection || '')
      }

      body = body + sectionNote + taskNote

      return { content: `[invoking skill "${name}":\n\n${body}\n\nfollow the skill instructions.]` }
    },
    // not concurrency-safe: two parallel useSkill calls would race-inject two
    // "follow these instructions" tool results into the same conversation,
    // leaving the model with conflicting directives. serialize instead.
    isConcurrencySafe: () => false,
    // not read-only: the skill body lands in the conversation framed as
    // "follow these instructions," which drives downstream Edit/Write/Bash
    // calls. claiming read-only here short-circuits needsPermission() in
    // orchestration.ts:54, killing the `requirePermission` gate. flagging
    // false honors the operator's `require-permission: true` frontmatter.
    isReadOnly: () => false,
    checkPermissions: (input) => {
      try {
        const skill = loadSkill(input.name, cwd)
        if (skill.requirePermission) {
          return { behavior: 'ask', message: `run skill "${input.name}"${input.section ? ` (${input.section})` : ''}` }
        }
      } catch {
        // if skill can't be loaded, let the handler error out
      }
      return { behavior: 'allow' }
    },
  })
}
