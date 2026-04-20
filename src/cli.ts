/**
 * prism entry point.
 *
 * usage:
 *   prism                          default model (gemma4:e4b)
 *   prism gemma4:e4b               gemma4
 *   prism qwen2.5-coder:7b         qwen
 */

import React from 'react'
import { render } from 'ink'
import { App } from './ui/App.js'
import { OllamaProvider } from './providers/ollama.js'
import { BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool } from './tools/index.js'

async function main() {
  const model = process.argv[2] || 'gemma4:e4b'
  const provider = new OllamaProvider()

  try {
    await provider.connect({ model })
  } catch (e) {
    console.error(`\x1b[31m${(e as Error).message}\x1b[0m`)
    process.exit(1)
  }

  const capabilities = provider.getCapabilities()
  const tools = [BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool]

  const { waitUntilExit } = render(
    React.createElement(App, { provider, model, tools, capabilities })
  )

  await waitUntilExit()
}

main().catch(console.error)
