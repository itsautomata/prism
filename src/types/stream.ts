/**
 * normalized streaming events.
 * every provider's stream gets translated into these.
 * the query engine and UI only speak this format.
 */

import type { Usage } from './messages.js'

export type StreamEvent =
  | MessageStartEvent
  | TextDeltaEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | ThinkingDeltaEvent
  | MessageEndEvent
  | ErrorEvent

export interface MessageStartEvent {
  type: 'message_start'
  id: string
}

export interface TextDeltaEvent {
  type: 'text_delta'
  text: string
}

export interface ToolCallStartEvent {
  type: 'tool_call_start'
  id: string
  name: string
}

export interface ToolCallDeltaEvent {
  type: 'tool_call_delta'
  id: string
  inputJson: string
}

export interface ToolCallEndEvent {
  type: 'tool_call_end'
  id: string
}

export interface ThinkingDeltaEvent {
  type: 'thinking_delta'
  text: string
}

export interface MessageEndEvent {
  type: 'message_end'
  usage: Usage
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'
}

export interface ErrorEvent {
  type: 'error'
  error: string
}
