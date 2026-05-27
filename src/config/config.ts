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

/**
 * global tuning knobs. read from the [tuning] section of config.toml and
 * threaded through the runtime. every field has a sensible built-in default;
 * config.toml only needs to list values you want to change.
 *
 * precedence: CLI flag (when one exists) > config.toml > built-in default.
 */
export interface TuningConfig {
  /* ── retrieval / repo-map ────────────────────────────────────────────── */

  /**
   * hard cap on how many source files the repo-map walker visits per build.
   * larger projects are sampled, not fully walked. bumping this trades wall
   * time at startup for broader coverage. override per-session with
   * `--max-files <n>`.
   */
  repomap_max_files: number

  /**
   * cap on the number of lines the formatted repo-map block injects into the
   * system prompt. when exceeded, the formatter truncates and appends a
   * "...and N more files" footer the model can act on. larger value = more
   * structural context, more tokens per turn. override per-session with
   * `--max-lines <n>`.
   */
  repomap_max_lines: number

  /**
   * cap on symbols listed per file in the repo-map. higher = denser per-file
   * detail, fewer files fit under the line cap. lower = more files, less
   * detail per file. tune against your repo's shape.
   */
  repomap_max_symbols_per_file: number

  /* ── memory layer ────────────────────────────────────────────────────── */

  /**
   * size cap on `lens.md` (project-local instructions, committed to the repo).
   * if the file exceeds this, the loader truncates and appends a marker. only
   * a sanity bound for runaway files; normal lens.md sits well under it.
   */
  lens_max_bytes: number

  /* ── shell escape (! prefix in the prompt) ───────────────────────────── */

  /**
   * timeout for inline shell escapes typed as `!<cmd>` in the prompt. caps
   * runaway commands without affecting the model's own Bash tool calls
   * (those have their own timeout argument).
   */
  bash_timeout_ms: number

  /**
   * size cap on output captured from `!<cmd>` (and from the model's Bash
   * tool). output past this is truncated with a marker. protects the UI
   * and the conversation from being flooded by `find /` and friends.
   */
  bash_max_output_bytes: number

  /* ── engine self-management ──────────────────────────────────────────── */

  /**
   * fraction of the model's context window at which the compaction pipeline
   * (trim → snip → summarize) fires. 0.8 means "compact once you've used 80%."
   * lower = compact earlier (safer, more model calls). a derived secondary
   * snip threshold fires at 0.75× this value to give summarize room to breathe.
   */
  compaction_threshold: number

  /**
   * how many consecutive empty model turns the engine will nudge before
   * giving up. an "empty turn" is when the model returns neither text nor
   * tool calls, common with weaker models after a tool result. higher =
   * more patience with flaky models. lower = faster failure on stuck loops.
   */
  empty_turn_nudge_cap: number

  /**
   * max visible lines in the input box. when the user types past this, the
   * box stops growing and the viewport scrolls to keep the cursor visible.
   * indicators above and below show the count of hidden lines.
   */
  input_viewport_max_lines: number
}

export interface PrismConfig {
  default_provider: string
  default_model: string
  openrouter: { api_key: string }
  anthropic: { api_key: string }
  openai: { api_key: string }
  google: { api_key: string }
  ollama: { base_url: string }
  tuning: TuningConfig
}

const TUNING_DEFAULTS: TuningConfig = {
  repomap_max_files: 500,
  repomap_max_lines: 500,
  repomap_max_symbols_per_file: 10,
  lens_max_bytes: 64 * 1024,
  bash_timeout_ms: 30_000,
  bash_max_output_bytes: 512 * 1024,
  compaction_threshold: 0.8,
  empty_turn_nudge_cap: 2,
  input_viewport_max_lines: 10,
}

const DEFAULTS: PrismConfig = {
  default_provider: 'ollama',
  default_model: 'deepseek-r1:14b',
  openrouter: { api_key: '' },
  anthropic: { api_key: '' },
  openai: { api_key: '' },
  google: { api_key: '' },
  ollama: { base_url: 'http://localhost:11434' },
  tuning: { ...TUNING_DEFAULTS },
}

/**
 * load config from ~/.prism/config.toml
 * env vars take priority over config file.
 */
