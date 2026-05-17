/**
 * end-to-end smoke: extract the repo-map from prism's own source, time it,
 * and show what lands in the system prompt.
 *
 * run with: npx tsx scripts/repomap-smoke.ts
 */

import { extractRepoMap, formatRepoMap } from '../src/retrieval/repomap.js'

async function main() {
  console.log('=== cold extract (cache miss) ===')
  const t0 = performance.now()
  const data = await extractRepoMap(process.cwd())
  const dt = (performance.now() - t0).toFixed(0)

  console.log(`time: ${dt}ms`)
  console.log(`files walked: ${data.filesWalked}`)
  console.log(`cache hits: ${data.cacheHits}`)
  console.log(`cache misses: ${data.cacheMisses}`)
  console.log(`parse failures: ${data.parseFailures}`)
  console.log(`entries (files with extractable symbols): ${data.entries.length}`)

  const totalSymbols = data.entries.reduce((acc, e) => acc + e.symbols.length, 0)
  console.log(`total symbols (post-cap): ${totalSymbols}`)

  console.log('\n=== warm extract (cache hit) ===')
  const t1 = performance.now()
  const data2 = await extractRepoMap(process.cwd())
  const dt2 = (performance.now() - t1).toFixed(0)
  console.log(`time: ${dt2}ms`)
  console.log(`cache hits: ${data2.cacheHits}`)
  console.log(`cache misses: ${data2.cacheMisses}`)

  console.log('\n=== formatted output (first 60 lines) ===')
  const formatted = formatRepoMap(data, { maxLines: 200 })
  const lines = formatted.split('\n')
  console.log(lines.slice(0, 60).join('\n'))
  console.log(`\n... (full output: ${lines.length} lines, ${formatted.length} chars, ~${Math.ceil(formatted.length / 4)} tokens)`)
}

main().catch(e => {
  console.error('error:', e)
  process.exit(1)
})
