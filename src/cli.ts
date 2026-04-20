/**
 * prism — one interface in. every provider out.
 * entry point. connects provider, launches Ink UI.
 */

import React from 'react'
import { render } from 'ink'
import { App } from './ui/App.js'
import { OllamaProvider } from './providers/ollama.js'
import { BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool } from './tools/index.js'

async function main() {
  const model = process.argv[2] || 'gemma4:e4b'
  const provider = new OllamaProvider()

  // connect
  try {
    await provider.connect({ model })
  } catch (e) {
    console.error(`\x1b[31m${(e as Error).message}\x1b[0m`)
    process.exit(1)
  }

  const capabilities = provider.getCapabilities()
  const tools = [BashTool, ReadTool, EditTool, WriteTool, GlobTool, GrepTool]

  // launch UI
  const { waitUntilExit } = render(
    React.createElement(App, { provider, model, tools, capabilities })
  )

  await waitUntilExit()
}

main().catch(console.error)
