import React, { useState, useCallback } from 'react'
import { Box, useApp, useInput } from 'ink'
import { Banner } from './Banner.js'
import { MessageList, type DisplayMessage } from './MessageList.js'
import { PromptInput } from './PromptInput.js'
import { PermissionPrompt, type PermissionChoice } from './PermissionPrompt.js'
import { StatusBar } from './StatusBar.js'
import { query } from '../query/engine.js'
import { buildSystemPrompt } from '../prompts/system.js'
import { toolToSchema } from '../tools/Tool.js'
import { loadProfile, type ModelProfile } from '../learning/profile.js'
import { scanProject } from '../context/scanner.js'
import { saveSession } from '../sessions/store.js'
import type { Session } from '../sessions/types.js'
import { configureAgentTool } from '../tools/agent.js'
import type { AgentProgressEvent } from '../agents/runner.js'
import { handleSlashCommand } from './commands.js'
import { handleBashCommand } from './bash.js'
import { switchModel } from './useModelSwitch.js'
import type { ProviderBridge, Message, ModelCapabilities } from '../types/index.js'
import type { Tool } from '../tools/Tool.js'
import type { ProjectContext } from '../context/types.js'
import type { Memory } from '../memory/inject.js'

interface AppProps {
  provider: ProviderBridge
  model: string
  tools: Tool[]
  capabilities: ModelCapabilities
  session: Session
  initialMessages?: Message[]
  projectContext?: ProjectContext
  memory?: Memory
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

export function App({ provider: initProvider, model: initModel, tools, capabilities: initCaps, session, initialMessages, projectContext: initProjectContext, memory }: AppProps) {
  const [provider, setProvider] = useState<ProviderBridge>(initProvider)
  const [model, setModel] = useState(initModel)
  const [caps, setCaps] = useState(initCaps)
  const { exit } = useApp()

  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>(() => rebuildDisplayMessages(initialMessages))
  const [isLoading, setIsLoading] = useState(false)
  const [turnCount, setTurnCount] = useState(0)
  const [tokenInfo, setTokenInfo] = useState('')
  const [profile, setProfile] = useState<ModelProfile>(() => loadProfile(model))
  const [pendingPermission, setPendingPermission] = useState<{
    toolName: string; description: string; id: string; resolve: (choice: PermissionChoice) => void
  } | null>(null)
  const [abortController, setAbortController] = useState<AbortController | null>(null)
  const [inPlanMode, setInPlanMode] = useState(false)

  // projectContext is now passed in from cli.ts (so the user sees a startup
  // progress message during the scan). fall back to scanning here for any
  // caller that hasn't been updated yet.
  const [projectContext] = useState(() => initProjectContext ?? scanProject(process.cwd()))
  const [messages] = useState<Message[]>(() => initialMessages ? [...initialMessages] : [])
  const toolSchemas = tools.map(t => toolToSchema(t))

  // wire agent progress to display
  useState(() => {
    configureAgentTool(provider, model, tools, (event: AgentProgressEvent) => {
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
    })
  })

  const getSystemPrompt = useCallback(() => {
    const currentCaps: ModelCapabilities = {
      ...caps,
      ...(profile.maxToolsOverride ? { maxTools: profile.maxToolsOverride } : {}),
    }
    return buildSystemPrompt({ capabilities: currentCaps, tools: toolSchemas, cwd: process.cwd(), profile, projectContext, memory, inPlanMode })
  }, [caps, toolSchemas, profile, memory, inPlanMode])

  useInput((input, key) => {
    if (!isLoading && key.ctrl && input === 'c') { exit(); return }
    if (!isLoading) return
    if (key.escape && abortController) {
      abortController.abort()
      setDisplayMessages(prev => [...prev, { role: 'tool_result', text: 'interrupted by user', isError: false }])
    }
  })

  const handleSubmit = useCallback(async (input: string) => {
    if (input.startsWith('!')) {
      if (handleBashCommand(input, setDisplayMessages)) return
    }

    if (input.startsWith('/')) {
      const switchFn = (newModel: string) => switchModel(newModel, session, setProvider, setModel, setCaps, setDisplayMessages)
      const handled = handleSlashCommand(input, model, profile, setProfile, setDisplayMessages, exit, switchFn, { value: inPlanMode, set: setInPlanMode })
      if (handled) return
    }

    setDisplayMessages(prev => [...prev, { role: 'user', text: input }])
    setTurnCount(prev => prev + 1)
    setIsLoading(true)
    messages.push({ role: 'user', content: [{ type: 'text', text: input }] })

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
        maxTurns: 5, askPermission, signal: controller.signal,
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
            setDisplayMessages(prev => [...prev, { role: 'tool_call', text: '', toolName: event.name }])
            break
          case 'tool_end':
            setDisplayMessages(prev => [...prev, { role: 'tool_result', text: event.result, isError: event.isError }])
            currentText = ''
            break
          case 'token_update':
            setTokenInfo(event.formatted)
            break
          case 'done':
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
    saveSession(session)
    setTimeout(() => { setAbortController(null); setIsLoading(false) }, 0)
  }, [provider, model, tools, messages, getSystemPrompt])

  return (
    <Box flexDirection="column" padding={1}>
      <Banner model={model} provider={provider.name} maxTools={caps.maxTools}
        rulesCount={profile.rules.length} isResumed={initialMessages !== undefined && initialMessages.length > 0}
        inPlanMode={inPlanMode} />
      <Box flexDirection="column" flexGrow={1}>
        <MessageList messages={displayMessages} />
        {pendingPermission && (
          <PermissionPrompt toolName={pendingPermission.toolName} description={pendingPermission.description}
            onDecision={(choice) => { pendingPermission.resolve(choice); setPendingPermission(null) }} />
        )}
      </Box>
      <StatusBar turnCount={turnCount} tokenInfo={tokenInfo} />
      <PromptInput onSubmit={handleSubmit} isLoading={isLoading} />
    </Box>
  )
}
