/**
 * prism entry point.
 *
 * usage:
 *   prism                                    new session, default model
 *   prism qwen3:14b                          new session, specified model
 *   prism --continue                         resume last session in this directory
 *   prism -c                                 same
 *   prism --openrouter                       openrouter provider
 *   prism --or deepseek/deepseek-r1          openrouter with model
 *   prism --config                           show config path
 *   prism --sessions                         list recent sessions
 */

import React from 'react'
import { render } from 'ink'
import { App } from './ui/App.js'
import { OllamaProvider } from './providers/ollama.js'
import { OpenRouterProvider } from './providers/openrouter.js'
import { BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool } from './tools/index.js'
import { loadConfig, initConfig, getConfigPath } from './config/config.js'
import { createSession, findLastSession, listSessions } from './sessions/store.js'
import type { ProviderBridge, Message } from './types/index.js'
import type { Session } from './sessions/types.js'

async function main() {
  initConfig()

  const config = loadConfig()
  const args = process.argv.slice(2)

  // --config: show config path
  if (args.includes('--config')) {
    console.log(getConfigPath())
    process.exit(0)
  }

  // --sessions: list recent sessions
  if (args.includes('--sessions')) {
    const sessions = listSessions(10)
    if (sessions.length === 0) {
      console.log('no sessions yet.')
    } else {
      for (const s of sessions) {
        const turns = s.messages.filter(m => m.role === 'user').length
        const date = s.updatedAt.slice(0, 16).replace('T', ' ')
        console.log(`${s.id}  ${s.model}  ${turns} turns  ${date}  ${s.cwd}`)
      }
    }
    process.exit(0)
  }

  let useOpenRouter = args.includes('--openrouter') || args.includes('--or')
  const shouldContinue = args.includes('--continue') || args.includes('-c')
  const modelArgs = args.filter(a => !a.startsWith('--') && a !== '-c')

  let provider: ProviderBridge
  let model: string
  let session: Session
  let initialMessages: Message[] = []
  const cwd = process.cwd()

  // load session first so we can inherit provider/model from it
  if (shouldContinue) {
    const last = findLastSession(cwd)
    if (last) {
      session = last
      initialMessages = last.messages
      // inherit provider from session unless overridden by flags
      if (!args.includes('--openrouter') && !args.includes('--or') && last.provider === 'openrouter') {
        useOpenRouter = true
      }
      // inherit model from session unless overridden by args
      if (modelArgs.length === 0) {
        modelArgs.push(last.model)
      }
      console.log(`\x1b[2mresuming session (${last.messages.filter(m => m.role === 'user').length} turns)\x1b[0m`)
    } else {
      console.log(`\x1b[2mno previous session in this directory. starting new.\x1b[0m`)
    }
  }

  // connect provider
  if (useOpenRouter) {
    model = modelArgs[0] || config.default_model
    const or = new OpenRouterProvider()

    try {
      await or.connect({ model, apiKey: config.openrouter.api_key })
    } catch (e) {
      console.error(`\x1b[31m${(e as Error).message}\x1b[0m`)
      process.exit(1)
    }

    provider = or
  } else {
    model = modelArgs[0] || config.default_model
    const ollama = new OllamaProvider()

    try {
      await ollama.connect({ model, baseUrl: config.ollama.base_url })
    } catch (e) {
      console.error(`\x1b[31m${(e as Error).message}\x1b[0m`)
      process.exit(1)
    }

    provider = ollama
  }

  // create new session if not resuming
  if (!session!) {
    session = createSession(model, provider.name, cwd)
  }

  const capabilities = provider.getCapabilities()
  const tools = [BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool]

  const { waitUntilExit } = render(
    React.createElement(App, {
      provider,
      model,
      tools,
      capabilities,
      session,
      initialMessages,
    })
  )

  await waitUntilExit()
}

main().catch(console.error)
