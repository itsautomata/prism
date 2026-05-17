/**
 * file path → tree-sitter language name.
 *
 * the language name matches the wasm filename in `dist/wasm/tree-sitter-<name>.wasm`
 * (or `wasm/build/` in dev). the manifest at `wasm/manifest.json` is the source
 * of truth for which grammars ship; this map decides which extension dispatches
 * to which grammar.
 *
 * separate from `src/context/scanner.ts`'s LANG_MAP (which classifies project
 * language for the scan): scanner is for human-readable labels, this is for
 * grammar lookup.
 */

import { extname, basename } from 'path'

const EXT_MAP: Record<string, string> = {
  // typescript / javascript
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  // scripting
  '.py': 'python', '.pyw': 'python', '.pyx': 'python',
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.r': 'r', '.R': 'r',
  '.jl': 'julia',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
  // systems
  '.c': 'c', '.h': 'c',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.rs': 'rust',
  '.go': 'go',
  '.zig': 'zig',
  // jvm
  '.java': 'java',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.scala': 'scala',
  '.clj': 'clojure', '.cljs': 'clojure', '.cljc': 'clojure',
  // dotnet
  '.cs': 'c-sharp',
  // mobile
  '.swift': 'swift',
  '.dart': 'dart',
  // functional
  '.hs': 'haskell',
  '.ex': 'elixir', '.exs': 'elixir',
  '.erl': 'erlang', '.hrl': 'erlang',
  '.ml': 'ocaml', '.mli': 'ocaml',
  // markup / data
  '.html': 'html', '.htm': 'html',
  '.css': 'css',
  '.json': 'json',
  '.toml': 'toml',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.md': 'markdown', '.mdx': 'markdown',
  '.sql': 'sql',
  '.graphql': 'graphql', '.gql': 'graphql',
  '.svelte': 'svelte',
}

const FILENAME_MAP: Record<string, string> = {
  'Dockerfile': 'dockerfile',
  'Containerfile': 'dockerfile',
  'Makefile': 'make',
  'makefile': 'make',
  'GNUmakefile': 'make',
}

/**
 * resolve a file path to its tree-sitter grammar name, or null when no grammar
 * is shipped for the file. callers treat null as "skip retrieval for this file."
 */
export function detectLanguage(filePath: string): string | null {
  const base = basename(filePath)
  if (FILENAME_MAP[base]) return FILENAME_MAP[base]!
  const ext = extname(filePath).toLowerCase()
  return EXT_MAP[ext] ?? null
}

/**
 * return the set of grammar names this map can dispatch to. callers that need
 * to filter the shipped wasm directory against this list use this set.
 */
export function knownLanguages(): ReadonlySet<string> {
  return new Set<string>([...Object.values(EXT_MAP), ...Object.values(FILENAME_MAP)])
}
