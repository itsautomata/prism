import React, { useState, useCallback } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { Banner } from './Banner.js'
import { MessageList, type DisplayMessage } from './MessageList.js'
import { PromptInput } from './PromptInput.js'
import { PermissionPrompt, type PermissionChoice } from './PermissionPrompt.js'
import { StatusBar } from './StatusBar.js'
import { theme } from './theme.js'
import { query } from '../query/engine.js'
import { buildSystemPrompt } from '../prompts/system.js'
import { toolToSchema } from '../tools/Tool.js'
import { loadProfile, addRule, removeRule, setMaxTools, type ModelProfile } from '../learning/profile.js'
import { scanProject } from '../context/scanner.js'
import { saveSession } from '../sessions/store.js'
import type { Session } from '../sessions/types.js'
import { OllamaProvider } from '../providers/ollama.js'
import { OpenRouterProvider } from '../providers/openrouter.js'
import { loadConfig } from '../config/config.js'
import { configureAgentTool } from '../tools/agent.js'
import type { AgentProgressEvent } from '../agents/runner.js'
import type { ProviderBridge, Message, ModelCapabilities } from '../types/index.js'
import type { Tool } from '../tools/Tool.js'

interface AppProps {
  provider: ProviderBridge
  model: string
  tools: Tool[]
  capabilities: ModelCapabilities
  session: Session
  initialMessages?: Message[]
}

