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
  TextBlock,
  ToolUseBlock,
} from '../types/index.js'

// ollama model capability profiles
const MODEL_PROFILES: Record<string, Partial<ModelCapabilities>> = {
  'llama3.2': { maxTools: 5, toolAccuracy: 0.65, maxContextTokens: 128_000 },
  'llama3.1': { maxTools: 8, toolAccuracy: 0.7, maxContextTokens: 128_000 },
  'llama3.3': { maxTools: 10, toolAccuracy: 0.75, maxContextTokens: 128_000 },
  'qwen2.5-coder': { maxTools: 10, toolAccuracy: 0.75, maxContextTokens: 32_000 },
  'qwen3': { maxTools: 12, toolAccuracy: 0.8, maxContextTokens: 128_000 },
  'mistral': { maxTools: 8, toolAccuracy: 0.7, maxContextTokens: 32_000 },
  'deepseek-coder-v2': { maxTools: 8, toolAccuracy: 0.7, maxContextTokens: 128_000 },
  'command-r': { maxTools: 10, toolAccuracy: 0.75, maxContextTokens: 128_000 },
  'gemma4': { maxTools: 12, toolAccuracy: 0.85, maxContextTokens: 256_000 },
  'gemma4:e4b': { maxTools: 10, toolAccuracy: 0.8, maxContextTokens: 256_000 },
  'gemma4:27b': { maxTools: 12, toolAccuracy: 0.86, maxContextTokens: 256_000 },
  'gemma4:2b': { maxTools: 5, toolAccuracy: 0.7, maxContextTokens: 256_000 },
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
  private model = 'qwen2.5-coder:7b'
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

    // if model dumped tool calls as text instead of structured tool_calls,
    // parse them from the text content.
    if (toolCalls.length === 0 && fullText) {
      // gemma4 native format: always parse (call:Tool{...} is unambiguous)
      const gemmaCall = tryParseGemmaFormat(fullText)
      if (gemmaCall) {
        toolCalls = [gemmaCall]
        yield { type: 'tool_call_start', id: gemmaCall.id, name: gemmaCall.name }
        yield { type: 'tool_call_delta', id: gemmaCall.id, inputJson: JSON.stringify(gemmaCall.input) }
        yield { type: 'tool_call_end', id: gemmaCall.id }
      } else {
        // JSON format: be conservative (only single call, minimal surrounding text)
        const parsed = parseToolCallsFromText(fullText)
        if (parsed.length === 1 && isSingleToolCallResponse(fullText)) {
          toolCalls = parsed
          for (const tc of parsed) {
            yield { type: 'tool_call_start', id: tc.id, name: tc.name }
            yield { type: 'tool_call_delta', id: tc.id, inputJson: JSON.stringify(tc.input) }
            yield { type: 'tool_call_end', id: tc.id }
          }
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
    const messages = params.messages.map(m => this.formatMessage(m))

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

  private formatMessage(msg: Message): { role: string; content: string; tool_call_id?: string } {
    const role = msg.role === 'assistant' ? 'assistant' : 'user'

    // flatten content blocks to string
    const parts: string[] = []
    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          parts.push(block.text)
          break
        case 'tool_result':
          // ollama uses role: 'tool' for results, but in /api/chat
          // we send it as a user message with context
          return {
            role: 'tool',
            content: typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content),
            tool_call_id: block.toolUseId,
          }
        case 'tool_use':
          // tool calls are in assistant messages, handled by response parsing
          parts.push(`[calling tool: ${block.name}]`)
          break
        case 'thinking':
          // skip thinking blocks for non-thinking models
          break
        case 'image':
          parts.push('[image]')
          break
      }
    }

    return { role, content: parts.join('\n') }
  }
}

/**
 * check if the response is primarily a single tool call,
 * not a multi-option explanation with JSON examples.
 */
function isSingleToolCallResponse(text: string): boolean {
  // count JSON blocks — if more than 1, it's showing options
  const jsonBlocks = (text.match(/```(?:json)?[\s\S]*?```/g) || []).length
  if (jsonBlocks > 1) return false

  // if there's a question mark, the model is asking, not executing
  if (text.includes('Which option') || text.includes('which option') ||
      text.includes('Would you like') || text.includes('would you like') ||
      text.includes('Do you want') || text.includes('do you want')) {
    return false
  }

  // if the non-JSON text is very long, the model is explaining, not calling
  const textWithoutJson = text.replace(/```(?:json)?[\s\S]*?```/g, '').trim()
  // allow some intro text ("Let me check that for you.") but not paragraphs
  if (textWithoutJson.length > 200) return false

  return true
}

