/**
 * slash command handler.
 * extracted from App to keep it focused on rendering.
 */

import type React from 'react'
import { addRule, removeRule, setMaxTools, type ModelProfile } from '../learning/profile.js'
import { appendMemo, getProjectId } from '../memory/memo.js'
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
}

export const SLASH_COMMANDS: SlashCommandSpec[] = [
  { name: '/model', args: '<name>', desc: 'switch model mid-conversation (keeps context)' },
  { name: '/plan', desc: 'enter plan mode (model proposes before executing)' },
  { name: '/exec-plan', desc: 'exit plan mode and execute the plan' },
  { name: '/cancel-plan', desc: 'exit plan mode without executing' },
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
    /**
     * push a hidden user message into the conversation (filtered from the UI by
     * INTERNAL_PREFIXES) and invoke the model loop. used by /exec-plan and
     * /cancel-plan to give the model an explicit "what just happened" signal,
     * since neither slash command is visible to the model otherwise.
     */
    trigger?: (hiddenMsg: string) => void
  },
): boolean {
  const parts = input.split(' ')
  const cmd = parts[0]
  const args = parts.slice(1).join(' ')

  const info = (text: string) => {
    setMessages(prev => [...prev, { role: 'tool_result', text, isError: false }])
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
      const idx = parseInt(args) - 1
      if (isNaN(idx)) {
        info('usage: /forget <number>')
      } else {
        const updated = removeRule(model, idx)
        setProfile(updated)
        info('rule removed.')
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

    case '/help':
      info([
        'commands:',
        '  /model <name>     switch model (keeps conversation)',
        '  /teach <rule>     teach the model a rule (persisted)',
        '  /rules            show learned rules',
        '  /forget <n>       forget rule n',
        '  /max-tools <n>    set max tools',
        '  /help             this message',
        '  /exit             quit',
      ].join('\n'))
      return true

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
        planMode.trigger?.('[plan approved by user. execute the plan above. use Edit, Write, and Bash as needed.]')
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
        planMode.trigger?.('[the plan was abandoned by the user. ask why and what they want to do next instead.]')
      }
      return true

    case '/clear':
      setMessages([])
      return true

    default:
      return false
  }
}
