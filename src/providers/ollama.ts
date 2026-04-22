/**
 * Ollama provider adapter.
 * free. local. the first provider because it costs nothing.
 *
 * Ollama uses OpenAI-compatible API format:
 * POST /api/chat with streaming
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
  Usage,
  ToolUseBlock,
} from '../types/index.js'

// ollama model capability profiles
const MODEL_PROFILES: Record<string, Partial<ModelCapabilities>> = {
  // llama
  'llama3.2': { maxTools: 5, toolAccuracy: 0.65, maxContextTokens: 128_000 },
  'llama3.1': { maxTools: 8, toolAccuracy: 0.7, maxContextTokens: 128_000 },
  'llama3.3': { maxTools: 10, toolAccuracy: 0.75, maxContextTokens: 128_000 },
  'llama4': { maxTools: 12, toolAccuracy: 0.8, maxContextTokens: 128_000 },
  // qwen
  'qwen2.5-coder': { maxTools: 10, toolAccuracy: 0.75, maxContextTokens: 32_000 },
  'qwen3': { maxTools: 12, toolAccuracy: 0.8, maxContextTokens: 128_000 },
  'qwen3:14b': { maxTools: 12, toolAccuracy: 0.82, maxContextTokens: 128_000 },
  'qwen3:8b': { maxTools: 10, toolAccuracy: 0.78, maxContextTokens: 128_000 },
  'qwen3-coder': { maxTools: 15, toolAccuracy: 0.85, maxContextTokens: 128_000 },
  // gemma
  'gemma4': { maxTools: 12, toolAccuracy: 0.85, maxContextTokens: 256_000 },
  'gemma4:e4b': { maxTools: 10, toolAccuracy: 0.8, maxContextTokens: 256_000 },
  'gemma4:e2b': { maxTools: 5, toolAccuracy: 0.7, maxContextTokens: 256_000 },
  'gemma4:27b': { maxTools: 12, toolAccuracy: 0.86, maxContextTokens: 256_000 },
  'gemma4:31b': { maxTools: 12, toolAccuracy: 0.86, maxContextTokens: 256_000 },
  // deepseek
  'deepseek-r1': { maxTools: 10, toolAccuracy: 0.75, maxContextTokens: 128_000 },
  'deepseek-r1:14b': { maxTools: 10, toolAccuracy: 0.75, maxContextTokens: 128_000 },
  'deepseek-coder-v2': { maxTools: 8, toolAccuracy: 0.7, maxContextTokens: 128_000 },
  'deepseek-v3': { maxTools: 12, toolAccuracy: 0.8, maxContextTokens: 128_000 },
  // mistral / devstral
  'mistral': { maxTools: 8, toolAccuracy: 0.7, maxContextTokens: 32_000 },
  'mistral-small': { maxTools: 10, toolAccuracy: 0.75, maxContextTokens: 32_000 },
  'devstral': { maxTools: 12, toolAccuracy: 0.8, maxContextTokens: 128_000 },
  'devstral:24b': { maxTools: 12, toolAccuracy: 0.8, maxContextTokens: 128_000 },
  // other
  'command-r': { maxTools: 10, toolAccuracy: 0.75, maxContextTokens: 128_000 },
  'glm4': { maxTools: 12, toolAccuracy: 0.82, maxContextTokens: 128_000 },
}

const DEFAULT_CAPABILITIES: ModelCapabilities = {
  maxTools: 5,
  parallelToolCalls: false,
  streaming: true,
  thinking: false,
  vision: false,
  strictMode: false,
  maxContextTokens: 8_000,
  toolAccuracy: 0.6,
}

interface OllamaToolCall {
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

interface OllamaChatMessage {
  role: string
  content: string
  tool_calls?: OllamaToolCall[]
}

interface OllamaStreamChunk {
  model: string
  message: OllamaChatMessage
  done: boolean
  done_reason?: string
  eval_count?: number
  prompt_eval_count?: number
}

export class OllamaProvider implements ProviderBridge {
  name = 'ollama'
  private baseUrl = 'http://localhost:11434'
  private model = 'deepseek-r1:14b'
  private capabilities: ModelCapabilities = { ...DEFAULT_CAPABILITIES }

  async connect(config: ProviderConfig): Promise<void> {
    if (config.baseUrl) this.baseUrl = config.baseUrl
    this.model = config.model

    // look up model-specific capabilities
    const base = Object.keys(MODEL_PROFILES).find(k =>
      this.model.startsWith(k)
    )
    if (base) {
      this.capabilities = { ...DEFAULT_CAPABILITIES, ...MODEL_PROFILES[base] }
    }

    // verify ollama is running
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`)
      if (!res.ok) throw new Error(`ollama returned ${res.status}`)
    } catch (e) {
      throw new Error(
        `cannot connect to ollama at ${this.baseUrl}. is it running? (ollama serve)`
      )
    }
  }

  getCapabilities(): ModelCapabilities {
    return this.capabilities
  }

  async *streamMessage(params: MessageParams): AsyncGenerator<StreamEvent> {
    const body = this.buildRequestBody(params)

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: params.signal,
    })

    if (!res.ok) {
      yield { type: 'error', error: `ollama error: ${res.status} ${res.statusText}` }
      return
    }

    const reader = res.body?.getReader()
    if (!reader) {
      yield { type: 'error', error: 'no response body from ollama' }
      return
    }

    const decoder = new TextDecoder()
    let messageId = crypto.randomUUID()
    let fullText = ''
    let toolCalls: ToolUseBlock[] = []
    let inputTokens = 0
    let outputTokens = 0

    yield { type: 'message_start', id: messageId }

    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // ollama streams newline-delimited JSON
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue

        let chunk: OllamaStreamChunk
        try {
          chunk = JSON.parse(line)
        } catch {
          continue
        }

        if (chunk.message?.content) {
          fullText += chunk.message.content
          yield { type: 'text_delta', text: chunk.message.content }
        }

        if (chunk.message?.tool_calls) {
          for (const tc of chunk.message.tool_calls) {
            const id = crypto.randomUUID()
            toolCalls.push({
              type: 'tool_use',
              id,
              name: tc.function.name,
              input: tc.function.arguments,
            })
            yield { type: 'tool_call_start', id, name: tc.function.name }
            yield {
              type: 'tool_call_delta',
              id,
              inputJson: JSON.stringify(tc.function.arguments),
            }
            yield { type: 'tool_call_end', id }
          }
        }

        if (chunk.done) {
          inputTokens = chunk.prompt_eval_count || 0
          outputTokens = chunk.eval_count || 0
        }
      }
    }

    const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn'

    yield {
      type: 'message_end',
      usage: { inputTokens, outputTokens },
      stopReason,
    }
  }

  async createMessage(params: MessageParams): Promise<MessageResponse> {
    const body = this.buildRequestBody(params)
    body.stream = false

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: params.signal,
    })

    if (!res.ok) {
      throw new Error(`ollama error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json() as OllamaStreamChunk

    const content: ContentBlock[] = []

    if (data.message?.content) {
      content.push({ type: 'text', text: data.message.content })
    }

    if (data.message?.tool_calls) {
      for (const tc of data.message.tool_calls) {
        content.push({
          type: 'tool_use',
          id: crypto.randomUUID(),
          name: tc.function.name,
          input: tc.function.arguments,
        })
      }
    }

    const hasTools = content.some(b => b.type === 'tool_use')

    return {
      id: crypto.randomUUID(),
      content,
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
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
    // already normalized in stream/create — pass through
    return content
  }

  private buildRequestBody(params: MessageParams) {
    const messages = this.formatMessages(params.messages)

    if (params.system) {
      messages.unshift({ role: 'system', content: params.system })
    }

    const body: Record<string, unknown> = {
      model: params.model || this.model,
      messages,
      stream: true,
    }

    if (params.tools && params.tools.length > 0) {
      // budget tools based on model capability
      const maxTools = this.capabilities.maxTools
      const tools = params.tools.slice(0, maxTools)
      body.tools = tools.map(t => this.formatToolSchema(t))
    }

    if (params.maxTokens) {
      body.options = { num_predict: params.maxTokens }
    }

    return body
  }

  /**
   * format a message for ollama's /api/chat.
   * a single internal message may expand to multiple ollama messages
   * (e.g. a user message with multiple tool_results becomes multiple tool messages).
   */
  private formatMessages(msgs: Message[]): { role: string; content: string; tool_calls?: OllamaToolCall[]; tool_call_id?: string }[] {
    const result: { role: string; content: string; tool_calls?: OllamaToolCall[]; tool_call_id?: string }[] = []

    for (const msg of msgs) {
      if (msg.role === 'assistant') {
        // assistant messages: extract text + tool_calls separately
        const textParts: string[] = []
        const toolCalls: OllamaToolCall[] = []

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              function: {
                name: block.name,
                arguments: block.input,
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
        // user messages: split tool_results into separate tool messages
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

        // if there was non-tool text, add it as a user message
        if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('\n') })
        }
      }
    }

    return result
  }
}