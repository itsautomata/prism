import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Box, useApp, useInput } from 'ink'
import { Banner } from './Banner.js'
import { MessageList, type DisplayMessage } from './MessageList.js'
import { PromptInput } from './PromptInput.js'
import type { Phase as SpinnerPhase } from './spinnerPhrases.js'
import { PermissionPrompt, type PermissionChoice } from './PermissionPrompt.js'
import { StatusBar } from './StatusBar.js'
import { query } from '../query/engine.js'
import { buildSystemPrompt } from '../prompts/system.js'
import { toolToSchema } from '../tools/Tool.js'
import { loadProfile, type ModelProfile } from '../learning/profile.js'
import { scanProject } from '../context/scanner.js'
import { saveSession } from '../sessions/store.js'
import type { Session } from '../sessions/types.js'
import { createAgentTool } from '../tools/agent.js'
import { createSkillTool } from '../tools/skill.js'
import type { AgentProgressEvent } from '../agents/runner.js'
import { handleSlashCommand } from './commands.js'
import type { SlashCommandSpec } from './commands.js'
import { handleBashCommand } from './bash.js'
import { switchModel } from './useModelSwitch.js'
import type { ProviderBridge, Message, ModelCapabilities } from '../types/index.js'
import type { Tool } from '../tools/Tool.js'
import type { ProjectContext } from '../context/types.js'
import type { Memory } from '../memory/inject.js'
import { listSkills } from '../skills/loader.js'
import { extractRepoMap, formatRepoMap } from '../retrieval/repomap.js'

interface AppProps {
  provider: ProviderBridge
  model: string
  tools: Tool[]
  capabilities: ModelCapabilities
  session: Session
  initialMessages?: Message[]
  projectContext?: ProjectContext
  memory?: Memory
  /**
   * per-session overrides for the repo-map retrieval pass. all fields optional:
   * undefined values fall back to config.tuning defaults. `skip: true` bypasses
   * extraction entirely (--no-repomap).
   */
  repoMapOverride?: {
    maxFiles?: number
    maxLines?: number
    skip?: boolean
  }
}

// filter internal messages when rebuilding display from session
const INTERNAL_PREFIXES = [
  'the command failed.',
  'the user interrupted',
  '[session summary]',
  '[earlier conversation was compressed',
  'the previous tool returned',
  'the previous tool call in this turn errored',
  'the search returned no results',
  '[recovery agent diagnosis]',
  'using the tool results above, answer the user',
  '[user ran in shell:',
  '[plan approved by user',
  '[the plan was abandoned by the user',
]

function rebuildDisplayMessages(messages?: Message[]): DisplayMessage[] {
  if (!messages || messages.length === 0) return []
  const display: DisplayMessage[] = []
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type !== 'text') continue
      if (INTERNAL_PREFIXES.some(p => block.text.startsWith(p))) continue
      if (msg.role === 'user') display.push({ role: 'user', text: block.text })
      else if (msg.role === 'assistant') display.push({ role: 'assistant', text: block.text })
    }
  }
  return display
}

