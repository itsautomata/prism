import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Box, Static, useApp, useInput } from 'ink'
import { Banner } from './Banner.js'
import { MessageBlock, type DisplayMessage } from './MessageList.js'
import { Markdown } from './Markdown.js'
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
  /** reset ink's frame cache after a raw screen wipe (/clear, resize); see cli.ts. */
  inkClear?: () => void
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

export function App({ provider: initProvider, model: initModel, tools: baseTools, capabilities: initCaps, session, initialMessages, projectContext: initProjectContext, memory, inkClear, repoMapOverride }: AppProps) {
  const [provider, setProvider] = useState<ProviderBridge>(initProvider)
  const [model, setModel] = useState(initModel)
  const [caps, setCaps] = useState(initCaps)
  const { exit } = useApp()

  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>(() => rebuildDisplayMessages(initialMessages))
  // the in-flight assistant text. rendered live below the transcript, then
  // committed to displayMessages (and cleared) once the segment finalizes.
  const [streamingText, setStreamingText] = useState('')
  // bumping this remounts <Static> (via key), making it reprint every current
  // item — used to redraw cleanly after /clear and after a terminal resize.
  const [clearEpoch, setClearEpoch] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  // synchronous re-entrancy guard for submits. isLoading is async react state
  // and flips a tick late, leaving a window where two fast Enters both submit.
  const submittingRef = useRef(false)
  // one model loop at a time. guards every entry to runModelLoop (typed submit,
  // slash-triggered synthetic turn) so a re-entrant start cannot run two loops
  // over the same messages. synchronous because isLoading flips a tick late.
  const loopActiveRef = useRef(false)
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
  // the system prompt reads plan mode from this ref, not the state. /exec-plan
  // and /cancel-plan flip plan mode and trigger a turn in the same tick; state
  // would still be stale, so the turn would build with the old plan prompt.
  const planModeRef = useRef(false)
  const setPlanMode = useCallback((v: boolean) => {
    planModeRef.current = v
    setInPlanMode(v)
  }, [])
  // a /cancel-plan leaves this note; the next real user turn prepends it as
  // context so the model knows the plan was abandoned, without spinning up a
  // turn of its own. consumed (cleared) the first time it rides along.
  const pendingPlanNoteRef = useRef<string | null>(null)
  const clearArmedRef = useRef(false)
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

  // /clear is destructive: it wipes the model history and overwrites the saved
  // session. arm it on the first call; only an immediately-repeated /clear wipes.
  const clearConversation = useCallback(() => {
    if (!clearArmedRef.current) {
      clearArmedRef.current = true
      setDisplayMessages(prev => [...prev, {
        role: 'tool_result',
        text: 'clear the conversation? this wipes all context and cannot be undone. run /clear again to confirm, or type anything else to cancel.',
        isError: false,
      }])
      return
    }
    clearArmedRef.current = false
    messages.length = 0
    session.messages = messages
    setDisplayMessages([])
    setStreamingText('')
    setTokenInfo('')
    setTurnCount(0)
    // <Static> output is permanent; wipe screen + scrollback and remount Static
    // so /clear visually clears instead of leaving the old transcript behind.
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
    inkClear?.()
    setClearEpoch(e => e + 1)
    saveSession(session)
  }, [messages, session, inkClear])

  // a terminal resize reflows the committed <Static> output and desyncs ink's
  // frame, leaving artifacts (a repeated input border). debounce, then wipe and
  // remount so the whole view redraws cleanly at the new width.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const onResize = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H')
        inkClear?.()
        setClearEpoch(e => e + 1)
      }, 100)
    }
    process.stdout.on('resize', onResize)
    return () => { process.stdout.off('resize', onResize); if (t) clearTimeout(t) }
  }, [])

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
      inPlanMode: planModeRef.current,
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
    if (loopActiveRef.current) return
    loopActiveRef.current = true
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
        // only enforce verify-before-done when the project has a test suite.
        enforceVerify: projectContext.testing.hasTests,
      })) {
        switch (event.type) {
          case 'text':
            // accumulate into the live region only; commit on finalize.
            currentText += event.text
            setStreamingText(currentText)
            break
          case 'tool_start': {
            setSpinnerPhase('running')
            setSpinnerTool(event.name)
            const seg = currentText
            currentText = ''
            setStreamingText('')
            setDisplayMessages(prev => {
              const next = [...prev]
              if (seg) next.push({ role: 'assistant', text: seg })
              next.push({ role: 'tool_call', text: '', toolName: event.name })
              return next
            })
            break
          }
          case 'tool_end':
            setSpinnerPhase('after-tool')
            setSpinnerTool(event.name)
            currentText = ''
            setDisplayMessages(prev => [...prev, { role: 'tool_result', text: event.result, isError: event.isError }])
            break
          case 'token_update':
            setTokenInfo(event.formatted)
            break
          case 'done': {
            // surface unusual exit reasons so silent failures don't look like the model went idle
            const reasonMsg: DisplayMessage | null =
              event.reason === 'empty_turn_cap'
                ? { role: 'tool_result', text: 'the model went silent after running tools (2 nudges, no answer). try a stronger model with /model, or rephrase the question.', isError: true }
                : event.reason === 'max_turns'
                ? { role: 'tool_result', text: `max turns reached (${event.turnCount}). the model may be looping. try /clear or rephrase.`, isError: true }
                : event.reason === 'user_denied'
                ? { role: 'tool_result', text: 'permission denied. tell prism what to do instead.', isError: false }
                : null
            const seg = currentText
            currentText = ''
            setStreamingText('')
            setDisplayMessages(prev => {
              const next = [...prev]
              if (seg) next.push({ role: 'assistant', text: seg })
              if (reasonMsg) next.push(reasonMsg)
              return next
            })
            setTimeout(() => setTurnCount(event.turnCount), 0)
            break
          }
          case 'error': {
            const seg = currentText
            currentText = ''
            setStreamingText('')
            setDisplayMessages(prev => {
              const next = [...prev]
              if (seg) next.push({ role: 'assistant', text: seg })
              next.push({ role: 'tool_result', text: event.error, isError: true })
              return next
            })
            break
          }
        }
      }
    } catch (error) {
      const msg = (error as Error).message || String(error)
      if (!controller.signal.aborted) {
        setDisplayMessages(prev => [...prev, { role: 'tool_result', text: `error: ${msg}`, isError: true }])
      }
    }

    // safety net: if the loop ended without a 'done'/'error' (e.g. an abort
    // mid-stream), commit any uncommitted live text and clear the live region.
    if (currentText) {
      const seg = currentText
      setDisplayMessages(prev => [...prev, { role: 'assistant', text: seg }])
    }
    setStreamingText('')

    if (controller.signal.aborted) {
      messages.push({ role: 'user', content: [{ type: 'text', text: 'the user interrupted the current operation. stop what you were doing and ask what they want instead.' }] })
    }

    session.messages = messages
    // saveSession is synchronous and can hold the thread for tens of ms on
    // long conversations. flip the UI back to "ready" first; defer the save
    // to the next tick so the render lands before the disk write.
    setTimeout(() => { loopActiveRef.current = false; setAbortController(null); setIsLoading(false) }, 0)
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
    // any input other than a repeated /clear cancels a pending clear confirm.
    if (clearArmedRef.current && input.trim().split(/\s+/)[0] !== '/clear') {
      clearArmedRef.current = false
    }

    if (input.startsWith('!')) {
      if (handleBashCommand(input, setDisplayMessages)) return
    }

    if (input.startsWith('/')) {
      const switchFn = (newModel: string) => switchModel(newModel, session, setProvider, setModel, setCaps, setDisplayMessages)
      const handled = handleSlashCommand(input, model, profile, setProfile, setDisplayMessages, exit, switchFn, {
        value: inPlanMode,
        set: setPlanMode,
        note: (msg: string) => { pendingPlanNoteRef.current = msg },
      }, triggerSyntheticTurn, process.cwd(), {
        active: activeSkills,
        setActive: setActiveSkills,
      }, clearConversation)
      if (handled) return
    }

    // nothing to send: a stray Enter (e.g. the second of a double-Enter on a
    // slash command, after the buffer cleared) must not start a turn.
    if (!input.trim()) return

    // re-entrancy guard: two Enters in quick succession (key autorepeat, a
    // paste ending in \n\n) can both land here before isLoading deactivates the
    // input, pushing a duplicate turn and starting an overlapping model loop.
    if (submittingRef.current) return
    submittingRef.current = true
    try {
      setDisplayMessages(prev => [...prev, { role: 'user', text: input }])
      // a pending /cancel-plan note rides this turn as a leading context block
      // (same user message, so no consecutive-user-message issue), then clears.
      const note = pendingPlanNoteRef.current
      pendingPlanNoteRef.current = null
      const content = note
        ? [{ type: 'text' as const, text: note }, { type: 'text' as const, text: input }]
        : [{ type: 'text' as const, text: input }]
      messages.push({ role: 'user', content })
      await runModelLoop()
    } finally {
      submittingRef.current = false
    }
  }, [provider, model, tools, messages, getSystemPrompt, inPlanMode, triggerSyntheticTurn])

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column" flexGrow={1}>
        {/* banner + finalized messages render once into native scrollback (banner
            first so it stays at the top); only the live region below repaints. */}
        <Static key={clearEpoch} items={[
          { kind: 'banner' as const },
          ...displayMessages.map(message => ({ kind: 'message' as const, message })),
        ]}>
          {(row, i) => row.kind === 'banner'
            ? (
              <Banner key="banner" model={model} provider={provider.name} maxTools={caps.maxTools}
                rulesCount={profile.rules.length} isResumed={initialMessages !== undefined && initialMessages.length > 0}
                inPlanMode={inPlanMode} />
            )
            : <MessageBlock key={i} message={row.message} />}
        </Static>
        {streamingText.length > 0 && (
          <Box marginLeft={2}>
            <Markdown text={streamingText} />
          </Box>
        )}
        <PermissionPrompt toolName={pendingPermission?.toolName ?? null} description={pendingPermission?.description ?? null}
          onDecision={(choice) => { pendingPermission?.resolve(choice); setPendingPermission(null) }} />
      </Box>
      <StatusBar turnCount={turnCount} tokenInfo={tokenInfo} />
      <PromptInput onSubmit={handleSubmit} isLoading={isLoading} inPlanMode={inPlanMode}
        invokeSkills={invokeSkillSpecs} phase={spinnerPhase} currentTool={spinnerTool} />
    </Box>
  )
}
