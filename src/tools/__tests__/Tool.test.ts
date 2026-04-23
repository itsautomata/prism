import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildTool, toolToSchema } from '../Tool.js'

describe('buildTool', () => {
  const testTool = buildTool({
    name: 'TestTool',
    description: 'a test tool',
    inputSchema: z.object({
      text: z.string().describe('input text'),
      count: z.number().optional().describe('repeat count'),
    }),
    async call(input) {
      return { content: input.text.repeat(input.count || 1) }
    },
  })

  it('sets the name and description', () => {
    expect(testTool.name).toBe('TestTool')
    expect(testTool.description).toBe('a test tool')
  })

  it('defaults isConcurrencySafe to false', () => {
    expect(testTool.isConcurrencySafe({ text: '' })).toBe(false)
  })

  it('defaults isReadOnly to false', () => {
    expect(testTool.isReadOnly({ text: '' })).toBe(false)
  })

  it('defaults checkPermissions to ask', () => {
    const result = testTool.checkPermissions({ text: '' }, { cwd: '/tmp' })
    expect(result.behavior).toBe('ask')
  })

  it('allows overriding defaults', () => {
    const readOnly = buildTool({
      name: 'ReadOnly',
      description: 'read only tool',
      inputSchema: z.object({}),
      async call() { return { content: 'ok' } },
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      checkPermissions: () => ({ behavior: 'allow' }),
    })

    expect(readOnly.isConcurrencySafe({})).toBe(true)
    expect(readOnly.isReadOnly({})).toBe(true)
    expect(readOnly.checkPermissions({}, { cwd: '/tmp' }).behavior).toBe('allow')
  })

  it('executes the call function', async () => {
    const result = await testTool.call({ text: 'hi', count: 3 }, { cwd: '/tmp' })
    expect(result.content).toBe('hihihi')
  })
})

describe('toolToSchema', () => {
  const tool = buildTool({
    name: 'Schema',
    description: 'schema test',
    inputSchema: z.object({
      path: z.string().describe('file path'),
      lines: z.number().optional().describe('line count'),
      verbose: z.boolean().describe('verbose output'),
    }),
    async call() { return { content: '' } },
  })

  it('converts to provider-agnostic ToolSchema', () => {
    const schema = toolToSchema(tool)
    expect(schema.name).toBe('Schema')
    expect(schema.description).toBe('schema test')
    expect(schema.inputSchema).toBeDefined()
  })

  it('converts zod to JSON Schema with correct types', () => {
    const schema = toolToSchema(tool)
    const input = schema.inputSchema as Record<string, unknown>
    expect(input.type).toBe('object')

    const props = input.properties as Record<string, Record<string, unknown>>
    expect(props.path.type).toBe('string')
    expect(props.lines.type).toBe('number')
    expect(props.verbose.type).toBe('boolean')
  })

  it('marks required fields correctly', () => {
    const schema = toolToSchema(tool)
    const input = schema.inputSchema as Record<string, unknown>
    const required = input.required as string[]
    expect(required).toContain('path')
    expect(required).toContain('verbose')
    expect(required).not.toContain('lines')
  })

  it('includes descriptions from zod', () => {
    const schema = toolToSchema(tool)
    const props = (schema.inputSchema as any).properties
    expect(props.path.description).toBe('file path')
    expect(props.lines.description).toBe('line count')
  })
})
