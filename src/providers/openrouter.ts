/**
 * OpenRouter provider adapter.
 * one API key, 200+ models. OpenAI-compatible format.
 * free tier available. supports tool calling.
 *
 * API: POST https://openrouter.ai/api/v1/chat/completions
 * docs: openrouter.ai/docs
 */

import type {
  ProviderBridge,
  ProviderConfig,
  ModelCapabilities,
  MessageParams,
  MessageResponse,
  ToolSchema,
  ContentBlock,
  Message,
  StreamEvent,
  ToolUseBlock,
} from '../types/index.js'

const BASE_URL = 'https://openrouter.ai/api/v1'

// capability profiles for known models on openrouter
const MODEL_PROFILES: Record<string, Partial<ModelCapabilities>> = {
  // free tier
  'qwen/qwen3-coder-480b': { maxTools: 15, toolAccuracy: 0.85, maxContextTokens: 262_000 },
  'deepseek/deepseek-r1': { maxTools: 10, toolAccuracy: 0.75, maxContextTokens: 128_000 },
  'mistralai/mistral-small-3.1': { maxTools: 10, toolAccuracy: 0.75, maxContextTokens: 32_000 },
  'meta-llama/llama-3.3-70b': { maxTools: 10, toolAccuracy: 0.75, maxContextTokens: 128_000 },
  // cheap
  'google/gemini-2.0-flash': { maxTools: 12, toolAccuracy: 0.8, maxContextTokens: 1_000_000 },
  'google/gemini-2.5-flash': { maxTools: 12, toolAccuracy: 0.82, maxContextTokens: 1_000_000 },
  'deepseek/deepseek-v3.2': { maxTools: 12, toolAccuracy: 0.8, maxContextTokens: 128_000 },
  'openai/gpt-4.1-nano': { maxTools: 10, toolAccuracy: 0.78, maxContextTokens: 128_000 },
  'openai/gpt-4.1-mini': { maxTools: 12, toolAccuracy: 0.82, maxContextTokens: 128_000 },
  // mid range
  'qwen/qwen3.6-plus': { maxTools: 15, toolAccuracy: 0.85, maxContextTokens: 1_000_000 },
  'anthropic/claude-haiku-4.5': { maxTools: 15, toolAccuracy: 0.9, maxContextTokens: 200_000 },
  'openai/gpt-4o': { maxTools: 15, toolAccuracy: 0.88, maxContextTokens: 128_000 },
  'anthropic/claude-sonnet-4': { maxTools: 20, toolAccuracy: 0.95, maxContextTokens: 200_000 },
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  maxTools: 10,
  parallelToolCalls: true,
  streaming: true,
  thinking: false,
  vision: false,
  strictMode: false,
  maxContextTokens: 128_000,
  toolAccuracy: 0.75,
}

interface OpenAIToolCall {
  id: string
  index?: number
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAIStreamChunk {
  id: string
  choices: {
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: string | null
  }[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
  }
}

export class OpenRouterProvider implements ProviderBridge {
  name = 'openrouter'
  private apiKey = ''
  private model = 'qwen/qwen3-coder-480b'
  private capabilities: ModelCapabilities = { ...DEFAULT_CAPABILITIES }

