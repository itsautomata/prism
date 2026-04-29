/**
 * WebSearch tests.
 *
 * pure helpers tested directly (cleanDdgUrl, truncateSnippet, formatResults).
 * the tool's call() is tested with `safeFetch` mocked, fed sample DDG HTML —
 * no real network. covers: extraction, dedupe, limit, non-http filter,
 * schema-drift detection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock safeFetch BEFORE importing the tool, so the import binds to the mock.
// each test sets the next return value via mockResolvedValueOnce.
vi.mock('../../net/safeFetch.js', () => ({
  safeFetch: vi.fn(),
  webPolicy: {
    allowedSchemes: new Set(['http:', 'https:']),
    allowedPorts: new Set([80, 443]),
    allowedContentTypes: ['text/html'],
    blockedIpRanges: [],
    maxResponseSizeBytes: 5_000_000,
    maxRedirects: 5,
    timeoutMs: 10_000,
    userAgent: 'test',
  },
}))

import { safeFetch } from '../../net/safeFetch.js'
import {
  WebSearchTool,
  cleanDdgUrl,
  truncateSnippet,
  formatResults,
  type SearchResult,
} from '../websearch.js'

const mockedFetch = vi.mocked(safeFetch)

beforeEach(() => {
  mockedFetch.mockReset()
})

// helper: build a minimal DDG-shaped HTML for N results
function ddgHtml(rows: { title: string; href: string; snippet: string }[]): string {
  const items = rows.map(r => `
    <div class="result">
      <h2 class="result__title">
        <a class="result__a" href="${r.href}">${r.title}</a>
      </h2>
      <a class="result__snippet">${r.snippet}</a>
    </div>
  `).join('')
  return `<html><body>${items}</body></html>`
}

function fetchReturning(html: string) {
  mockedFetch.mockResolvedValueOnce({
    body: html,
    status: 200,
    contentType: 'text/html',
    resolvedIp: '52.0.0.1',
    finalUrl: 'https://html.duckduckgo.com/html/?q=test',
    redirectChain: [],
  })
}

describe('cleanDdgUrl', () => {
  it('passes a normal https URL through', () => {
    expect(cleanDdgUrl('https://example.com/path')).toBe('https://example.com/path')
  })

  it('forces https on protocol-relative URLs', () => {
    expect(cleanDdgUrl('//example.com/path')).toBe('https://example.com/path')
  })

  it('unwraps DDG uddg= redirect', () => {
    const wrapped = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle&rut=abc'
    expect(cleanDdgUrl(wrapped)).toBe('https://example.com/article')
  })

  it('handles relative DDG redirect path', () => {
    const wrapped = '/l/?uddg=https%3A%2F%2Fexample.com%2Farticle'
    expect(cleanDdgUrl(wrapped)).toBe('https://example.com/article')
  })

  it('strips utm_* and fbclid tracking params', () => {
    const url = 'https://example.com/x?utm_source=ddg&utm_medium=web&fbclid=abc&kept=1'
    expect(cleanDdgUrl(url)).toBe('https://example.com/x?kept=1')
  })

  it('rejects javascript: scheme inside uddg', () => {
    // attacker-injected payload via DDG schema drift / hostile result row
    const wrapped = '//duckduckgo.com/l/?uddg=javascript%3Aalert(1)'
    expect(cleanDdgUrl(wrapped)).toBe('')
  })

  it('rejects file: scheme inside uddg', () => {
    const wrapped = '//duckduckgo.com/l/?uddg=file%3A%2F%2F%2Fetc%2Fpasswd'
    expect(cleanDdgUrl(wrapped)).toBe('')
  })

  it('rejects data: scheme inside uddg', () => {
    const wrapped = '//duckduckgo.com/l/?uddg=data%3Atext%2Fhtml%2C%3Cscript%3E1%3C%2Fscript%3E'
    expect(cleanDdgUrl(wrapped)).toBe('')
  })

  it('returns empty on completely unparseable input', () => {
    expect(cleanDdgUrl('not a url at all')).toBe('')
  })

  it('does not throw on malformed % encoding (would crash decodeURIComponent)', () => {
    // decodeURIComponent throws URIError on lone % chars; URLSearchParams.get does not.
    // regression guard: prior implementation used decodeURIComponent and broke.
    expect(() => cleanDdgUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F%')).not.toThrow()
  })
})

describe('truncateSnippet', () => {
  it('passes short snippets through', () => {
    expect(truncateSnippet('hello')).toBe('hello')
  })

  it('truncates at 200 chars with an ellipsis', () => {
    const long = 'a'.repeat(300)
    const out = truncateSnippet(long)
    expect(out.length).toBeLessThanOrEqual(201)
    expect(out.endsWith('…')).toBe(true)
  })

  it('handles empty string', () => {
    expect(truncateSnippet('')).toBe('')
  })
})

describe('formatResults', () => {
  it('renders a numbered markdown list with bold titles', () => {
    const r: SearchResult[] = [
      { title: 'First', url: 'https://a.com', snippet: 'snip1' },
      { title: 'Second', url: 'https://b.com', snippet: 'snip2' },
    ]
    const out = formatResults(r)
    expect(out).toBe(
      '1. **First** — https://a.com\n   snip1\n\n' +
      '2. **Second** — https://b.com\n   snip2'
    )
  })

  it('omits the snippet line when snippet is empty', () => {
    const r: SearchResult[] = [{ title: 'T', url: 'https://a.com', snippet: '' }]
    expect(formatResults(r)).toBe('1. **T** — https://a.com')
  })

  it('returns empty string for empty input', () => {
    expect(formatResults([])).toBe('')
  })
})

describe('WebSearchTool.call', () => {
  it('extracts and returns markdown for normal DDG html', async () => {
    fetchReturning(ddgHtml([
      { title: 'Result A', href: 'https://a.com', snippet: 'first snippet' },
      { title: 'Result B', href: 'https://b.com', snippet: 'second snippet' },
    ]))

    const result = await WebSearchTool.call({ query: 'foo', limit: 10 }, { cwd: '/' })

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('1. **Result A** — https://a.com')
    expect(result.content).toContain('2. **Result B** — https://b.com')
    expect(result.content).toContain('first snippet')
  })

  it('respects the limit parameter', async () => {
    fetchReturning(ddgHtml([
      { title: 'A', href: 'https://a.com', snippet: '' },
      { title: 'B', href: 'https://b.com', snippet: '' },
      { title: 'C', href: 'https://c.com', snippet: '' },
      { title: 'D', href: 'https://d.com', snippet: '' },
    ]))

    const result = await WebSearchTool.call({ query: 'foo', limit: 2 }, { cwd: '/' })

    expect(result.content).toContain('1. **A**')
    expect(result.content).toContain('2. **B**')
    expect(result.content).not.toContain('**C**')
    expect(result.content).not.toContain('**D**')
  })

  it('dedupes results that point to the same URL', async () => {
    fetchReturning(ddgHtml([
      { title: 'First copy', href: 'https://a.com/x', snippet: 's1' },
      { title: 'Second copy', href: 'https://a.com/x', snippet: 's2' },
      { title: 'Different', href: 'https://b.com', snippet: 's3' },
    ]))

    const result = await WebSearchTool.call({ query: 'foo', limit: 10 }, { cwd: '/' })

    // 'First copy' wins (encountered first); 'Second copy' dropped; 'Different' kept.
    expect(result.content).toContain('First copy')
    expect(result.content).not.toContain('Second copy')
    expect(result.content).toContain('Different')
  })

  it('drops results whose URL is not http(s)', async () => {
    // simulate hostile/schema-drift response: title looks legit but href is js:
    fetchReturning(ddgHtml([
      { title: 'Bad', href: '//duckduckgo.com/l/?uddg=javascript%3Aalert(1)', snippet: '' },
      { title: 'Good', href: 'https://example.com', snippet: 'ok' },
    ]))

    const result = await WebSearchTool.call({ query: 'foo', limit: 10 }, { cwd: '/' })

    expect(result.content).not.toContain('Bad')
    expect(result.content).toContain('Good')
  })

  it('signals schema drift when .result containers exist but nothing extracts', async () => {
    // selectors miss because the inner classes have shifted
    const drifted = `<html><body>
      <div class="result">
        <h3 class="renamed-title"><a href="https://x.com">title</a></h3>
      </div>
    </body></html>`
    fetchReturning(drifted)

    const result = await WebSearchTool.call({ query: 'foo', limit: 10 }, { cwd: '/' })

    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/layout may have shifted/)
  })

  it('returns plain "no results" when no .result containers exist at all', async () => {
    fetchReturning('<html><body>nothing here</body></html>')

    const result = await WebSearchTool.call({ query: 'foo', limit: 10 }, { cwd: '/' })

    expect(result.isError).toBeFalsy()
    expect(result.content).toMatch(/no results found/)
  })

  it('passes a rotating user-agent into safeFetch (regression for v2 dead-code bug)', async () => {
    fetchReturning(ddgHtml([{ title: 'X', href: 'https://x.com', snippet: '' }]))

    await WebSearchTool.call({ query: 'foo', limit: 10 }, { cwd: '/' })

    expect(mockedFetch).toHaveBeenCalledOnce()
    const policyArg = mockedFetch.mock.calls[0]![1]
    expect(policyArg.userAgent).toMatch(/Mozilla\/5\.0/)  // not the default Prism/0.1 UA
  })

  it('reports safeFetch errors as tool errors', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('connection refused'))

    const result = await WebSearchTool.call({ query: 'foo', limit: 10 }, { cwd: '/' })

    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/connection refused/)
  })
})
