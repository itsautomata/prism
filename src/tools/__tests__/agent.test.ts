import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// redirect homedir for the user-scope agents directory.
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${require('os').tmpdir()}/prism-agent-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
}))

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return { ...actual, homedir: () => TEST_HOME }
})

import { createAgentTool } from '../agent.js'
import type { Tool } from '../Tool.js'
import type {
  ProviderBridge,
  ProviderConfig,
  ModelCapabilities,
  MessageParams,
  MessageResponse,
  ToolSchema,
  ContentBlock,
  StreamEvent,
} from '../../types/index.js'

const CAPS: ModelCapabilities = {
  maxTools: 10,
  parallelToolCalls: true,
  streaming: true,
  thinking: false,
  vision: false,
  strictMode: false,
  maxContextTokens: 128_000,
}

/**
 * stub provider that emits one text-only turn so any subagent run terminates
 * immediately. tests that exercise dispatch don't care about the conversation
 * itself; they only check the Agent tool's resolution path.
 */
function stubProvider(): ProviderBridge {
  return {
    name: 'stub',
    async connect(_c: ProviderConfig) { /* no-op */ },
    getCapabilities: () => CAPS,
    async *streamMessage(_p: MessageParams): AsyncGenerator<StreamEvent> {
      yield { type: 'message_start', id: 'm1' }
      yield { type: 'text_delta', text: 'done.' }
      yield { type: 'message_end', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' }
    },
    async createMessage(_p: MessageParams): Promise<MessageResponse> {
      throw new Error('not used in these tests')
    },
    formatToolSchema(t: ToolSchema) { return t },
    parseToolCalls(c: ContentBlock[]) { return c },
  }
}

let projectRoot: string
let AgentTool: Tool
const USER_AGENTS_DIR = join(TEST_HOME, '.prism', 'agents')

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'prism-agent-tool-project-'))
  rmSync(USER_AGENTS_DIR, { recursive: true, force: true })
  AgentTool = createAgentTool({
    provider: stubProvider(),
    model: 'stub-model',
    subagentTools: [],
  })
})

afterAll(() => {
  rmSync(TEST_HOME, { recursive: true, force: true })
})

function writeUserAgent(name: string, body: string): void {
  mkdirSync(USER_AGENTS_DIR, { recursive: true })
  writeFileSync(join(USER_AGENTS_DIR, `${name}.md`), body, 'utf-8')
}

describe('AgentTool: dispatch', () => {
  it('runs the default agent when no name is given', async () => {
    const result = await AgentTool.call(
      { description: 'no name', prompt: 'do something simple' },
      { cwd: projectRoot },
    )
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('completed')
  })

  it('runs a user-defined agent when its name is given', async () => {
    writeUserAgent('researcher', `---
description: read-only research subagent
---
research only.`)

    const result = await AgentTool.call(
      { description: 'find something', prompt: 'do it', agent: 'researcher' },
      { cwd: projectRoot },
    )
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('completed')
  })

  it('returns isError for an unknown agent name', async () => {
    const result = await AgentTool.call(
      { description: 'oops', prompt: 'try', agent: 'does-not-exist' },
      { cwd: projectRoot },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not found')
  })

  it('refuses to invoke the recovery agent directly', async () => {
    const result = await AgentTool.call(
      { description: 'sneaky', prompt: 'try', agent: 'recovery' },
      { cwd: projectRoot },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('reserved')
  })

  it('treats an empty agent string as the default', async () => {
    const result = await AgentTool.call(
      { description: 'blank', prompt: 'do it', agent: '   ' },
      { cwd: projectRoot },
    )
    expect(result.isError).toBeFalsy()
  })

  it('surfaces validation errors from broken agent files', async () => {
    writeUserAgent('broken', `not real frontmatter`)
    const result = await AgentTool.call(
      { description: 'broken', prompt: 'try', agent: 'broken' },
      { cwd: projectRoot },
    )
    expect(result.isError).toBe(true)
    expect(result.content).toContain('invalid agent definition')
  })
})

describe('AgentTool: schema', () => {
  it('accepts the optional agent field', () => {
    const ok = AgentTool.inputSchema.safeParse({
      description: 'x',
      prompt: 'y',
      agent: 'researcher',
    })
    expect(ok.success).toBe(true)
  })

  it('agent is optional', () => {
    const ok = AgentTool.inputSchema.safeParse({ description: 'x', prompt: 'y' })
    expect(ok.success).toBe(true)
  })
})
