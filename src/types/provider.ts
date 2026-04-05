/**
 * provider bridge interface.
 * one interface. every provider implements it.
 * the query engine never knows which model it's talking to.
 */

import type { Message, ContentBlock, Usage } from './messages.js'
import type { StreamEvent } from './stream.js'

export interface ModelCapabilities {
  maxTools: number
  parallelToolCalls: boolean
  streaming: boolean
  thinking: boolean
  vision: boolean
  strictMode: boolean
  maxContextTokens: number
  toolAccuracy: number // 0-1
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown> // JSON Schema
}

export interface MessageParams {
  model: string
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface MessageResponse {
  id: string
  content: ContentBlock[]
  usage: Usage
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
}

export interface ProviderConfig {
  apiKey?: string
  baseUrl?: string
  model: string
  [key: string]: unknown
}

export interface ProviderBridge {
  name: string

  // connect to the provider
  connect(config: ProviderConfig): Promise<void>

  // what this model can do
  getCapabilities(): ModelCapabilities

  // streaming (primary path)
  streamMessage(params: MessageParams): AsyncGenerator<StreamEvent>

  // non-streaming (fallback)
  createMessage(params: MessageParams): Promise<MessageResponse>

  // format translation
  formatToolSchema(tool: ToolSchema): unknown
  parseToolCalls(content: ContentBlock[]): ContentBlock[]
}
