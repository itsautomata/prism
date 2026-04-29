/**
 * safeFetch tests — pre-flight refusals only.
 *
 * scope: every check that fires *before* the network call. these are the
 * security-critical gates. testing the post-network branches (rebinding,
 * body cap, redirect chains) requires a controlled DNS server and is left
 * to integration tests; the unit-level guarantees here are:
 *
 *   1. invalid URLs throw (URL parser handles this)
 *   2. forbidden schemes throw before any DNS / connect
 *   3. forbidden ports throw before any DNS / connect
 *
 * the rebinding fix is correct *by construction* — got's `dnsLookup` option
 * is the same callback the socket layer uses. asserting that here without
 * mocking the entire DNS+socket stack would test our ability to mock, not
 * our ability to fetch.
 */

import { describe, it, expect } from 'vitest'
import { safeFetch } from '../safeFetch.js'
import { webPolicy, strictPolicy } from '../policy.js'
import {
  ForbiddenSchemeError,
  ForbiddenPortError,
} from '../errors.js'

describe('safeFetch (pre-flight)', () => {
  it('throws on invalid URL strings', async () => {
    await expect(safeFetch('not a url', webPolicy)).rejects.toThrow()
  })

  it('refuses non-http schemes', async () => {
    await expect(safeFetch('file:///etc/passwd', webPolicy)).rejects.toThrow(ForbiddenSchemeError)
    await expect(safeFetch('ftp://example.com/', webPolicy)).rejects.toThrow(ForbiddenSchemeError)
    await expect(safeFetch('data:text/plain,hi', webPolicy)).rejects.toThrow(ForbiddenSchemeError)
    await expect(safeFetch('javascript:alert(1)', webPolicy)).rejects.toThrow(ForbiddenSchemeError)
  })

  it('refuses ports outside the allowlist', async () => {
    await expect(safeFetch('http://example.com:22/', webPolicy)).rejects.toThrow(ForbiddenPortError)
    await expect(safeFetch('http://example.com:11434/', webPolicy)).rejects.toThrow(ForbiddenPortError)  // ollama
    await expect(safeFetch('http://example.com:3306/', webPolicy)).rejects.toThrow(ForbiddenPortError)   // mysql
  })

  it('strict policy rejects http (https-only)', async () => {
    await expect(safeFetch('http://example.com/', strictPolicy)).rejects.toThrow(ForbiddenSchemeError)
  })

  it('strict policy rejects port 80', async () => {
    await expect(safeFetch('https://example.com:80/', strictPolicy)).rejects.toThrow(ForbiddenPortError)
  })

  it('refusal carries the original URL on the error', async () => {
    try {
      await safeFetch('file:///etc/passwd', webPolicy)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenSchemeError)
      expect((e as ForbiddenSchemeError).url).toBe('file:///etc/passwd')
      expect((e as ForbiddenSchemeError).scheme).toBe('file:')
    }
  })
})
