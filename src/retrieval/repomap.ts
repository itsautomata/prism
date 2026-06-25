/**
 * repo-map orchestration: walk the project, extract symbols (with cache),
 * format a markdown block for the system prompt.
 *
 * the tier-A "structural floor" the model sees on every turn. answers:
 *   - what files are in this project?
 *   - what are the load-bearing declarations in each?
 *
 * extracts and formats are split: callers that want raw data (UI, debugging)
 * call extractRepoMap; the prompt builder calls formatRepoMap on top.
 */

import { existsSync, readdirSync, statSync, lstatSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import { detectLanguage, knownLanguages } from './languages.js'
import { extractSymbols, type Symbol } from './treesitter.js'
import { getCached, setCached } from './cache.js'
import { getProjectId } from '../memory/memo.js'
import { loadConfig } from '../config/config.js'

// duplicated from src/context/scanner.ts on purpose: kept local so the
// retrieval layer doesn't pull a circular dep through the scanner module.
// keep in sync when scanner's list changes.
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'env',
  '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  'dist', 'build', 'out', 'target', '_build',
  '.next', '.nuxt', '.svelte-kit', '.astro',
  '.cache', '.parcel-cache', '.turbo',
  'vendor', 'deps', '_deps',
  'coverage', '.nyc_output',
  '.idea', '.vscode', '.fleet',
  // prism build artifact: wasm/sources/ holds cloned grammar repos (zig,
  // python, etc.); wasm/build/ holds the compiled wasms. neither is "the
  // project," both confuse the repo-map with generated parser code.
  'wasm',
])

export interface RepoMapEntry {
  /** path relative to cwd. */
  path: string
  language: string
  /** capped per file via opts.maxSymbolsPerFile. */
  symbols: Symbol[]
}

export interface RepoMapData {
  cwd: string
  entries: RepoMapEntry[]
  /** files walked (eligible for parse, may be > entries.length when maxFiles caps). */
  filesWalked: number
  cacheHits: number
  cacheMisses: number
  /** files skipped because parse / load failed. */
  parseFailures: number
}

export interface RepoMapOptions {
  /** hard cap on files to parse. default 500. */
  maxFiles?: number
  /** symbols per file in the output. default 10. */
  maxSymbolsPerFile?: number
  /** additional directories to skip beyond the built-in IGNORE_DIRS. */
  extraIgnore?: ReadonlySet<string>
}

/**
 * walk the project tree and produce a structural map keyed by file.
 * uses the symbol cache, parses on miss, writes back. ignores files whose
 * extension has no grammar, plus the standard build/cache directories.
 *
 * caller-supplied `opts` win; missing values fall back to `config.tuning`.
 * CLI plumbing (cli.ts) injects opts when --max-files / --max-lines are set.
 */
export async function extractRepoMap(cwd: string, opts: RepoMapOptions = {}): Promise<RepoMapData> {
  const { tuning } = loadConfig()
  const maxFiles = opts.maxFiles ?? tuning.repomap_max_files
  const maxSymbolsPerFile = opts.maxSymbolsPerFile ?? tuning.repomap_max_symbols_per_file
  const ignore = new Set([...IGNORE_DIRS, ...(opts.extraIgnore ?? [])])

  const supported = knownLanguages()
  const candidates = walkProject(cwd, ignore, supported, maxFiles)
  const projectId = getProjectId(cwd)

  const entries: RepoMapEntry[] = []
  let cacheHits = 0
  let cacheMisses = 0
  let parseFailures = 0

  for (const filePath of candidates) {
    let mtime = 0
    let size = 0
    try {
      const st = statSync(filePath)
      mtime = st.mtimeMs
      size = st.size
    } catch {
      continue
    }

    const cached = getCached(projectId, filePath, mtime, size)
    if (cached) {
      cacheHits += 1
      if (cached.symbols.length > 0) {
        entries.push({
          path: relative(cwd, filePath),
          language: cached.language,
          symbols: cached.symbols.slice(0, maxSymbolsPerFile),
        })
      }
      continue
    }

    cacheMisses += 1
    let source: string
    try {
      source = readFileSync(filePath, 'utf-8')
    } catch {
      parseFailures += 1
      continue
    }

    const result = await extractSymbols(filePath, source)
    if (!result) {
      parseFailures += 1
      continue
    }

    setCached(projectId, filePath, {
      mtime,
      size,
      language: result.language,
      symbols: result.symbols,
      imports: result.imports,
    })

    if (result.symbols.length > 0) {
      entries.push({
        path: relative(cwd, filePath),
        language: result.language,
        symbols: result.symbols.slice(0, maxSymbolsPerFile),
      })
    }
  }

  return {
    cwd,
    entries,
    filesWalked: candidates.length,
    cacheHits,
    cacheMisses,
    parseFailures,
  }
}

/**
 * render the repo-map data as a markdown block for the system prompt.
 * caller decides where it lands; this only produces the text.
 *
 * if the formatted block exceeds maxLines, trims from the bottom and appends
 * a "...and N more files" footer so the size stays bounded.
 */
export function formatRepoMap(data: RepoMapData, opts: { maxLines?: number } = {}): string {
  const maxLines = opts.maxLines ?? loadConfig().tuning.repomap_max_lines
  if (data.entries.length === 0) return ''

  const lines: string[] = ['# repo map', '']
  let truncated = 0

  for (let i = 0; i < data.entries.length; i++) {
    const entry = data.entries[i]!
    const block: string[] = [entry.path]
    for (const sym of entry.symbols) {
      // kind is grammar-specific (e.g. "function_declaration"); strip _declaration
      // suffix for legibility, default to the raw kind otherwise.
      const kind = sym.kind.replace(/_declaration$|_definition$/, '')
      block.push(`  ${kind} ${sym.name}`)
    }

    // budget check: total lines (existing + this entry + blank separator)
    if (lines.length + block.length + 1 > maxLines) {
      truncated = data.entries.length - i
      break
    }

    lines.push(...block)
    lines.push('')
  }

  if (truncated > 0) {
    lines.push(`...and ${truncated} more files (call Read or Grep to inspect)`)
  }

  return lines.join('\n').trimEnd()
}

/**
 * walk cwd recursively; collect file paths whose extension dispatches to a
 * known grammar. stops walking under IGNORE_DIRS and any dir starting with `.`.
 * caps total file count at `maxFiles` to bound the cost on very large repos.
 */
function walkProject(
  cwd: string,
  ignore: ReadonlySet<string>,
  supportedLangs: ReadonlySet<string>,
  maxFiles: number,
): string[] {
  const results: string[] = []
  const stack: string[] = [cwd]

  while (stack.length > 0 && results.length < maxFiles) {
    const dir = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }

    for (const name of entries) {
      if (ignore.has(name)) continue
      // hidden directories at every level (e.g. .git, .cache, .prism)
      if (name.startsWith('.')) continue

      const path = join(dir, name)
      // lstat (not stat) so symlinks aren't followed. a symlink to `~/` or any
      // outside-the-repo target would otherwise drag thousands of files into
      // the walk and blow past the file cap on real projects.
      let s
      try { s = lstatSync(path) } catch { continue }

      if (s.isSymbolicLink()) continue
      if (s.isDirectory()) {
        stack.push(path)
      } else if (s.isFile()) {
        const lang = detectLanguage(name)
        if (lang && supportedLangs.has(lang)) {
          results.push(path)
          if (results.length >= maxFiles) break
        }
      }
    }
  }

  return results
}
