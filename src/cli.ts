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
import { BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool, AgentTool, configureAgentTool } from './tools/index.js'
import { loadConfig, initConfig, getConfigPath } from './config/config.js'
import { createSession, findLastSession, listSessions } from './sessions/store.js'
import { allFlagTokens, complete } from './completion/spec.js'
import { emitBash } from './completion/bash.js'
import { emitZsh } from './completion/zsh.js'
import { installCompletion, maybeAutoInstall, type SupportedShell } from './completion/install.js'
import type { ProviderBridge, Message } from './types/index.js'
import type { Session } from './sessions/types.js'

async function main() {
  const args = process.argv.slice(2)

  // --completion <shell>: print shell completion script and exit
  const completionIdx = args.indexOf('--completion')
  if (completionIdx !== -1) {
    const shell = args[completionIdx + 1]
    if (shell === 'bash') {
      process.stdout.write(emitBash())
      process.exit(0)
    } else if (shell === 'zsh') {
      process.stdout.write(emitZsh())
      process.exit(0)
    } else {
      console.error(`\x1b[31m--completion requires bash or zsh, got: ${shell || '(none)'}\x1b[0m`)
      process.exit(1)
    }
  }

  // --install-completion [shell]: append the eval line to the user's shell rc
  const installIdx = args.indexOf('--install-completion')
  if (installIdx !== -1) {
    const next = args[installIdx + 1]
    const requested = (next === 'bash' || next === 'zsh') ? next as SupportedShell : undefined
    try {
      const result = installCompletion(requested)
      const verb = result.status === 'already-installed' ? 'already installed in' : 'installed to'
      console.log(`\x1b[38;2;0;255;136mprism completion ${verb}\x1b[0m ${result.rcPath}`)
      console.log(`\x1b[2mrestart your shell to enable tab completion (or run \`exec ${result.shell}\` to reload in place).\x1b[0m`)
      process.exit(0)
    } catch (e) {
      console.error(`\x1b[31m${(e as Error).message}\x1b[0m`)
      process.exit(1)
    }
  }

  // --complete <context>: print suggestions for tab completion (internal)
  const completeIdx = args.indexOf('--complete')
  if (completeIdx !== -1) {
    const context = args[completeIdx + 1]
    if (!context) {
      process.exit(0)
    }
    const suggestions = await complete(context)
    if (suggestions.length > 0) {
      process.stdout.write(suggestions.join('\n') + '\n')
    }
    process.exit(0)
  }

  initConfig()

  const config = loadConfig()

  // known flags (derived from completion spec, single source of truth)
  const KNOWN_FLAGS = new Set([...allFlagTokens(), '--completion', '--complete', '--install-completion'])

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
  --max-tokens <n>      max output tokens per response (default: 10000)
  --config              show config file path
  --sessions            list recent sessions
  -h, --help            show this help`)
    process.exit(0)
  }

  // parse --max-tokens value
  const maxTokensIdx = args.indexOf('--max-tokens')
  let maxTokens: number | undefined
  if (maxTokensIdx !== -1) {
    const raw = args[maxTokensIdx + 1]
    if (!raw || raw.startsWith('-')) {
      console.error(`\x1b[31m--max-tokens requires a number (e.g. --max-tokens 10000)\x1b[0m`)
      process.exit(1)
    }
    const parsed = parseInt(raw, 10)
    if (isNaN(parsed) || parsed <= 0) {
      console.error(`\x1b[31m--max-tokens must be a positive number, got: ${raw}\x1b[0m`)
      process.exit(1)
    }
    maxTokens = parsed
  }

  // validate flags: catch typos (skip the value after --max-tokens)
  const unknownFlags = args.filter((a, i) => a.startsWith('-') && !KNOWN_FLAGS.has(a) && !(i > 0 && args[i - 1] === '--max-tokens'))
  if (unknownFlags.length > 0) {
    console.error(`\x1b[31munknown flag: ${unknownFlags[0]}\x1b[0m`)
    console.error(`run \x1b[38;2;0;255;136mprism --help\x1b[0m or \x1b[38;2;0;255;136m-h\x1b[0m for usage.`)
    process.exit(1)
  }

  // validate positional args: at most one model name
  const modelArgs = args.filter((a, i) => !a.startsWith('-') && !(i > 0 && args[i - 1] === '--max-tokens'))
  if (modelArgs.length > 1) {
    console.error(`\x1b[31mtoo many arguments: ${modelArgs.join(', ')}\x1b[0m`)
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
      await ollama.connect({ model, baseUrl: config.ollama.base_url, ...(maxTokens ? { maxTokens } : {}) })
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
  const tools = [BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool, AgentTool]

  // configure Agent tool with current provider (agents share it)
  configureAgentTool(provider, model, tools)

  // first-run only: silently install shell completion if the user's shell
  // is supported and we haven't done it before. no-op on subsequent runs.
  const autoInstall = maybeAutoInstall()
  if (autoInstall) {
    console.log(`\x1b[2mshell completion installed to ${autoInstall.rcPath}. restart your shell or run \`exec ${autoInstall.shell}\` to enable tab completion.\x1b[0m`)
  }

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
