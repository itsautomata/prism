/**
 * normalized message types.
 * provider adapters translate to/from these.
 * everything above the provider bridge speaks this language.
 */

export type Role = 'user' | 'assistant' | 'system'

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ImageBlock

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content: string | ContentBlock[]
  isError?: boolean
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
}

export interface ImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    mediaType: string
    data: string
  }
}

export interface Message {
  role: Role
  content: ContentBlock[]
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}