/**
 * parse tool calls from text content.
 * some models (qwen, deepseek) dump tool calls as JSON text
 * instead of using structured tool_calls.
 * handles: raw JSON, markdown code blocks, multiple calls.
 */
function parseToolCallsFromText(text: string): ToolUseBlock[] {
  const results: ToolUseBlock[] = []

  // try to extract JSON from markdown code blocks first
  const codeBlockPattern = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g
  let match: RegExpExecArray | null

  while ((match = codeBlockPattern.exec(text)) !== null) {
    const parsed = tryParseToolCall(match[1].trim())
    if (parsed) results.push(parsed)
  }

  if (results.length > 0) return results

  // try the full text as JSON
  const parsed = tryParseToolCall(text.trim())
  if (parsed) results.push(parsed)

  if (results.length > 0) return results

  // try to find JSON objects in the text
  const jsonPattern = /\{[^{}]*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[^}]*\}[^{}]*\}/g
  while ((match = jsonPattern.exec(text)) !== null) {
    const parsed = tryParseToolCall(match[0])
    if (parsed) results.push(parsed)
  }

  return results
}

function tryParseToolCall(text: string): ToolUseBlock | null {
  // gemma4 native format: call:ToolName{key:<|"|>value<|"|>,key2:<|"|>value2<|"|>}
  const gemmaResult = tryParseGemmaFormat(text)
  if (gemmaResult) return gemmaResult

  // JSON formats
  try {
    const obj = JSON.parse(text)

    // format: { "name": "Bash", "arguments": { "command": "pwd" } }
    if (obj.name && obj.arguments && typeof obj.arguments === 'object') {
      return {
        type: 'tool_use',
        id: crypto.randomUUID(),
        name: obj.name.split(' ')[0],
        input: obj.arguments,
      }
    }

    // format: { "tool": "Bash", "input": { "command": "pwd" } }
    if (obj.tool && obj.input && typeof obj.input === 'object') {
      return {
        type: 'tool_use',
        id: crypto.randomUUID(),
        name: obj.tool,
        input: obj.input,
      }
    }
  } catch {
    // not valid JSON
  }

  return null
}

/**
 * parse gemma4's native tool call format.
 *
 * gemma4 outputs tool calls as:
 *   call:Write{content:<|"|>file content here<|"|>,file_path:<|"|>todo.py<|"|>}
 *   call:Bash{command:<|"|>ls -la<|"|>}
 *
 * the <|"|> delimiters wrap values. values can contain any character
 * including newlines, quotes, braces — the delimiters are the only boundary.
 */
function tryParseGemmaFormat(text: string): ToolUseBlock | null {
  // match anywhere in text, not just start (model may prefix with explanation)
  const callMatch = text.match(/call:(\w+)\{([\s\S]*)\}/)
  if (!callMatch) return null

  const name = callMatch[1]!
  const argsBody = callMatch[2]!
  const input: Record<string, unknown> = {}

  // parse <|"|> delimited key:value pairs
  // pattern: key:<|"|>value<|"|>
  // values can contain ANYTHING between delimiters (newlines, quotes, braces)
  let pos = 0
  while (pos < argsBody.length) {
    // skip whitespace and commas
    while (pos < argsBody.length && /[\s,]/.test(argsBody[pos]!)) pos++
    if (pos >= argsBody.length) break

    // read key (word characters until :)
    const keyMatch = argsBody.slice(pos).match(/^(\w+):/)
    if (!keyMatch) break
    const key = keyMatch[1]!
    pos += keyMatch[0].length

    // expect <|"|> opening delimiter
    const openDelim = '<|"|>'
    if (argsBody.slice(pos, pos + openDelim.length) !== openDelim) {
      // no delimiter — try reading until next comma or end
      const rawEnd = argsBody.indexOf(',', pos)
      const rawValue = rawEnd === -1
        ? argsBody.slice(pos).trim()
        : argsBody.slice(pos, rawEnd).trim()
      input[key] = rawValue
      pos = rawEnd === -1 ? argsBody.length : rawEnd + 1
      continue
    }
    pos += openDelim.length

    // read value until closing <|"|>
    const closeDelim = '<|"|>'
    const closeIdx = argsBody.indexOf(closeDelim, pos)
    if (closeIdx === -1) {
      // no closing delimiter — take everything remaining
      input[key] = argsBody.slice(pos)
      break
    }

    input[key] = argsBody.slice(pos, closeIdx)
    pos = closeIdx + closeDelim.length
  }

  if (Object.keys(input).length === 0) return null

  return {
    type: 'tool_use',
    id: crypto.randomUUID(),
    name,
    input,
  }
}
