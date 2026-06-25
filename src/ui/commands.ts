/**
 * slash command handler.
 * extracted from App to keep it focused on rendering.
 */

import type React from 'react'
import { addRule, removeRule, setMaxTools, loadProfile, type ModelProfile } from '../learning/profile.js'
import { appendMemo, getProjectId } from '../memory/memo.js'
import { listAgents, resolveAgent, AgentNotFoundError, AgentValidationError } from '../agents/registry.js'
import { listSkills, loadSkill, SkillNotFoundError, SkillLoadError } from '../skills/loader.js'
import type { SkillMode } from '../skills/loader.js'
import type { DisplayMessage } from './MessageList.js'

/**
 * first source of truth for the slash commands. consumed by:
 * - handleSlashCommand (this file): the dispatcher
 * - SlashHints (the in-prompt completion dropdown)
 * - any future help / usage rendering
 */
export interface SlashCommandSpec {
  name: string
  args?: string
  desc: string
  /** `## heading` sections for third-token autocomplete (e.g. /run commit detail). */
  sections?: string[]
}

export const SLASH_COMMANDS: SlashCommandSpec[] = [
  { name: '/model', args: '<name>', desc: 'switch model mid-conversation (keeps context)' },
  { name: '/plan', desc: 'enter plan mode (model proposes before executing)' },
  { name: '/exec-plan', desc: 'exit plan mode and execute the plan' },
  { name: '/cancel-plan', desc: 'exit plan mode without executing' },
  { name: '/agent', args: '[name] [task]', desc: 'list agents, show one, or invoke a named subagent' },
  { name: '/skill', args: '[name|clear]', desc: 'list all skills or toggle/clear passive skills' },
  { name: '/run', args: '<name> [section] [task]', desc: 'invoke a skill one-shot' },
  { name: '/teach', args: '<rule>', desc: 'teach the model a rule (persisted)' },
  { name: '/rules', desc: 'show learned rules' },
  { name: '/forget', args: '<n>', desc: 'forget rule n' },
  { name: '/max-tools', args: '<n>', desc: 'set max tools for this model' },
  { name: '/remember', args: '<fact>', desc: 'add a fact to project memo (timestamped)' },
  { name: '/clear', desc: 'clear the conversation' },
  { name: '/help', desc: 'show commands' },
  { name: '/exit', desc: 'quit' },
]

/**
 * filter slash commands by case-insensitive prefix on the command name.
 * caller is responsible for deciding when to call (e.g. only when the buffer
 * starts with `/` and contains no spaces yet). returns [] for any input that
 * doesn't begin with `/`, treating non-slash input as "no completions to offer".
 */
export function filterSlashCommands(query: string): SlashCommandSpec[] {
  if (!query.startsWith('/')) return []
  const q = query.toLowerCase()
  return SLASH_COMMANDS.filter(c => c.name.toLowerCase().startsWith(q))
}

export type SwitchModelFn = (newModel: string) => Promise<void>

/**
 * push a hidden user message into the conversation and invoke the model loop.
 * used by /exec-plan, /cancel-plan, and /agent to give the model an explicit
 * "what just happened" signal, since slash commands are not visible to it
 * otherwise. the host filters these messages from the UI (see INTERNAL_PREFIXES).
 */
export type SlashTriggerFn = (hiddenMsg: string) => void

