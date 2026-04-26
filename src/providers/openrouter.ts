/**
 * OpenRouter provider adapter.
 * one API key, 300+ models. OpenAI-compatible format.
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
import { getOpenRouterCatalog, type OpenRouterModelMeta } from '../completion/spec.js'

const BASE_URL = 'https://openrouter.ai/api/v1'

// maxTools per model family. placeholder until we have more tools and a real design
// the API doesn't expose this, so we approximate by family. /teach can
// override via maxToolsOverride for any specific model.
function maxToolsForFamily(modelId: string): number {
  if (modelId.startsWith('anthropic/claude-sonnet') || modelId.startsWith('anthropic/claude-opus')) return 20
  if (modelId.startsWith('anthropic/')) return 15
  if (modelId.startsWith('openai/gpt-4') || modelId.startsWith('openai/gpt-5')) return 15
  if (modelId.startsWith('openai/')) return 10
  if (modelId.startsWith('google/gemini-2.5') || modelId.startsWith('google/gemini-3')) return 12
  if (modelId.startsWith('google/')) return 10
  if (modelId.startsWith('qwen/')) return 12
  if (modelId.startsWith('deepseek/')) return 10
  if (modelId.startsWith('meta-llama/')) return 10
  if (modelId.startsWith('mistralai/')) return 10
  return 8
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  maxTools: 10,
  parallelToolCalls: true,
  streaming: true,
  thinking: false,
  vision: false,
  strictMode: false,
  maxContextTokens: 128_000,
}

/**
 * which model families HONOR an explicit cache_control marker we send.
 * - anthropic/*: REQUIRED, caching only happens if we mark
 * - google/gemini-*: honored on Pro/Flash 2.5+, caches the marked prefix
 *
 * NOT in this list (caching still happens, just not via our marker):
 * - openai/* and deepseek/*: cache automatically server-side, markers are ignored
 * - others: no caching at all, markers are stripped by openrouter
 *
 * we only mark when it actually changes behavior. no point sending bytes for nothing.
 */
function supportsExplicitCacheControl(modelId: string): boolean {
  return (
    modelId.startsWith('anthropic/') ||
    modelId.startsWith('google/gemini-')
  )
}

function inferCapabilities(modelId: string, meta: OpenRouterModelMeta | null): ModelCapabilities {
  const caps: ModelCapabilities = { ...DEFAULT_CAPABILITIES, maxTools: maxToolsForFamily(modelId) }
  if (!meta) return caps

  if (typeof meta.context_length === 'number' && meta.context_length > 0) {
    caps.maxContextTokens = meta.context_length
  }
  const inputs = meta.architecture?.input_modalities ?? []
  caps.vision = inputs.includes('image')

  const params = meta.supported_parameters ?? []
  caps.thinking = params.includes('reasoning') || params.includes('include_reasoning')
  caps.parallelToolCalls = params.includes('tools') && params.includes('tool_choice')

  return caps
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

    // verify connection
    if (!this.apiKey) {
      throw new Error(
        'openrouter requires an API key. set OPENROUTER_API_KEY or pass apiKey in config.\n' +
        'get one free at openrouter.ai/keys'
      )
    }

    // populate the catalog cache (refreshes if stale; harmless if already fresh)
    // and use it to derive this model's capabilities from live API data.
    const catalog = await getOpenRouterCatalog()
    const meta = catalog.find(m => m.id === this.model) || null
    this.capabilities = inferCapabilities(this.model, meta)

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
    const modelId = params.model || this.model
    const useCache = supportsExplicitCacheControl(modelId)

    const messages: unknown[] = this.formatMessages(params.messages)

    if (params.system) {
      // when caching is on, system content must be an array of blocks so we can
      // attach cache_control. otherwise stick with the simple string form.
      const systemContent = useCache
        ? [{ type: 'text', text: params.system, cache_control: { type: 'ephemeral' } }]
        : params.system
      messages.unshift({ role: 'system', content: systemContent })
    }

    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      stream,
    }

    if (params.tools && params.tools.length > 0) {
      const maxTools = this.capabilities.maxTools
      const tools = params.tools.slice(0, maxTools)
      const formatted: any[] = tools.map(t => this.formatToolSchema(t))
      // mark the last tool with cache_control to cache the entire tools block
      // (anthropic's prompt cache treats the tools section as one cacheable unit
      // when any tool carries cache_control).
      if (useCache && formatted.length > 0) {
        formatted[formatted.length - 1].cache_control = { type: 'ephemeral' }
      }
      body.tools = formatted
    }

    if (params.maxTokens) {
      body.max_tokens = params.maxTokens
    }

    if (params.temperature !== undefined) {
      body.temperature = params.temperature
    }

    // request usage breakdown so we get cache hit/miss telemetry back
    if (useCache && stream) {
      body.usage = { include: true }
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