export function App({ provider: initProvider, model: initModel, tools, capabilities: initCaps, session, initialMessages }: AppProps) {
  const [provider, setProvider] = useState<ProviderBridge>(initProvider)
  const [model, setModel] = useState(initModel)
  const [caps, setCaps] = useState(initCaps)
  const { exit } = useApp()
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>(() => {
    // rebuild display messages from resumed session
    // filter out internal messages (error reasoning, interrupt signals, summaries)
    if (!initialMessages || initialMessages.length === 0) return []
    const display: DisplayMessage[] = []
    const internalPrefixes = [
      'the command failed.',
      'the user interrupted',
      '[session summary]',
      '[earlier conversation was compressed',
    ]
    for (const msg of initialMessages) {
      for (const block of msg.content) {
        if (block.type !== 'text') continue
        const isInternal = internalPrefixes.some(p => block.text.startsWith(p))
        if (isInternal) continue

        if (msg.role === 'user') {
          display.push({ role: 'user', text: block.text })
        } else if (msg.role === 'assistant') {
          display.push({ role: 'assistant', text: block.text })
        }
      }
    }
    return display
  })
  const [isLoading, setIsLoading] = useState(false)
  const [turnCount, setTurnCount] = useState(0)
  const [tokenInfo, setTokenInfo] = useState('')
  const [profile, setProfile] = useState<ModelProfile>(() => loadProfile(model))
  const [pendingPermission, setPendingPermission] = useState<{
    toolName: string
    description: string
    id: string
    resolve: (choice: PermissionChoice) => void
  } | null>(null)

  // scan project once on mount
  const [projectContext] = useState(() => scanProject(process.cwd()))

  // wire agent progress to display
  useState(() => {
    configureAgentTool(provider, model, tools, (event: AgentProgressEvent) => {
      switch (event.type) {
        case 'thinking':
          setDisplayMessages(prev => {
            const last = prev[prev.length - 1]
            if (last?.role === 'tool_result' && last.text.startsWith(`[${event.agent}] `)) {
              return [...prev.slice(0, -1), { ...last, text: `[${event.agent}] ${event.text}` }]
            }
            return [...prev, { role: 'tool_result' as const, text: `[${event.agent}] ${event.text}`, isError: false }]
          })
          break
        case 'tool_call':
          setDisplayMessages(prev => [
            ...prev,
            { role: 'tool_call' as const, text: '', toolName: `${event.agent} → ${event.tool}` },
          ])
          break
        case 'tool_result':
          setDisplayMessages(prev => [
            ...prev,
            { role: 'tool_result' as const, text: `[${event.agent}] ${event.result}`, isError: event.isError },
          ])
          break
      }
    })
  })

  // persistent conversation (loaded from session on resume)
  const [messages] = useState<Message[]>(() => initialMessages ? [...initialMessages] : [])

  const toolSchemas = tools.map(t => toolToSchema(t))

  const getSystemPrompt = useCallback(() => {
    const currentCaps: ModelCapabilities = {
      ...caps,
      ...(profile.maxToolsOverride ? { maxTools: profile.maxToolsOverride } : {}),
      ...(profile.toolAccuracyOverride ? { toolAccuracy: profile.toolAccuracyOverride } : {}),
    }
    return buildSystemPrompt({
      capabilities: currentCaps,
      tools: toolSchemas,
      cwd: process.cwd(),
      profile,
      projectContext,
    })
  }, [caps, toolSchemas, profile])

  // abort controller for interrupting the current operation
  const [abortController, setAbortController] = useState<AbortController | null>(null)

  // handle keyboard: escape interrupts, ctrl+c exits
  useInput((input, key) => {
    if (!isLoading && key.ctrl && input === 'c') {
      exit()
      return
    }
    if (!isLoading) return // don't intercept keystrokes while user is typing

    if (key.escape && abortController) {
      abortController.abort()
      setDisplayMessages(prev => [
        ...prev,
        { role: 'tool_result', text: 'interrupted by user', isError: false },
      ])
    }
  })

  const handleSubmit = useCallback(async (input: string) => {
    // slash commands
    if (input.startsWith('/')) {
      const switchModelFn = async (newModel: string) => {
        const config = loadConfig()
        const isOpenRouter = newModel.includes('/')
        let newProvider: ProviderBridge

        if (isOpenRouter) {
          const or = new OpenRouterProvider()
          await or.connect({ model: newModel, apiKey: config.openrouter.api_key })
          newProvider = or
        } else {
          const ollama = new OllamaProvider()
          await ollama.connect({ model: newModel, baseUrl: config.ollama.base_url })
          newProvider = ollama
        }

        setProvider(newProvider)
        setModel(newModel)
        setCaps(newProvider.getCapabilities())
        session.model = newModel
        session.provider = newProvider.name
        saveSession(session)
        setDisplayMessages(prev => [...prev, { role: 'tool_result', text: `switched to ${newModel}`, isError: false }])
      }

      const handled = handleSlashCommand(input, model, profile, setProfile, setDisplayMessages, exit, switchModelFn)
      if (handled) return
    }

    // add user message to display
    setDisplayMessages(prev => [...prev, { role: 'user', text: input }])
    setTurnCount(prev => prev + 1)
    setIsLoading(true)

    // add to conversation
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: input }],
    })

    // create abort controller for this query
    const controller = new AbortController()
    setAbortController(controller)

    // permission resolver: pauses tool execution, shows prompt, waits for user
    const askPermission = (toolName: string, description: string, id: string) => {
      return new Promise<PermissionChoice>((resolve) => {
        setPendingPermission({ toolName, description, id, resolve })
      })
    }

    // stream assistant response
    let currentText = ''

    try {
      for await (const event of query({
        provider,
        model,
        systemPrompt: getSystemPrompt(),
        tools,
        messages,
        maxTurns: 5,
        askPermission,
        signal: controller.signal,
      })) {
        switch (event.type) {
          case 'text':
            currentText += event.text
            setDisplayMessages(prev => {
              const updated = [...prev]
              const last = updated[updated.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) {
                last.text = currentText
              } else {
                updated.push({ role: 'assistant', text: currentText, isStreaming: true })
              }
              return updated
            })
            break

          case 'tool_start':
            setDisplayMessages(prev => [
              ...prev,
              { role: 'tool_call', text: '', toolName: event.name },
            ])
            break

          case 'tool_end':
            setDisplayMessages(prev => [
              ...prev,
              { role: 'tool_result', text: event.result, isError: event.isError },
            ])
            // reset currentText for post-tool response
            currentText = ''
            break

          case 'token_update':
            setTokenInfo(event.formatted)
            break

          case 'done':
            setTurnCount(event.turnCount)
            // mark streaming as done
            setDisplayMessages(prev => {
              return prev.map(m =>
                m.isStreaming ? { ...m, isStreaming: false } : m
              )
            })
            break

          case 'error':
            setDisplayMessages(prev => [
              ...prev,
              { role: 'tool_result', text: event.error, isError: true },
            ])
            break
        }
      }
    } catch (error) {
      const msg = (error as Error).message || String(error)
      if (!controller.signal.aborted) {
        setDisplayMessages(prev => [
          ...prev,
          { role: 'tool_result', text: `error: ${msg}`, isError: true },
        ])
      }
    }

    // if interrupted, inject into conversation so model knows
    if (controller.signal.aborted) {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: 'the user interrupted the current operation. stop what you were doing and ask what they want instead.' }],
      })
    }

    // auto-save session after every turn
    session.messages = messages
    saveSession(session)

    setAbortController(null)
    setIsLoading(false)
  }, [provider, model, tools, messages, getSystemPrompt])

  return (
    <Box flexDirection="column" padding={1}>
      <Banner
        model={model}
        provider={provider.name}
        maxTools={caps.maxTools}
        accuracy={caps.toolAccuracy}
        rulesCount={profile.rules.length}
        isResumed={initialMessages !== undefined && initialMessages.length > 0}
      />

      <Box flexDirection="column" flexGrow={1}>
        <MessageList messages={displayMessages} />
        {pendingPermission && (
          <PermissionPrompt
            toolName={pendingPermission.toolName}
            description={pendingPermission.description}
            onDecision={(choice) => {
              pendingPermission.resolve(choice)
              setPendingPermission(null)
            }}
          />
        )}
      </Box>

      <StatusBar
        turnCount={turnCount}
        tokenInfo={tokenInfo}
      />

      <PromptInput onSubmit={handleSubmit} isLoading={isLoading} />
    </Box>
  )
}

function handleSlashCommand(
  input: string,
  model: string,
  profile: ModelProfile,
  setProfile: (p: ModelProfile) => void,
  setMessages: React.Dispatch<React.SetStateAction<DisplayMessage[]>>,
  exit: () => void,
  switchModel?: (newModel: string) => Promise<void>,
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

    case '/forget':
      const idx = parseInt(args) - 1
      if (isNaN(idx)) {
        info('usage: /forget <number>')
      } else {
        const updated = removeRule(model, idx)
        setProfile(updated)
        info('rule removed.')
      }
      return true

    case '/rules':
      if (profile.rules.length === 0) {
        info(`no learned rules for ${model}. use /teach to add one.`)
      } else {
        const lines = profile.rules.map((r, i) => `${i + 1}. ${r.rule}`).join('\n')
        info(`learned rules for ${model}:\n${lines}`)
      }
      return true

    case '/max-tools':
      const n = parseInt(args)
      if (isNaN(n) || n < 1) {
        info('usage: /max-tools <number>')
      } else {
        const updated = setMaxTools(model, n)
        setProfile(updated)
        info(`max tools set to ${n} for ${model}`)
      }
      return true

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

    case '/clear':
      setMessages([])
      return true

    default:
      return false
  }
}
