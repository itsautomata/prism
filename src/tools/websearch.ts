/**
 * WebSearch — query the duckduckgo HTML endpoint, extract the result list.
 * security inherited from safeFetch (scheme/port/IP/size policy + DNS pinning).
 * output is markdown (token-cheaper than JSON for an LLM consumer; ~30% lighter).
 */

import { z } from 'zod'
import * as cheerio from 'cheerio'
import { buildTool } from './Tool.js'
import { safeFetch, webPolicy } from '../net/safeFetch.js'

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
]

const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid']
const MAX_SNIPPET = 200

/**
 * unwrap DDG's `uddg=` redirect, force https on protocol-relative urls,
 * strip tracking params, and reject anything that isn't http(s).
 *
 * returns '' on any failure (malformed encoding, non-http scheme, unparseable);
 * caller treats empty as a signal to drop the result.
 *
 * uses URLSearchParams.get to decode `uddg`, which (unlike decodeURIComponent)
 * does not throw on malformed `%xx` sequences in DDG's responses.
 */
export function cleanDdgUrl(url: string): string {
  try {
    const absolute = url.startsWith('//') ? 'https:' + url
                  : url.startsWith('/')   ? 'https://duckduckgo.com' + url
                  : url
    const wrapper = new URL(absolute)
    const target = wrapper.searchParams.get('uddg') ?? wrapper.toString()
    const final = new URL(target)

    if (final.protocol !== 'http:' && final.protocol !== 'https:') return ''

    for (const p of TRACKING_PARAMS) final.searchParams.delete(p)
    return final.toString()
  } catch {
    return ''
  }
}

export function truncateSnippet(s: string): string {
  if (s.length <= MAX_SNIPPET) return s
  return s.slice(0, MAX_SNIPPET).trimEnd() + '…'
}

export interface SearchResult { title: string; url: string; snippet: string }

export function formatResults(results: SearchResult[]): string {
  return results
    .map((r, i) => `${i + 1}. **${r.title}** — ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    .join('\n\n')
}

export const WebSearchTool = buildTool({
  name: 'WebSearch',
  description: 'search the web for a query. returns a markdown list of titles, URLs, and snippets via duckduckgo.',
  inputSchema: z.object({
    query: z.string().describe('the search query'),
    limit: z.number().optional().default(10).describe('maximum number of results to return (default 10)'),
  }),

  call: async (input) => {
    try {
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`
      const randomUA = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!

      const response = await safeFetch(searchUrl, { ...webPolicy, userAgent: randomUA })

      const $ = cheerio.load(response.body)
      const seen = new Set<string>()
      const results: SearchResult[] = []
      const limit = input.limit ?? 10

      // primary + fallback selectors. DDG occasionally shifts class names,
      // so we cast a wider net. ads excluded explicitly via :not(.result--ad).
      const containers = $('.result:not(.result--ad), .links_main, .web-result')

      containers.each((_, el) => {
        if (results.length >= limit) return false  // stops the iteration

        const link = $(el).find('a.result__a, .result__title a, h2 a').first()
        const snippetEl = $(el).find('.result__snippet, .snippet, .result__snippet-container').first()

        const title = link.text().trim()
        const rawUrl = link.attr('href') || ''
        if (!title || !rawUrl) return

        const url = cleanDdgUrl(rawUrl)
        if (!url) return                            // unparseable / non-http / etc.
        if (seen.has(url)) return                   // dedupe
        if (url.includes('duckduckgo.com')) return  // internal links that survived cleaning

        seen.add(url)
        results.push({ title, url, snippet: truncateSnippet(snippetEl.text().trim()) })
      })

      if (results.length === 0) {
        // schema-drift signal: containers existed but our selectors found nothing
        const containersFound = $('.result').length
        const driftSignal = containersFound > 0
        const preview = $('body').text().slice(0, 100).replace(/\s+/g, ' ')
        return {
          content: driftSignal
            ? `no results parsed despite ${containersFound} .result containers — DDG layout may have shifted. preview: ${preview}…`
            : `no results found. preview: ${preview}…`,
          isError: driftSignal,
        }
      }

      return { content: formatResults(results) }
    } catch (e) {
      const err = e as Error
      return { content: `search error: ${err.message}`, isError: true }
    }
  },

  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  checkPermissions: () => ({ behavior: 'allow' }),
})