export function handleSlashCommand(
  input: string,
  model: string,
  profile: ModelProfile,
  setProfile: (p: ModelProfile) => void,
  setMessages: React.Dispatch<React.SetStateAction<DisplayMessage[]>>,
  exit: () => void,
  switchModel?: SwitchModelFn,
  planMode?: {
    value: boolean
    set: (v: boolean) => void
  },
  trigger?: SlashTriggerFn,
  cwd?: string,
  skills?: {
    active: ReadonlySet<string>
    setActive: (next: Set<string>) => void
  },
): boolean {
  const parts = input.split(' ')
  const cmd = parts[0]
  const args = parts.slice(1).join(' ')

  const info = (text: string, color?: string) => {
    setMessages(prev => [...prev, { role: 'tool_result', text, isError: false, color }])
  }

  switch (cmd) {
    case '/exit':
    case '/quit':
      exit()
      return true

    case '/teach':
      if (!args) {
        info('usage: /teach <rule>')
      } else {
        const updated = addRule(model, args)
        setProfile(updated)
        info(`learned: "${args}" (${updated.rules.length} rules for ${model})`)
      }
      return true

    case '/forget': {
      const raw = args.trim()
      const idx = parseInt(raw, 10) - 1
      // reject non-integer args ("3abc" → parseInt 3 would delete the wrong rule)
      if (!/^\d+$/.test(raw)) {
        info('usage: /forget <number> (see /rules)')
      } else {
        // bounds-check against disk truth (what removeRule operates on), not the
        // passed profile which may be stale. a no-op means the index was invalid.
        const before = loadProfile(model).rules.length
        const updated = removeRule(model, idx)
        if (updated.rules.length === before) {
          info(`no rule #${raw}. you have ${before} rule${before === 1 ? '' : 's'} (see /rules).`)
        } else {
          setProfile(updated)
          info('rule removed.')
        }
      }
      return true
    }

    case '/rules':
      if (profile.rules.length === 0) {
        info(`no learned rules for ${model}. use /teach to add one.`)
      } else {
        const lines = profile.rules.map((r, i) => `${i + 1}. ${r.rule}`).join('\n')
        info(`learned rules for ${model}:\n${lines}`)
      }
      return true

    case '/max-tools': {
      const n = parseInt(args)
      if (isNaN(n) || n < 1) {
        info('usage: /max-tools <number>')
      } else {
        const updated = setMaxTools(model, n)
        setProfile(updated)
        info(`max tools set to ${n} for ${model}`)
      }
      return true
    }

    case '/model':
      if (!args) {
        info(`current model: ${model}\nusage: /model <name> (e.g. /model qwen3:14b, /model deepseek/deepseek-r1)`)
      } else if (switchModel) {
        switchModel(args).catch(e => info(`failed: ${(e as Error).message}`))
      }
      return true

    case '/help': {
      // derived from SLASH_COMMANDS so it cannot drift when commands are added
      const lines = ['commands:']
      for (const c of SLASH_COMMANDS) {
        const left = c.args ? `${c.name} ${c.args}` : c.name
        lines.push(`  ${left.padEnd(22)} ${c.desc}`)
      }
      lines.push('')
      lines.push('shell escape:')
      lines.push('  !<cmd>                 run <cmd> in the shell (output stays here, model never sees it)')
      info(lines.join('\n'))
      return true
    }

    case '/remember':
      if (!args) {
        info('usage: /remember <fact>')
      } else {
        try {
          const id = getProjectId(process.cwd())
          appendMemo(id, args)
          info(`remembered: "${args}" (saved to ~/.prism/projects/${id}/memo.md)`)
        } catch (e) {
          info(`failed to save: ${(e as Error).message}`)
        }
      }
      return true

    case '/plan':
      if (!planMode) {
        info('plan mode is not available in this build.')
      } else if (planMode.value) {
        info('already in plan mode. propose a plan, then `/exec-plan` to execute or `/cancel-plan` to abandon.')
      } else {
        planMode.set(true)
        info('plan mode: on. the model will research and propose a plan. type `/exec-plan` to execute, `/cancel-plan` to abandon, or keep talking to revise.')
      }
      return true

    case '/exec-plan':
      if (!planMode) {
        info('plan mode is not available in this build.')
      } else if (!planMode.value) {
        info('not in plan mode. use `/plan` first.')
      } else {
        planMode.set(false)
        info('plan mode: off. executing.')
        trigger?.('[plan approved by user. execute the plan above. use Edit, Write, and Bash as needed.]')
      }
      return true

    case '/cancel-plan':
      if (!planMode) {
        info('plan mode is not available in this build.')
      } else if (!planMode.value) {
        info('not in plan mode.')
      } else {
        planMode.set(false)
        info('plan mode: off. plan abandoned.')
        trigger?.('[the plan was abandoned by the user. ask why and what they want to do next instead.]')
      }
      return true

    case '/agent': {
      const cwdToUse = cwd ?? process.cwd()
      const agentArgs = args.trim().split(/\s+/).filter(Boolean)

      // /agent → list available agents.
      if (agentArgs.length === 0) {
        try {
          const agents = listAgents(cwdToUse)
          const lines = ['available agents:']
          for (const a of agents) {
            lines.push(`  ${a.name.padEnd(22)} ${a.description}`)
          }
          lines.push('')
          lines.push('usage: /agent <name>          show details')
          lines.push('       /agent <name> <task>   invoke directly')
          info(lines.join('\n'))
        } catch (e) {
          info(`failed to list agents: ${(e as Error).message}`)
        }
        return true
      }

      const name = agentArgs[0]!
      const task = agentArgs.slice(1).join(' ')

      // /agent <name> → show details (works for built-ins including recovery).
      if (!task) {
        try {
          const a = resolveAgent(name, cwdToUse)
          const tools = a.tools === '*' ? '* (inherits parent)' : a.tools.join(', ')
          const lines = [
            `agent: ${a.name}`,
            `  description: ${a.description}`,
            `  tools: ${tools}`,
            `  permissions: ${a.permissions}`,
            `  max turns: ${a.maxTurns}`,
          ]
          if (a.model) lines.push(`  model: ${a.model}`)
          lines.push('')
          lines.push('system prompt (first 5 lines):')
          const preview = a.systemPrompt.split('\n').slice(0, 5).map(l => `  ${l}`).join('\n')
          lines.push(preview)
          info(lines.join('\n'))
        } catch (e) {
          if (e instanceof AgentNotFoundError || e instanceof AgentValidationError) {
            info(e.message)
          } else {
            info(`failed to show agent: ${(e as Error).message}`)
          }
        }
        return true
      }

      // /agent <name> <task> → ask the model to spawn the named subagent.
      // recovery is the engine's internal flow; reject direct invocation here
      // rather than waiting for the Agent tool to bounce it later.
      if (name === 'recovery') {
        info('"recovery" is reserved for the engine\'s automatic recovery flow and cannot be invoked directly.')
        return true
      }

      if (!trigger) {
        info('agent invocation is not available in this build.')
        return true
      }

      try {
        resolveAgent(name, cwdToUse)
      } catch (e) {
        if (e instanceof AgentNotFoundError || e instanceof AgentValidationError) {
          info(e.message)
          return true
        }
        throw e
      }

      info(`invoking ${name}...`)
      trigger(`[the operator invoked /agent ${name} with this task: ${task}

use the Agent tool to spawn the ${name} subagent with this task. pass agent: "${name}" and report its findings back to the operator.]`)
      return true
    }

    case '/run': {
      const cwdToUse = cwd ?? process.cwd()
      const runArgs = args.trim().split(/\s+/).filter(Boolean)

      if (runArgs.length === 0) {
        info('usage: /run <skill-name> [section] [task...]')
        info('run /skill to see available skills.')
        return true
      }

      const name = runArgs[0]!

      // load skill first so we can check sections
      let skill
      try {
        skill = loadSkill(name, cwdToUse)
      } catch (e) {
        if (e instanceof SkillNotFoundError || e instanceof SkillLoadError) {
          info(e.message)
          return true
        }
        throw e
      }

      // match section by ## heading. precedence:
      //   second position == heading (or its last word) → exclude args[1] from task
      //   full rest == heading → entire arg string was the section, task is empty
      //   last position == heading's last word → exclude args[last] from task
      // tracking which position the section occupied prevents the section keyword
      // from leaking into the task string when it was matched at the end.
      const second = runArgs[1]
      const rest = runArgs.slice(1).join(' ').toLowerCase()
      const lastIdx = runArgs.length - 1
      const lastToken = runArgs[lastIdx]?.toLowerCase().replace(/[()]/g, '') ?? ''

      let section: string | null = null
      let sectionPos: 'second' | 'all' | 'last' | null = null

      if (second && skill.sections.length > 0) {
        for (const s of skill.sections) {
          const sLower = s.toLowerCase()
          const lastWord = (s.split(/\s+/).pop() ?? '').replace(/[()]/g, '').toLowerCase()
          if (sLower === second.toLowerCase() || lastWord === second.toLowerCase()) {
            section = s; sectionPos = 'second'; break
          }
          if (sLower === rest) {
            section = s; sectionPos = 'all'; break
          }
          if (lastWord === lastToken) {
            section = s; sectionPos = 'last'; break
          }
        }
      }

      const task = !section ? runArgs.slice(1).join(' ')
        : sectionPos === 'all' ? ''
        : sectionPos === 'second' ? runArgs.slice(2).join(' ')
        : runArgs.slice(1, lastIdx).join(' ')

      if (!trigger) {
        info('skill invocation is not available in this build.')
        return true
      }

      // build body: replace $ARGUMENTS, append task, note section
      let body = skill.body
      const sectionNote = section ? `\n\n[section: ${section}]` : ''
      const taskNote = task ? `\n\ntask: ${task}` : ''

      if (body.includes('$ARGUMENTS')) {
        body = body.replace(/\$ARGUMENTS/g, task || section || '')
      }

      body = body + sectionNote + taskNote
      info(`invoking skill "${name}"${section ? ` (${section})` : ''}...`)
      trigger(`[the operator invoked the /${name} skill:\n\n${body}\n\nfollow the skill instructions. this is a one-shot invocation, not a persistent mode change.]`)
      return true
    }

    case '/skill': {
      const cwdToUse = cwd ?? process.cwd()
      const skillArgs = args.trim().split(/\s+/).filter(Boolean)

      // /skill → list all skills with color
      if (skillArgs.length === 0) {
        try {
          const all = listSkills(cwdToUse)
          if (all.length === 0) {
            info('no skills defined yet. drop a file at <cwd>/skills/<name>.md or ~/.prism/skills/<name>.md.')
            return true
          }

          info('available skills:')
          const passive = all.filter(s => s.mode === 'passive')
          const invoke = all.filter(s => s.mode === 'invoke')

          // passive skills in cyan
          if (passive.length > 0) {
            const lines: string[] = []
            for (const s of passive) {
              const marker = skills?.active.has(s.name) ? '* ' : '  '
              lines.push(`  ${marker}${s.name.padEnd(22)} ${s.description}`)
            }
            info(lines.join('\n'), '#00ddff')
          }

          // invoke skills in green
          if (invoke.length > 0) {
            const lines: string[] = []
            for (const s of invoke) {
              lines.push(`  ${s.name.padEnd(22)} ${s.description}`)
            }
            info(lines.join('\n'), '#00ff88')
          }

          info('usage: /skill <name>   toggle a passive skill on/off')
          info('       /skill clear    deactivate all passive skills')
          info('       /run <name>     invoke a skill one-shot')
        } catch (e) {
          info(`failed to list skills: ${(e as Error).message}`)
        }
        return true
      }

      // /skill clear → deactivate all
      if (skillArgs[0] === 'clear') {
        if (!skills) {
          info('skill state is not available in this build.')
          return true
        }
        if (skills.active.size === 0) {
          info('no skills were active.')
          return true
        }
        skills.setActive(new Set())
        info('all passive skills deactivated.')
        return true
      }

      // /skill <name> → toggle (only passive-mode skills allowed)
      const name = skillArgs[0]!
      if (!skills) {
        info('skill state is not available in this build.')
        return true
      }

      // validate and check mode
      let skill
      try {
        skill = loadSkill(name, cwdToUse)
      } catch (e) {
        if (e instanceof SkillNotFoundError || e instanceof SkillLoadError) {
          info(e.message)
          return true
        }
        throw e
      }

      if (skill.mode !== 'passive') {
        info(`skill "${name}" is not a passive skill. use /run ${name} to invoke it one-shot.`)
        return true
      }

      if (skills.active.has(name)) {
        const next = new Set(skills.active)
        next.delete(name)
        skills.setActive(next)
        info(`skill "${name}" deactivated.`)
        return true
      }

      const next = new Set(skills.active)
      next.add(name)
      skills.setActive(next)
      info(`skill "${name}" activated.`)
      return true
    }

    case '/clear':
      setMessages([])
      return true

    default:
      return false
  }
}
