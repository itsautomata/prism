/**
 * prism config.
 * reads from ~/.prism/config.toml
 * env vars override config file.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const PRISM_DIR = join(homedir(), '.prism')
const CONFIG_PATH = join(PRISM_DIR, 'config.toml')

export interface PrismConfig {
  default_provider: string
  default_model: string
  openrouter: { api_key: string }
  anthropic: { api_key: string }
  openai: { api_key: string }
  google: { api_key: string }
  ollama: { base_url: string }
}

const DEFAULTS: PrismConfig = {
  default_provider: 'ollama',
  default_model: 'deepseek-r1:14b',
  openrouter: { api_key: '' },
  anthropic: { api_key: '' },
  openai: { api_key: '' },
  google: { api_key: '' },
  ollama: { base_url: 'http://localhost:11434' },
}

/**
 * load config from ~/.prism/config.toml
 * env vars take priority over config file.
 */
export function loadConfig(): PrismConfig {
  const config = { ...DEFAULTS }

  // read config file if it exists
  if (existsSync(CONFIG_PATH)) {
    try {
      const text = readFileSync(CONFIG_PATH, 'utf-8')
      const parsed = parseToml(text)

      if (parsed.default_provider) config.default_provider = parsed.default_provider
      if (parsed.default_model) config.default_model = parsed.default_model

      if (parsed.openrouter?.api_key) config.openrouter.api_key = parsed.openrouter.api_key
      if (parsed.anthropic?.api_key) config.anthropic.api_key = parsed.anthropic.api_key
      if (parsed.openai?.api_key) config.openai.api_key = parsed.openai.api_key
      if (parsed.google?.api_key) config.google.api_key = parsed.google.api_key
      if (parsed.ollama?.base_url) config.ollama.base_url = parsed.ollama.base_url
    } catch {}
  }

  // env vars override config
  if (process.env.OPENROUTER_API_KEY) config.openrouter.api_key = process.env.OPENROUTER_API_KEY
  if (process.env.ANTHROPIC_API_KEY) config.anthropic.api_key = process.env.ANTHROPIC_API_KEY
  if (process.env.OPENAI_API_KEY) config.openai.api_key = process.env.OPENAI_API_KEY
  if (process.env.GOOGLE_API_KEY) config.google.api_key = process.env.GOOGLE_API_KEY
  if (process.env.OLLAMA_HOST) config.ollama.base_url = process.env.OLLAMA_HOST

  return config
}

/**
 * create default config file if it doesn't exist.
 */
export function initConfig(): void {
  if (existsSync(CONFIG_PATH)) return

  if (!existsSync(PRISM_DIR)) {
    mkdirSync(PRISM_DIR, { recursive: true })
  }

  const template = `# prism config
# env vars override these values.

default_provider = "ollama"
default_model = "deepseek-r1:14b"

[openrouter]
api_key = ""

[anthropic]
api_key = ""

[openai]
api_key = ""

[google]
api_key = ""

[ollama]
base_url = "http://localhost:11434"
`

  writeFileSync(CONFIG_PATH, template, 'utf-8')
}

/**
 * get the config file path.
 */
export function getConfigPath(): string {
  return CONFIG_PATH
}

/**
 * minimal TOML parser.
 * handles: key = "value", [section], nested sections.
 * no arrays, no inline tables. enough for our config.
 */
function parseToml(text: string): Record<string, any> {
  const result: Record<string, any> = {}
  let currentSection: Record<string, any> = result

  for (const line of text.split('\n')) {
    const trimmed = line.trim()

    // skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue

    // section header
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/)
    if (sectionMatch) {
      const key = sectionMatch[1]!
      result[key] = result[key] || {}
      currentSection = result[key]
      continue
    }

    // key = value
    const kvMatch = trimmed.match(/^(\w+)\s*=\s*"([^"]*)"$/)
    if (kvMatch) {
      currentSection[kvMatch[1]!] = kvMatch[2]!
      continue
    }

    // key = value (unquoted)
    const kvUnquoted = trimmed.match(/^(\w+)\s*=\s*(.+)$/)
    if (kvUnquoted) {
      currentSection[kvUnquoted[1]!] = kvUnquoted[2]!.trim()
    }
  }

  return result
}