export function loadConfig(): PrismConfig {
  // deep clone so mutations to nested objects (the per-provider tables and
  // [tuning]) never leak back into the shared DEFAULTS reference.
  const config: PrismConfig = structuredClone(DEFAULTS)

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

      // tuning section: every key is optional; missing entries fall back to defaults.
      if (parsed.tuning) {
        for (const key of Object.keys(TUNING_DEFAULTS) as (keyof TuningConfig)[]) {
          const value = parsed.tuning[key]
          if (typeof value === 'number' && Number.isFinite(value)) {
            config.tuning[key] = value
          }
        }
      }
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
 * the `[tuning]` block as written to config.toml. shared between initConfig
 * (which writes the whole file when it doesn't exist) and migrateConfig
 * (which appends this block to an older file that pre-dates the tuning
 * section). a single source of truth means the inline comments stay in sync.
 */
const TUNING_BLOCK = `# global tuning knobs. every key is optional. missing entries use the defaults
# shown here. CLI flags (--max-files, --max-lines, --no-repomap) override these
# on a per-session basis.
[tuning]

# ── retrieval / repo-map ────────────────────────────────────────────────
# the structural floor of the project that prism injects into every system
# prompt: paths + symbols per file. bigger map = more context, more tokens.

# how many source files the walker visits per build. larger repos are sampled.
# bumping this trades startup time for broader coverage.
# override per-session: --max-files <n>
repomap_max_files = 500

# how many lines the formatted block injects into the system prompt. excess
# is truncated and replaced with a "...and N more files" footer the model can
# act on with Read / Grep. higher = more structure visible, more tokens/turn.
# override per-session: --max-lines <n>
repomap_max_lines = 500

# symbols shown per file in the rendered map. higher = denser detail per file,
# fewer files fit. lower = more files visible, less detail each.
repomap_max_symbols_per_file = 10

# ── memory layer ────────────────────────────────────────────────────────

# size cap on lens.md (project-local rules, committed to the repo). only a
# sanity bound against runaway files. normal lens.md is well under this.
lens_max_bytes = 65536             # 64KB

# ── shell escape (! prefix in the prompt) ───────────────────────────────

# timeout for '!<cmd>' shell escapes typed in the prompt. caps runaway
# commands. does not affect the model's own Bash tool calls (those carry
# their own timeout argument).
bash_timeout_ms = 30000            # 30s

# size cap on captured output from '!<cmd>' and the Bash tool. excess is
# truncated with a marker. protects the UI from 'find /'-style floods.
bash_max_output_bytes = 524288     # 512KB

# ── engine self-management ──────────────────────────────────────────────

# fraction of the model's context window at which compaction fires
# (trim → snip → summarize). 0.8 = "compact once you've used 80%". lower
# = compact earlier (safer, more model calls). a secondary snip threshold
# derives from this at 0.75× to give summarize room to breathe.
compaction_threshold = 0.8

# how many consecutive empty model turns the engine will nudge before
# giving up. higher = more patience with flaky models. lower = faster
# failure on stuck loops.
empty_turn_nudge_cap = 2

# ── input UX ────────────────────────────────────────────────────────────

# max visible lines in the input box. typing past this freezes the box
# height and scrolls the viewport to keep the cursor visible. above and
# below the box, dim indicators show how many lines are hidden.
input_viewport_max_lines = 10
`

/**
 * the static top of config.toml: identity, provider plumbing, api keys.
 * everything below this is a [section] block that migrateConfig knows how to
 * append individually when an existing config is missing it.
 */
const BASE_TEMPLATE = `# prism config
# env vars override these values. CLI flags override env vars and config.

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

/**
 * sections that prism expects to find in config.toml. when a config file is
 * older than the current binary and missing one of these, migrateConfig
 * appends the default block at the end of the file. new sections added
 * here in future versions will be auto-migrated on the next launch.
 *
 * non-destructive: existing keys / sections / comments are never touched.
 */
const REQUIRED_TABLES: Array<{ name: string; block: string }> = [
  { name: 'tuning', block: TUNING_BLOCK },
]

/**
 * create the default config file if it doesn't exist. when it does exist,
 * delegates nothing — see migrateConfig for the upgrade path.
 */
export function initConfig(): void {
  if (existsSync(CONFIG_PATH)) return

  if (!existsSync(PRISM_DIR)) {
    mkdirSync(PRISM_DIR, { recursive: true })
  }

  const fresh = BASE_TEMPLATE + '\n' + TUNING_BLOCK
  writeFileSync(CONFIG_PATH, fresh, 'utf-8')
}

/**
 * append any [section] blocks that prism now expects but the user's existing
 * config.toml doesn't yet contain. returns the list of section names that
 * were added (empty array if nothing to do). callers can surface this to the
 * user as a one-time notice.
 *
 * never overwrites or reorders existing content. silently no-ops when the
 * file is absent (initConfig handles that case) or unreadable.
 */
export function migrateConfig(): string[] {
  if (!existsSync(CONFIG_PATH)) return []

  let text: string
  try {
    text = readFileSync(CONFIG_PATH, 'utf-8')
  } catch {
    return []
  }

  let parsed: Record<string, any>
  try {
    parsed = parseToml(text)
  } catch {
    return []
  }

  const missing = REQUIRED_TABLES.filter(t => !parsed[t.name])
  if (missing.length === 0) return []

  // append blocks at the bottom of the file. join with a leading newline so
  // we never collide with the previous section's last line, and trim any
  // trailing whitespace from the existing content first for a clean seam.
  const head = text.replace(/\s+$/, '')
  const appended = missing.map(t => t.block).join('\n')
  const next = head + '\n\n' + appended + '\n'
  try {
    writeFileSync(CONFIG_PATH, next, 'utf-8')
    return missing.map(t => t.name)
  } catch {
    return []
  }
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

    // key = "string value"
    const kvMatch = trimmed.match(/^(\w+)\s*=\s*"([^"]*)"$/)
    if (kvMatch) {
      currentSection[kvMatch[1]!] = kvMatch[2]!
      continue
    }

    // key = value (unquoted). strip inline comments, then coerce numeric forms
    // to number so callers don't have to Number() at every read site.
    const kvUnquoted = trimmed.match(/^(\w+)\s*=\s*(.+)$/)
    if (kvUnquoted) {
      const raw = kvUnquoted[2]!.replace(/\s+#.*$/, '').trim()
      if (/^-?\d+$/.test(raw)) {
        currentSection[kvUnquoted[1]!] = parseInt(raw, 10)
      } else if (/^-?\d+\.\d+$/.test(raw)) {
        currentSection[kvUnquoted[1]!] = parseFloat(raw)
      } else if (raw === 'true' || raw === 'false') {
        currentSection[kvUnquoted[1]!] = raw === 'true'
      } else {
        currentSection[kvUnquoted[1]!] = raw
      }
    }
  }

  return result
}
