/**
 * web-tree-sitter wrapper.
 *
 * the only module that talks to web-tree-sitter directly. handles:
 *   - one-time runtime init (Parser.init)
 *   - lazy + memoized grammar loading
 *   - locating the shipped wasm directory (dist/wasm in prod, wasm/build in dev)
 *   - parse + extract top-level symbols + imports from a source file
 *
 * keeps the model-controlled stuff out of this layer: file paths and source
 * strings come in, structured symbol data comes out. no tree-sitter types leak
 * to higher layers (callers consume {Symbol, FileSymbols} only).
 */

import { readFileSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { Parser, Language, type Node } from 'web-tree-sitter'
import { detectLanguage } from './languages.js'

export interface Symbol {
  /** grammar node kind (function_declaration, class_declaration, etc.). */
  kind: string
  /** symbol name (the value of the node's `name` field). */
  name: string
  /** 1-indexed line number. */
  line: number
  /** the first line of the declaration, truncated to 100 chars. */
  signature?: string
}

export interface FileSymbols {
  /** grammar name that parsed this file (e.g. "typescript"). */
  language: string
  /** top-level declarations found in the file. */
  symbols: Symbol[]
  /** module paths the file imports (e.g. "./utils.js", "react"). */
  imports: string[]
}

// memoized across the session
let initPromise: Promise<void> | null = null
const grammars = new Map<string, Language | null>()
let resolvedWasmDir: string | null = null

/**
 * find the shipped wasm directory. tries production layout first (next to the
 * bundled cli), then dev layout (wasm/build at repo root).
 */
function wasmDir(): string {
  if (resolvedWasmDir) return resolvedWasmDir
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'wasm'),                       // dist/cli.js → dist/wasm/ (bundled)
    join(here, '..', 'wasm', 'build'),        // src/retrieval/foo.ts → wasm/build (dev, tsx)
    join(here, '..', '..', 'wasm', 'build'),  // dist/cli.js fallback if dist/ is one level deeper
  ]
  for (const c of candidates) {
    if (existsSync(c)) {
      resolvedWasmDir = c
      return c
    }
  }
  throw new Error(
    `grammar wasm directory not found. checked: ${candidates.join(', ')}. ` +
    `run \`npm run build:wasms\` to build them, or \`npm run cp:wasms\` to copy from wasm/build to dist/wasm.`,
  )
}

async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init()
  return initPromise
}

async function loadGrammar(language: string): Promise<Language | null> {
  if (grammars.has(language)) return grammars.get(language)!
  await ensureInit()

  const path = join(wasmDir(), `tree-sitter-${language}.wasm`)
  if (!existsSync(path)) {
    grammars.set(language, null) // remember the miss so we don't recheck
    return null
  }
  try {
    const lang = await Language.load(readFileSync(path))
    grammars.set(language, lang)
    return lang
  } catch {
    grammars.set(language, null)
    return null
  }
}

/**
 * parse the file and extract top-level symbols and imports.
 * returns null when:
 *   - the file extension has no grammar mapping
 *   - the grammar wasm is missing or fails to load
 *   - the parse fails
 */
export async function extractSymbols(filePath: string, source: string): Promise<FileSymbols | null> {
  const language = detectLanguage(filePath)
  if (!language) return null

  const grammar = await loadGrammar(language)
  if (!grammar) return null

  const parser = new Parser()
  parser.setLanguage(grammar)
  const tree = parser.parse(source)
  if (!tree) {
    parser.delete()
    return null
  }

  const symbols: Symbol[] = []
  const imports: string[] = []
  const root = tree.rootNode

  collectFromNode(root, symbols, imports)

  tree.delete()
  parser.delete()

  return { language, symbols, imports }
}

/**
 * walk the direct children of the root and collect declarations + imports.
 * universal pattern: any top-level node with a `name` field is treated as a
 * declaration. this works across grammars without per-language queries because
 * tree-sitter grammars conventionally expose `name` on declaration nodes.
 *
 * also descends one level into export_statement (typescript/javascript) so
 * `export function foo() {}` surfaces foo, not just the export wrapper.
 */
function collectFromNode(root: Node, symbols: Symbol[], imports: string[]): void {
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)
    if (!child) continue
    pushSymbolIfNamed(child, symbols)
    pushImportIfImport(child, imports)
    if (child.type === 'export_statement') {
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j)
        if (inner) pushSymbolIfNamed(inner, symbols)
      }
    }
  }
}

function pushSymbolIfNamed(node: Node, symbols: Symbol[]): void {
  const nameNode = node.childForFieldName('name')
  if (!nameNode) return
  const firstLine = node.text.split('\n')[0] ?? ''
  symbols.push({
    kind: node.type,
    name: nameNode.text,
    line: node.startPosition.row + 1,
    signature: firstLine.length > 100 ? firstLine.slice(0, 100) + '...' : firstLine,
  })
}

function pushImportIfImport(node: Node, imports: string[]): void {
  // heuristic across grammars: anything with "import" in its kind, plus rust's `use_declaration`.
  if (!node.type.includes('import') && node.type !== 'use_declaration') return
  const src = findStringDescendant(node)
  if (src) imports.push(src)
}

function findStringDescendant(node: Node): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === 'string' || child.type === 'string_literal') {
      // strip surrounding quotes
      return child.text.replace(/^["'`]|["'`]$/g, '')
    }
    const nested = findStringDescendant(child)
    if (nested) return nested
  }
  return null
}
