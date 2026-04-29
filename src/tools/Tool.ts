/**
 * tool interface.
 * composition over inheritance. fail-closed defaults.
 * every tool is a record of functions, not a class hierarchy.
 */

import { z } from 'zod'
import type { ToolSchema } from '../types/index.js'

export interface ToolResult {
  content: string
  isError?: boolean
  userDenied?: boolean
}

export interface ToolContext {
  cwd: string
  signal?: AbortSignal
}

export type PermissionResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; message: string }
  | { behavior: 'ask'; message: string }

export interface Tool<Input = Record<string, unknown>> {
  // identity
  name: string
  description: string

  // schema
  inputSchema: z.ZodType<Input>

  // execution
  call(input: Input, context: ToolContext): Promise<ToolResult>

  // safety — fail-closed defaults
  isConcurrencySafe(input: Input): boolean
  isReadOnly(input: Input): boolean
  checkPermissions(input: Input, context: ToolContext): PermissionResult
}

// fail-closed defaults
const TOOL_DEFAULTS = {
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  checkPermissions: (): PermissionResult => ({ behavior: 'ask', message: 'allow this action?' }),
}

/**
 * buildTool — create a tool with safe defaults.
 * you provide what's unique, defaults handle the rest.
 */
export function buildTool<Input>(
  def: {
    name: string
    description: string
    inputSchema: z.ZodType<Input>
    call: (input: Input, context: ToolContext) => Promise<ToolResult>
    isConcurrencySafe?: (input: Input) => boolean
    isReadOnly?: (input: Input) => boolean
    checkPermissions?: (input: Input, context: ToolContext) => PermissionResult
  }
): Tool<Input> {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    call: def.call,
    isConcurrencySafe: def.isConcurrencySafe ?? TOOL_DEFAULTS.isConcurrencySafe,
    isReadOnly: def.isReadOnly ?? TOOL_DEFAULTS.isReadOnly,
    checkPermissions: def.checkPermissions ?? TOOL_DEFAULTS.checkPermissions,
  }
}

/**
 * convert a Tool to the provider-agnostic ToolSchema format.
 * the provider bridge then translates this to provider-specific format.
 */
export function toolToSchema(tool: Tool): ToolSchema {
  // zod-to-json-schema conversion (simplified)
  const jsonSchema = zodToJsonSchema(tool.inputSchema)

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: jsonSchema,
  }
}

/**
 * minimal zod-to-json-schema converter.
 * handles the common cases: object, string, number, boolean, array, optional.
 */
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [key, value] of Object.entries(shape)) {
      const unwrapped = unwrapOptional(value)
      properties[key] = zodToJsonSchema(unwrapped.schema)
      if (unwrapped.description) {
        (properties[key] as Record<string, unknown>).description = unwrapped.description
      }
      if (!unwrapped.isOptional) {
        required.push(key)
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    }
  }

  if (schema instanceof z.ZodString) return { type: 'string' }
  if (schema instanceof z.ZodNumber) return { type: 'number' }
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' }

  if (schema instanceof z.ZodArray) {
    return {
      type: 'array',
      items: zodToJsonSchema((schema as z.ZodArray<z.ZodType>)._def.type),
    }
  }

  if (schema instanceof z.ZodEnum) {
    return { type: 'string', enum: schema._def.values }
  }

  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema._def.innerType)
  }

  if (schema instanceof z.ZodDefault) {
    return zodToJsonSchema(schema._def.innerType)
  }

  // fallback
  return { type: 'string' }
}

function unwrapOptional(schema: z.ZodType): {
  schema: z.ZodType
  isOptional: boolean
  description: string | undefined
} {
  let current = schema
  let isOptional = false
  let description: string | undefined

  if (current._def?.description) {
    description = current._def.description
  }

  if (current instanceof z.ZodOptional) {
    isOptional = true
    current = current._def.innerType
  }

  if (current instanceof z.ZodDefault) {
    isOptional = true
    current = current._def.innerType
  }

  if (!description && current._def?.description) {
    description = current._def.description
  }

  return { schema: current, isOptional, description }
}
