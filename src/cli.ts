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

  // known flags
  const KNOWN_FLAGS = new Set([
    '--openrouter', '--or',
    '--continue', '-c',
    '--config',
    '--sessions',
    '--help', '-h',
  ])

  // help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`\x1b[38;2;0;255;136mprism\x1b[0m: free, local-first AI assistant

\x1b[38;2;0;255;136musage:\x1b[0m
  prism [model] [flags]

\x1b[38;2;0;255;136mmodels:\x1b[0m
  prism                               default model (from config)
  prism qwen3:14b                     specify local model
  prism --or deepseek/deepseek-r1     openrouter model

\x1b[38;2;0;255;136mflags:\x1b[0m
  --or, --openrouter    use OpenRouter provider
  -c, --continue        resume last session in this directory
  --config              show config file path
  --sessions            list recent sessions
  -h, --help            show this help`)
    process.exit(0)
  }

  // validate flags: catch typos
  const unknownFlags = args.filter(a => a.startsWith('-') && !KNOWN_FLAGS.has(a))
  if (unknownFlags.length > 0) {
    console.error(`\x1b[31munknown flag: ${unknownFlags[0]}\x1b[0m`)
    console.error(`run \x1b[38;2;0;255;136mprism --help\x1b[0m or \x1b[38;2;0;255;136m-h\x1b[0m for usage.`)
    process.exit(1)
  }

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
  const modelArgs = args.filter(a => !a.startsWith('-'))

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
