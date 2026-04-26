/**
 * model learning profiles.
 * users teach prism how to talk to each model.
 * explicit only — prism does not assume.
 *
 * stored at ~/.prism/models/<model>.json
 * editable by hand or via /teach command
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface LearnedRule {
  rule: string          // what the model should or shouldn't do
  source: 'user'        // always explicit
  addedAt: string       // ISO date
}

export interface ModelProfile {
  model: string
  maxToolsOverride: number | null       // user can lower tool count
  rules: LearnedRule[]                  // explicit learned rules
}

const PROFILES_DIR = join(homedir(), '.prism', 'models')

function ensureDir(): void {
  if (!existsSync(PROFILES_DIR)) {
    mkdirSync(PROFILES_DIR, { recursive: true })
  }
}

function profilePath(model: string): string {
  // sanitize model name for filesystem
  const safe = model.replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(PROFILES_DIR, `${safe}.json`)
}

export function loadProfile(model: string): ModelProfile {
  const path = profilePath(model)

  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'))
      return {
        model,
        maxToolsOverride: data.maxToolsOverride ?? null,
        rules: data.rules ?? [],
      }
    } catch {
      // corrupted file, start fresh
    }
  }

  return {
    model,
    maxToolsOverride: null,
    rules: [],
  }
}

export function saveProfile(profile: ModelProfile): void {
  ensureDir()
  const path = profilePath(profile.model)
  writeFileSync(path, JSON.stringify(profile, null, 2), 'utf-8')
}

export function addRule(model: string, rule: string): ModelProfile {
  const profile = loadProfile(model)

  // don't duplicate
  if (profile.rules.some(r => r.rule === rule)) {
    return profile
  }

  profile.rules.push({
    rule,
    source: 'user',
    addedAt: new Date().toISOString(),
  })

  saveProfile(profile)
  return profile
}

export function removeRule(model: string, index: number): ModelProfile {
  const profile = loadProfile(model)

  if (index >= 0 && index < profile.rules.length) {
    profile.rules.splice(index, 1)
  }

  saveProfile(profile)
  return profile
}

export function setMaxTools(model: string, maxTools: number): ModelProfile {
  const profile = loadProfile(model)
  profile.maxToolsOverride = Math.max(1, maxTools)
  saveProfile(profile)
  return profile
}

export function listProfiles(): string[] {
  ensureDir()
  try {
    const { readdirSync } = require('fs')
    return readdirSync(PROFILES_DIR)
      .filter((f: string) => f.endsWith('.json'))
      .map((f: string) => f.replace('.json', ''))
  } catch {
    return []
  }
}

/**
 * format learned rules into system prompt injection.
 * these get appended to the system prompt for this specific model.
 */
export function rulesToPrompt(profile: ModelProfile): string | null {
  if (profile.rules.length === 0) return null

  const lines = profile.rules.map((r, i) => `${i + 1}. ${r.rule}`)

  return `# Learned rules for this model

The user has taught these specific rules for how you should behave:
${lines.join('\n')}

Follow these rules exactly. They override general instructions when they conflict.`
}
