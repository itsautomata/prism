/**
 * WebFetch — fetch a URL and return readable content.
 *
 * fetching, including all SSRF / scheme / port / size policy enforcement,
 * lives in src/net/safeFetch.ts. this file owns content extraction only:
 * HTML → markdown, JSON / text passthrough.
 */

import { z } from 'zod'
import * as cheerio from 'cheerio'
import TurndownService from 'turndown'
import { buildTool, type ToolResult } from './Tool.js'
import { safeFetch } from '../net/safeFetch.js'
import { webPolicy } from '../net/policy.js'
import { FetchError } from '../net/errors.js'

const inputSchema = z.object({
  url: z.string().url().describe('the URL to fetch (http or https)'),
})

type WebFetchInput = z.infer<typeof inputSchema>

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
})

const MAX_OUTPUT = 40_000

/**
 * pick the densest content container, then strip noise WITHIN it.
 * scoping the strip avoids gutting docs sites where <nav> holds the API
 * sidebar but we still want it (because the chosen container is <main>,
 * which doesn't include <nav>).
 */
function extractMarkdown(html: string): string {
  const $ = cheerio.load(html)
  $('script, style, noscript, iframe').remove()

  const $container = $('article').first().length ? $('article').first()
                  : $('main').first().length ? $('main').first()
                  : $('body')

  $container.find('nav, footer, aside, [role=navigation], [role=banner], [role=contentinfo]').remove()

  let md = turndown.turndown($container.html() || '')
  if (md.length > MAX_OUTPUT) {
    md = md.slice(0, MAX_OUTPUT) + '\n\n[... content truncated ...]'
  }
  return md
}

function truncate(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + '\n\n[... content truncated ...]' : s
}

export const WebFetchTool = buildTool<WebFetchInput>({
  name: 'WebFetch',
  description: 'fetch a URL and return its content. HTML is converted to markdown; JSON, XML, and text are returned as-is. blocks private/internal networks and non-http(s) schemes.',
  inputSchema,

  async call(input: WebFetchInput): Promise<ToolResult> {
    try {
      const { body, contentType } = await safeFetch(input.url, webPolicy)

      if (contentType.startsWith('text/html') || contentType.startsWith('application/xhtml+xml')) {
        return { content: extractMarkdown(body) }
      }
      // JSON, XML, plain text, markdown — return as-is, just cap length
      return { content: truncate(body) }
    } catch (err) {
      const e = err as Error
      // FetchError messages are already user-facing; raw network errors aren't.
      const msg = err instanceof FetchError ? e.message : `failed to fetch: ${e.message}`
      return { content: `error fetching ${input.url}: ${msg}`, isError: true }
    }
  },

  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  checkPermissions: () => ({ behavior: 'allow' }),
})
