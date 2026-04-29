/**
 * completion spec.
 * single source of truth for what shell completion suggests.
 * cli.ts and the completion script emitters both read from here.
 *
 * also owns the openrouter model catalog cache (~/.prism/cache/openrouter-models.json).
 * the catalog is shared with providers/openrouter.ts for capability inference.
 */

import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { listSessions } from '../sessions/store.js'

export type ValueKind = 'model-ollama' | 'model-openrouter' | 'number' | 'session-id'

export interface FlagSpec {
  flag: string
  alias?: string
  desc: string
  /** value-kind hint for shell completion (what to suggest after this flag) */
  takesValue?: ValueKind
  /**
   * true when the flag's value is a positional arg, not consumed by the flag itself.
   * e.g. `--or qwen3:14b` — the model is positional, --or just flips a boolean.
   * cli.ts uses this to decide whether to skip the next arg during validation.
   */
  positionalValue?: boolean
}

export const FLAGS: FlagSpec[] = [
  { flag: '--or', alias: '--openrouter', desc: 'use OpenRouter provider', takesValue: 'model-openrouter', positionalValue: true },
  { flag: '-c', alias: '--continue', desc: 'resume last session in this directory' },
  { flag: '-r', alias: '--resume', desc: 'resume a specific session by id', takesValue: 'session-id' },
  { flag: '--max-tokens', desc: 'max output tokens per response', takesValue: 'number' },
  { flag: '--config', desc: 'show config file path' },
  { flag: '--sessions', desc: 'list recent sessions' },
  { flag: '--no-scan', desc: 'skip the live project scan at startup' },
  { flag: '--no-memory', desc: 'skip lens.md + persistent memo at startup' },
  { flag: '-h', alias: '--help', desc: 'show help' },
]

export function allFlagTokens(): string[] {
  const tokens: string[] = []
  for (const f of FLAGS) {
    tokens.push(f.flag)
    if (f.alias) tokens.push(f.alias)
  }
  return tokens
}

export function findFlag(token: string): FlagSpec | undefined {
  return FLAGS.find(f => f.flag === token || f.alias === token)
}

/**
 * the set of flag tokens that *consume* their next argument (the next arg is the
 * flag's value, not a positional). used by cli.ts to skip those values when
 * validating unknown flags and counting positional args. flags marked with
 * positionalValue are excluded because their "value" is actually a positional.
 */
export function valueTakingFlagTokens(): Set<string> {
  const set = new Set<string>()
  for (const f of FLAGS) {
    if (f.takesValue && !f.positionalValue) {
      set.add(f.flag)
      if (f.alias) set.add(f.alias)
    }
  }
  return set
}

export function completeOllamaModels(): string[] {
  try {
    const out = execSync('ollama list', { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = out.trim().split('\n').slice(1)
    return lines.map(l => l.split(/\s+/)[0]).filter((x): x is string => Boolean(x))
  } catch {
    return []
  }
}

// shape we extract from the openrouter /models endpoint.
// every other field is dropped to keep the cache small.
export interface OpenRouterModelMeta {
  id: string
  context_length?: number
  architecture?: { input_modalities?: string[] }
  supported_parameters?: string[]
}

const FALLBACK_OPENROUTER_MODELS: OpenRouterModelMeta[] = [
  { id: 'qwen/qwen3-coder-480b', context_length: 262_000, supported_parameters: ['tools', 'tool_choice'] },
  { id: 'qwen/qwen3.6-plus', context_length: 1_000_000, supported_parameters: ['tools', 'tool_choice'] },
  { id: 'deepseek/deepseek-r1', context_length: 128_000, supported_parameters: ['tools', 'tool_choice', 'reasoning'] },
  { id: 'deepseek/deepseek-v3.2', context_length: 128_000, supported_parameters: ['tools', 'tool_choice'] },
  { id: 'google/gemini-2.5-flash', context_length: 1_000_000, supported_parameters: ['tools', 'tool_choice'] },
  { id: 'openai/gpt-4.1-mini', context_length: 128_000, supported_parameters: ['tools', 'tool_choice'] },
  { id: 'anthropic/claude-haiku-4.5', context_length: 200_000, supported_parameters: ['tools', 'tool_choice'] },
  { id: 'anthropic/claude-sonnet-4', context_length: 200_000, supported_parameters: ['tools', 'tool_choice'] },
]

const CACHE_DIR = join(homedir(), '.prism', 'cache')
const OR_CACHE_PATH = join(CACHE_DIR, 'openrouter-models.json')
const TTL_MS = 24 * 60 * 60 * 1000  // 24h

interface OpenRouterCache {
  fetchedAt: number
  models: OpenRouterModelMeta[]
}

function readCache(): OpenRouterCache | null {
  if (!existsSync(OR_CACHE_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(OR_CACHE_PATH, 'utf-8'))
    // tolerate the old cache shape (string[]) by treating it as expired
    if (!Array.isArray(raw.models) || raw.models.length === 0 || typeof raw.models[0] === 'string') {
      return null
    }
    return raw
  } catch {
    return null
  }
}

function writeCache(models: OpenRouterModelMeta[]): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(OR_CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), models }), 'utf-8')
  } catch {}
}

async function fetchOpenRouterModelsFromAPI(): Promise<OpenRouterModelMeta[]> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 1500)
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: ctrl.signal })
    if (!res.ok) return []
    const data = await res.json() as { data?: OpenRouterModelMeta[] }
    if (!data.data) return []
    return data.data.map(m => ({
      id: m.id,
      context_length: m.context_length,
      architecture: m.architecture ? { input_modalities: m.architecture.input_modalities } : undefined,
      supported_parameters: m.supported_parameters,
    }))
  } catch {
    return []
  } finally {
    clearTimeout(t)
  }
}

export async function getOpenRouterCatalog(): Promise<OpenRouterModelMeta[]> {
  const cache = readCache()
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) {
    return cache.models
  }
  const fresh = await fetchOpenRouterModelsFromAPI()
  if (fresh.length > 0) {
    writeCache(fresh)
    return fresh
  }
  if (cache && cache.models.length > 0) return cache.models
  return FALLBACK_OPENROUTER_MODELS
}

export function getOpenRouterModelMeta(id: string): OpenRouterModelMeta | null {
  // sync read of whatever's currently in the cache (no API call).
  // returns null if the cache is empty/missing, in which case the caller
  // falls back to defaults.
  const cache = readCache()
  if (!cache) return null
  return cache.models.find(m => m.id === id) || null
}

export async function completeOpenRouterModels(): Promise<string[]> {
  const catalog = await getOpenRouterCatalog()
  return catalog.map(m => m.id).sort()
}

export function completeSessionIds(): string[] {
  try {
    return listSessions(20).map(s => s.id)
  } catch {
    return []
  }
}

export async function complete(context: string): Promise<string[]> {
  switch (context) {
    case 'flags':
      return allFlagTokens()
    case 'model-ollama':
      return completeOllamaModels()
    case 'model-openrouter':
      return await completeOpenRouterModels()
    case 'session-id':
      return completeSessionIds()
    default:
      return []
  }
}
