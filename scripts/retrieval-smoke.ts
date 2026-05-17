/**
 * smoke test for web-tree-sitter + tree-sitter-wasms.
 * verifies: runtime initializes in node, grammar loads, parse works,
 * tree walking returns sensible structure on a real prism source file.
 *
 * run with: npx tsx scripts/retrieval-smoke.ts
 */

import { readFileSync } from 'fs'
import { resolve, join } from 'path'
import { Parser, Language, Query } from 'web-tree-sitter'

async function main() {
  console.log('=== web-tree-sitter init ===')
  const t0 = performance.now()
  await Parser.init()
  console.log(`Parser.init(): ${(performance.now() - t0).toFixed(2)}ms`)

  console.log('\n=== load typescript grammar ===')
  const wasmsDir = resolve(process.cwd(), 'wasm/build')
  const tsWasm = join(wasmsDir, 'tree-sitter-typescript.wasm')
  console.log(`grammar path: ${tsWasm}`)

  const t1 = performance.now()
  const langBytes = readFileSync(tsWasm)
  const lang = await Language.load(langBytes)
  console.log(`Language.load(): ${(performance.now() - t1).toFixed(2)}ms`)
  console.log(`language version: ${lang.version}, node count: ${lang.nodeTypeCount}`)

  const parser = new Parser()
  parser.setLanguage(lang)

  console.log('\n=== parse src/cli.ts ===')
  const cliPath = resolve(process.cwd(), 'src/cli.ts')
  const source = readFileSync(cliPath, 'utf-8')
  console.log(`source: ${cliPath} (${source.length} bytes)`)

  const t2 = performance.now()
  const tree = parser.parse(source)
  console.log(`parser.parse(): ${(performance.now() - t2).toFixed(2)}ms`)

  if (!tree) {
    console.error('parse returned null')
    return
  }
  const root = tree.rootNode
  console.log(`root kind: ${root.type}, child count: ${root.childCount}, has error: ${root.hasError}`)

  console.log('\n=== top-level declarations (first 20) ===')
  let count = 0
  for (let i = 0; i < root.childCount && count < 20; i++) {
    const child = root.child(i)
    if (!child) continue
    if (
      child.type === 'function_declaration' ||
      child.type === 'class_declaration' ||
      child.type === 'interface_declaration' ||
      child.type === 'type_alias_declaration' ||
      child.type === 'export_statement' ||
      child.type === 'import_statement' ||
      child.type === 'lexical_declaration'
    ) {
      const nameNode = child.childForFieldName('name')
      const name = nameNode?.text ?? '(unnamed)'
      const firstLine = child.text.split('\n')[0]!.slice(0, 80)
      console.log(`  [${child.type}] ${name} :: ${firstLine}`)
      count++
    }
  }

  console.log('\n=== query: extract all top-level functions and classes ===')
  // tree-sitter queries are the canonical extraction mechanism.
  // simple query: find every function_declaration and class_declaration.
  const Q = new Query(lang, `
    (function_declaration name: (identifier) @function.name) @function
    (class_declaration name: (type_identifier) @class.name) @class
    (export_statement
      (function_declaration name: (identifier) @export.function.name))
    (export_statement
      (class_declaration name: (type_identifier) @export.class.name))
  `)
  const captures = Q.captures(root)
  const names = captures
    .filter(c => c.name.endsWith('.name'))
    .map(c => ({ kind: c.name.replace(/\.name$/, ''), name: c.node.text }))
  console.log(`captured ${names.length} named items:`)
  for (const n of names.slice(0, 20)) {
    console.log(`  [${n.kind}] ${n.name}`)
  }

  console.log('\ndone.')
}

main().catch(e => {
  console.error('error:', e)
  process.exit(1)
})
