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
import { classifyTask } from '../routing/classifier.js'
import { scanProject } from '../context/scanner.js'
import type { ProjectContext } from '../context/types.js'
import type { ProviderBridge, Message, ModelCapabilities } from '../types/index.js'
import type { Tool } from '../tools/Tool.js'

interface AppProps {
  provider: ProviderBridge
  model: string
  tools: Tool[]
  capabilities: ModelCapabilities
}

export function App({ provider, model, tools, capabilities: initCaps }: AppProps) {
  const { exit } = useApp()
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [turnCount, setTurnCount] = useState(0)
  const [inputTokens, setInputTokens] = useState(0)
  const [outputTokens, setOutputTokens] = useState(0)
  const [profile, setProfile] = useState<ModelProfile>(() => loadProfile(model))
  const [pendingPermission, setPendingPermission] = useState<{
    toolName: string
    description: string
    id: string
    resolve: (choice: PermissionChoice) => void
  } | null>(null)

  // scan project once on mount
  const [projectContext] = useState(() => scanProject(process.cwd()))

  // persistent conversation
  const [messages] = useState<Message[]>([])

  const toolSchemas = tools.map(t => toolToSchema(t))

  const getCapabilities = useCallback((): ModelCapabilities => ({
    ...initCaps,
    ...(profile.maxToolsOverride ? { maxTools: profile.maxToolsOverride } : {}),
    ...(profile.toolAccuracyOverride ? { toolAccuracy: profile.toolAccuracyOverride } : {}),
  }), [initCaps, profile])

  const getSystemPrompt = useCallback((userInput?: string) => {
    const taskType = userInput ? classifyTask(userInput).type : undefined
    return buildSystemPrompt({
      capabilities: getCapabilities(),
      tools: toolSchemas,
      cwd: process.cwd(),
      profile,
      projectContext,
      taskType,
    })
  }, [getCapabilities, toolSchemas, profile])

  // abort controller for interrupting the current operation
  const [abortController, setAbortController] = useState<AbortController | null>(null)

  // handle keyboard: escape interrupts, ctrl+c exits
  useInput((input, key) => {
    if (key.escape && abortController && isLoading) {
      abortController.abort()
      setDisplayMessages(prev => [
        ...prev,
        { role: 'tool_result', text: 'interrupted by user', isError: false },
      ])
    }
    if (key.ctrl && input === 'c') {
      if (abortController) abortController.abort()
      exit()
    }
  })

  const handleSubmit = useCallback(async (input: string) => {
    // slash commands
    if (input.startsWith('/')) {
      const handled = handleSlashCommand(input, model, profile, setProfile, setDisplayMessages, exit)
      if (handled) return
    }

    // add user message to display
    setDisplayMessages(prev => [...prev, { role: 'user', text: input }])
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
        systemPrompt: getSystemPrompt(input),
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

    setAbortController(null)
    setIsLoading(false)
  }, [provider, model, tools, messages, getSystemPrompt])

  const caps = getCapabilities()

  return (
    <Box flexDirection="column" padding={1}>
      <Banner
        model={model}
        provider={provider.name}
        maxTools={caps.maxTools}
        accuracy={caps.toolAccuracy}
        rulesCount={profile.rules.length}
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
        inputTokens={inputTokens}
        outputTokens={outputTokens}
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

    case '/help':
      info([
        'commands:',
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