  async connect(config: ProviderConfig): Promise<void> {
    this.apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || ''
    if (config.model) this.model = config.model

    // look up model-specific capabilities
    const profile = MODEL_PROFILES[this.model]
    if (profile) {
      this.capabilities = { ...DEFAULT_CAPABILITIES, ...profile }
    }

    // verify connection
    if (!this.apiKey) {
      throw new Error(
        'openrouter requires an API key. set OPENROUTER_API_KEY or pass apiKey in config.\n' +
        'get one free at openrouter.ai/keys'
      )
    }

    try {
      const res = await fetch(`${BASE_URL}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
      })
      if (!res.ok) throw new Error(`openrouter returned ${res.status}`)
    } catch (e) {
      if ((e as Error).message.includes('openrouter returned')) throw e
      throw new Error('cannot connect to openrouter. check your internet connection.')
    }
  }

  getCapabilities(): ModelCapabilities {
    return this.capabilities
  }

  async *streamMessage(params: MessageParams): AsyncGenerator<StreamEvent> {
    const body = this.buildRequestBody(params, true)

    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/itsautomata/prism',
        'X-Title': 'Prism',
      },
      body: JSON.stringify(body),
      signal: params.signal,
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText)
      yield { type: 'error', error: `openrouter error: ${res.status} ${errorText}` }
      return
    }

    const reader = res.body?.getReader()
    if (!reader) {
      yield { type: 'error', error: 'no response body from openrouter' }
      return
    }

    const decoder = new TextDecoder()
    const messageId = crypto.randomUUID()
    let inputTokens = 0
    let outputTokens = 0
    const toolCalls: Map<number, { id: string; name: string; args: string }> = new Map()

    yield { type: 'message_start', id: messageId }

    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue

        let chunk: OpenAIStreamChunk
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }

        const choice = chunk.choices?.[0]
        if (!choice) continue

        // text content
        if (choice.delta.content) {
          yield { type: 'text_delta', text: choice.delta.content }
        }

        // tool calls (streamed incrementally)
        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0

            if (!toolCalls.has(idx)) {
              // new tool call
              const id = tc.id || crypto.randomUUID()
              const name = tc.function?.name || ''
              toolCalls.set(idx, { id, name, args: '' })
              if (name) {
                yield { type: 'tool_call_start', id, name }
              }
            }

            // accumulate arguments
            const existing = toolCalls.get(idx)!
            if (tc.function?.name && !existing.name) {
              existing.name = tc.function.name
              yield { type: 'tool_call_start', id: existing.id, name: existing.name }
            }
            if (tc.function?.arguments) {
              existing.args += tc.function.arguments
            }
          }
        }

        // finish
        if (choice.finish_reason) {
          // emit completed tool calls
          for (const [, tc] of toolCalls) {
            if (tc.args) {
              yield { type: 'tool_call_delta', id: tc.id, inputJson: tc.args }
            }
            yield { type: 'tool_call_end', id: tc.id }
          }
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens
          outputTokens = chunk.usage.completion_tokens
        }
      }
    }

    const stopReason = toolCalls.size > 0 ? 'tool_use' : 'end_turn'

    yield {
      type: 'message_end',
      usage: { inputTokens, outputTokens },
      stopReason,
    }
  }

  async createMessage(params: MessageParams): Promise<MessageResponse> {
    const body = this.buildRequestBody(params, false)

    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/itsautomata/prism',
        'X-Title': 'Prism',
      },
      body: JSON.stringify(body),
      signal: params.signal,
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => res.statusText)
      throw new Error(`openrouter error: ${res.status} ${errorText}`)
    }

    const data = await res.json() as {
      id: string
      choices: { message: { content?: string; tool_calls?: OpenAIToolCall[] }; finish_reason: string }[]
      usage?: { prompt_tokens: number; completion_tokens: number }
    }

    const choice = data.choices?.[0]
    if (!choice) throw new Error('no response from openrouter')

    const content: ContentBlock[] = []

    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content })
    }

    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: Record<string, unknown> = {}
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {}
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        })
      }
    }

    const hasTools = content.some(b => b.type === 'tool_use')

    return {
      id: data.id || crypto.randomUUID(),
      content,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      stopReason: hasTools ? 'tool_use' : 'end_turn',
    }
  }

  formatToolSchema(tool: ToolSchema): unknown {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }
  }

  parseToolCalls(content: ContentBlock[]): ContentBlock[] {
    return content
  }

  private buildRequestBody(params: MessageParams, stream: boolean) {
    const messages = this.formatMessages(params.messages)

    if (params.system) {
      messages.unshift({ role: 'system', content: params.system })
    }

    const body: Record<string, unknown> = {
      model: params.model || this.model,
      messages,
      stream,
    }

    if (params.tools && params.tools.length > 0) {
      const maxTools = this.capabilities.maxTools
      const tools = params.tools.slice(0, maxTools)
      body.tools = tools.map(t => this.formatToolSchema(t))
    }

    if (params.maxTokens) {
      body.max_tokens = params.maxTokens
    }

    if (params.temperature !== undefined) {
      body.temperature = params.temperature
    }

    return body
  }

  private formatMessages(msgs: Message[]): { role: string; content: string; tool_calls?: OpenAIToolCall[]; tool_call_id?: string }[] {
    const result: { role: string; content: string; tool_calls?: OpenAIToolCall[]; tool_call_id?: string }[] = []

    for (const msg of msgs) {
      if (msg.role === 'assistant') {
        const textParts: string[] = []
        const toolCalls: OpenAIToolCall[] = []

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            })
          }
        }

        result.push({
          role: 'assistant',
          content: textParts.join('\n'),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        })
      } else {
        const textParts: string[] = []

        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            result.push({
              role: 'tool',
              content: typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content),
              tool_call_id: block.toolUseId,
            })
          } else if (block.type === 'text') {
            textParts.push(block.text)
          }
        }

        if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('\n') })
        }
      }
    }

    return result
  }
}
