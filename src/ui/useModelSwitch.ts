/**
 * model switching hook.
 * creates a new provider connection and updates state.
 */

import type React from 'react'
import { OllamaProvider } from '../providers/ollama.js'
import { OpenRouterProvider } from '../providers/openrouter.js'
import { loadConfig } from '../config/config.js'
import { saveSession } from '../sessions/store.js'
import type { ProviderBridge, ModelCapabilities } from '../types/index.js'
import type { Session } from '../sessions/types.js'
import type { DisplayMessage } from './MessageList.js'

export async function switchModel(
  newModel: string,
  session: Session,
  setProvider: (p: ProviderBridge) => void,
  setModel: (m: string) => void,
  setCaps: (c: ModelCapabilities) => void,
  setDisplayMessages: React.Dispatch<React.SetStateAction<DisplayMessage[]>>,
): Promise<void> {
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
