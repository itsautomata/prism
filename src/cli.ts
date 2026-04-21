/**
 * prism entry point.
 *
 * usage:
 *   prism                                    ollama + default model
 *   prism qwen2.5-coder:7b                   ollama + specified model
 *   prism --openrouter                        openrouter + default model
 *   prism --or deepseek/deepseek-r1           openrouter + specified model
 *   prism --config                            open config file path
 */

import React from 'react'
import { render } from 'ink'
import { App } from './ui/App.js'
import { OllamaProvider } from './providers/ollama.js'
import { OpenRouterProvider } from './providers/openrouter.js'
import { BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool } from './tools/index.js'
import { loadConfig, initConfig, getConfigPath } from './config/config.js'
import type { ProviderBridge } from './types/index.js'

async function main() {
  // ensure config file exists
  initConfig()

  const config = loadConfig()
  const args = process.argv.slice(2)

  // --config: show config path
  if (args.includes('--config')) {
    console.log(getConfigPath())
    process.exit(0)
  }

  const useOpenRouter = args.includes('--openrouter') || args.includes('--or')
  const modelArgs = args.filter(a => !a.startsWith('--'))

  let provider: ProviderBridge
  let model: string

  if (useOpenRouter) {
    model = modelArgs[0] || config.default_model
    const or = new OpenRouterProvider()

    try {
      await or.connect({
        model,
        apiKey: config.openrouter.api_key,
      })
    } catch (e) {
      console.error(`\x1b[31m${(e as Error).message}\x1b[0m`)
      process.exit(1)
    }

    provider = or
  } else {
    model = modelArgs[0] || config.default_model
    const ollama = new OllamaProvider()

    try {
      await ollama.connect({
        model,
        baseUrl: config.ollama.base_url,
      })
    } catch (e) {
      console.error(`\x1b[31m${(e as Error).message}\x1b[0m`)
      process.exit(1)
    }

    provider = ollama
  }

  const capabilities = provider.getCapabilities()
  const tools = [BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool]

  const { waitUntilExit } = render(
    React.createElement(App, { provider, model, tools, capabilities })
  )

  await waitUntilExit()
}

main().catch(console.error)