export function App({ provider: initProvider, model: initModel, tools: baseTools, capabilities: initCaps, session, initialMessages, projectContext: initProjectContext, memory, repoMapOverride }: AppProps) {
  const [provider, setProvider] = useState<ProviderBridge>(initProvider)
  const [model, setModel] = useState(initModel)
  const [caps, setCaps] = useState(initCaps)
  const { exit } = useApp()

  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>(() => rebuildDisplayMessages(initialMessages))
  const [isLoading, setIsLoading] = useState(false)
  // synchronous re-entrancy guard for submits. isLoading is async react state
  // and flips a tick late, leaving a window where two fast Enters both submit.
  const submittingRef = useRef(false)
  const [turnCount, setTurnCount] = useState(0)
  const [tokenInfo, setTokenInfo] = useState('')
  const [spinnerPhase, setSpinnerPhase] = useState<SpinnerPhase>('thinking')
  const [spinnerTool, setSpinnerTool] = useState<string | undefined>(undefined)
  const [profile, setProfile] = useState<ModelProfile>(() => loadProfile(model))
  const [pendingPermission, setPendingPermission] = useState<{
    toolName: string; description: string; id: string; resolve: (choice: PermissionChoice) => void
  } | null>(null)
  const [abortController, setAbortController] = useState<AbortController | null>(null)
  const [inPlanMode, setInPlanMode] = useState(false)
  const [activeSkills, setActiveSkills] = useState<ReadonlySet<string>>(new Set())
  // tier-A repo map: computed once at session start, ambient in every system
  // prompt thereafter. failures (missing wasm dir, parse errors) leave the
  // string empty so the section is silently skipped.
  const [repoMap, setRepoMap] = useState<string>('')

  // projectContext is now passed in from cli.ts (so the user sees a startup
  // progress message during the scan). fall back to scanning here for any
  // caller that hasn't been updated yet.
  const [projectContext] = useState(() => initProjectContext ?? scanProject(process.cwd()))
  const [messages] = useState<Message[]>(() => initialMessages ? [...initialMessages] : [])

  // Agent tool is built once with the initial runtime context bound in closure.
  // its onProgress callback reaches into setDisplayMessages so subagent events
  // render as they happen. constructing here (not in cli.ts) keeps the UI
  // wiring colocated with the rest of the React state.
  const [agentTool] = useState<Tool>(() => createAgentTool({
    provider: initProvider,
    model: initModel,
    subagentTools: baseTools,
    cwd: process.cwd(),
    onProgress: (event: AgentProgressEvent) => {
      if (event.type === 'thinking') {
        setDisplayMessages(prev => {
          const last = prev[prev.length - 1]
          if (last?.role === 'tool_result' && last.text.startsWith(`[${event.agent}] `)) {
            return [...prev.slice(0, -1), { ...last, text: `[${event.agent}] ${event.text}` }]
          }
          return [...prev, { role: 'tool_result', text: `[${event.agent}] ${event.text}`, isError: false }]
        })
      } else if (event.type === 'tool_call') {
        setDisplayMessages(prev => [...prev, { role: 'tool_call', text: '', toolName: `${event.agent} → ${event.tool}` }])
      } else if (event.type === 'tool_result') {
        setDisplayMessages(prev => [...prev, { role: 'tool_result', text: `[${event.agent}] ${event.result}`, isError: event.isError }])
      }
    },
  }))

  const [skillTool] = useState<Tool>(() => createSkillTool(process.cwd()))

  // build the repo map once at startup. async, so it lands a bit after the
  // first render; downstream getSystemPrompt picks it up on the next call.
  // `repoMapOverride.skip` (set by --no-repomap) bypasses the whole pass.
  useEffect(() => {
    if (repoMapOverride?.skip) return
    let cancelled = false
    ;(async () => {
      try {
        const data = await extractRepoMap(process.cwd(), {
          ...(repoMapOverride?.maxFiles ? { maxFiles: repoMapOverride.maxFiles } : {}),
        })
        const formatted = formatRepoMap(data, {
          ...(repoMapOverride?.maxLines ? { maxLines: repoMapOverride.maxLines } : {}),
        })
        if (!cancelled) setRepoMap(formatted)
      } catch {
        // grammar wasms missing or extraction failed: skip silently. retrieval
        // is augmentation, not a hard requirement; the rest of prism works fine.
      }
    })()
    return () => { cancelled = true }
  }, [])

  const tools = useMemo(() => [...baseTools, agentTool, skillTool], [baseTools, agentTool, skillTool])
  const toolSchemas = useMemo(() => tools.map(t => toolToSchema(t)), [tools])

  const getSystemPrompt = useCallback(() => {
    const currentCaps: ModelCapabilities = {
      ...caps,
      ...(profile.maxToolsOverride ? { maxTools: profile.maxToolsOverride } : {}),
    }
    return buildSystemPrompt({
      capabilities: currentCaps,
      tools: toolSchemas,
      cwd: process.cwd(),
      profile,
      projectContext,
      memory,
      inPlanMode,
      activeSkills,
      repoMap,
    })
  }, [caps, toolSchemas, profile, memory, inPlanMode, activeSkills, repoMap])

  useInput((input, key) => {
    if (!isLoading && key.ctrl && input === 'c') { exit(); return }
    if (!isLoading) return
    // escape during an active permission prompt belongs to PermissionPrompt
    // (resolves the pending promise as 'deny'). don't double-fire by aborting here.
    if (key.escape && abortController && !pendingPermission) {
      abortController.abort()
      setDisplayMessages(prev => [...prev, { role: 'tool_result', text: 'interrupted by user. tell prism what to do instead.', isError: false }])
    }
  })

  // run the model loop on whatever's currently in `messages`. used by both
  // user-typed submissions and slash-command-triggered synthetic turns.
  const runModelLoop = useCallback(async () => {
    setTurnCount(prev => prev + 1)
    setIsLoading(true)
    setSpinnerPhase('thinking')
    setSpinnerTool(undefined)

    const controller = new AbortController()
    setAbortController(controller)

    const askPermission = (toolName: string, description: string, id: string) => {
      return new Promise<PermissionChoice>((resolve) => {
        setPendingPermission({ toolName, description, id, resolve })
      })
    }

    let currentText = ''

    try {
      for await (const event of query({
        provider, model, systemPrompt: getSystemPrompt(), tools, messages,
        maxTurns: 50, askPermission, signal: controller.signal,
      })) {
        switch (event.type) {
          case 'text':
            currentText += event.text
            setDisplayMessages(prev => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) { last.text = currentText }
              else { updated.push({ role: 'assistant', text: currentText, isStreaming: true }) }
              return updated
            })
            break
          case 'tool_start':
            setSpinnerPhase('running')
            setSpinnerTool(event.name)
            setDisplayMessages(prev => [...prev, { role: 'tool_call', text: '', toolName: event.name }])
            break
          case 'tool_end':
            setSpinnerPhase('after-tool')
            setSpinnerTool(event.name)
            setDisplayMessages(prev => [...prev, { role: 'tool_result', text: event.result, isError: event.isError }])
            currentText = ''
            break
          case 'token_update':
            setTokenInfo(event.formatted)
            break
          case 'done':
            // surface unusual exit reasons so silent failures don't look like the model went idle
            if (event.reason === 'empty_turn_cap') {
              setDisplayMessages(prev => [...prev, {
                role: 'tool_result',
                text: 'the model went silent after running tools (2 nudges, no answer). try a stronger model with /model, or rephrase the question.',
                isError: true,
              }])
            } else if (event.reason === 'max_turns') {
              setDisplayMessages(prev => [...prev, {
                role: 'tool_result',
                text: `max turns reached (${event.turnCount}). the model may be looping. try /clear or rephrase.`,
                isError: true,
              }])
            } else if (event.reason === 'user_denied') {
              setDisplayMessages(prev => [...prev, {
                role: 'tool_result',
                text: 'permission denied. tell prism what to do instead.',
                isError: false,
              }])
            }
            setTimeout(() => {
              setTurnCount(event.turnCount)
              setDisplayMessages(prev => prev.map(m => m.isStreaming ? { ...m, isStreaming: false } : m))
            }, 0)
            break
          case 'error':
            setDisplayMessages(prev => [...prev, { role: 'tool_result', text: event.error, isError: true }])
            break
        }
      }
    } catch (error) {
      const msg = (error as Error).message || String(error)
      if (!controller.signal.aborted) {
        setDisplayMessages(prev => [...prev, { role: 'tool_result', text: `error: ${msg}`, isError: true }])
      }
    }

    if (controller.signal.aborted) {
      messages.push({ role: 'user', content: [{ type: 'text', text: 'the user interrupted the current operation. stop what you were doing and ask what they want instead.' }] })
    }

    session.messages = messages
    // saveSession is synchronous and can hold the thread for tens of ms on
    // long conversations. flip the UI back to "ready" first; defer the save
    // to the next tick so the render lands before the disk write.
    setTimeout(() => { setAbortController(null); setIsLoading(false) }, 0)
    setTimeout(() => saveSession(session), 0)
  }, [provider, model, tools, messages, getSystemPrompt, session])

  // synthetic turn: push a hidden user message (filtered from UI display by
  // INTERNAL_PREFIXES) and invoke the model on it. used by /exec-plan and
  // /cancel-plan to give the model an explicit signal about what just happened.
  const triggerSyntheticTurn = useCallback((hiddenMsg: string) => {
    messages.push({ role: 'user', content: [{ type: 'text', text: hiddenMsg }] })
    runModelLoop()
  }, [messages, runModelLoop])

  // skill names for autocomplete in /run
  const invokeSkillSpecs: SlashCommandSpec[] = useMemo(() => {
    try {
      return listSkills(process.cwd())
        .filter(s => s.mode === 'invoke')
        .map(s => ({ name: s.name, desc: s.description, sections: s.sections.length > 0 ? s.sections : undefined }))
    } catch {
      return []
    }
  }, [])

  const handleSubmit = useCallback(async (input: string) => {
    if (input.startsWith('!')) {
      if (handleBashCommand(input, setDisplayMessages)) return
    }

    if (input.startsWith('/')) {
      const switchFn = (newModel: string) => switchModel(newModel, session, setProvider, setModel, setCaps, setDisplayMessages)
      const handled = handleSlashCommand(input, model, profile, setProfile, setDisplayMessages, exit, switchFn, {
        value: inPlanMode,
        set: setInPlanMode,
      }, triggerSyntheticTurn, process.cwd(), {
        active: activeSkills,
        setActive: setActiveSkills,
      })
      if (handled) return
    }

    // re-entrancy guard: two Enters in quick succession (key autorepeat, a
    // paste ending in \n\n) can both land here before isLoading deactivates the
    // input, pushing a duplicate turn and starting an overlapping model loop.
    if (submittingRef.current) return
    submittingRef.current = true
    try {
      setDisplayMessages(prev => [...prev, { role: 'user', text: input }])
      messages.push({ role: 'user', content: [{ type: 'text', text: input }] })
      await runModelLoop()
    } finally {
      submittingRef.current = false
    }
  }, [provider, model, tools, messages, getSystemPrompt, inPlanMode, triggerSyntheticTurn])

  return (
    <Box flexDirection="column" padding={1}>
      <Banner model={model} provider={provider.name} maxTools={caps.maxTools}
        rulesCount={profile.rules.length} isResumed={initialMessages !== undefined && initialMessages.length > 0}
        inPlanMode={inPlanMode} />
      <Box flexDirection="column" flexGrow={1}>
        <MessageList messages={displayMessages} />
        <PermissionPrompt toolName={pendingPermission?.toolName ?? null} description={pendingPermission?.description ?? null}
          onDecision={(choice) => { pendingPermission?.resolve(choice); setPendingPermission(null) }} />
      </Box>
      <StatusBar turnCount={turnCount} tokenInfo={tokenInfo} />
      <PromptInput onSubmit={handleSubmit} isLoading={isLoading} inPlanMode={inPlanMode}
        invokeSkills={invokeSkillSpecs} phase={spinnerPhase} currentTool={spinnerTool} />
    </Box>
  )
}
