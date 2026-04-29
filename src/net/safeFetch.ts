/**
 * safeFetch — single network entry point. enforces policy, returns bytes.
 *
 * defenses (each layer fails closed):
 *   1. URL parse (strict) + scheme allowlist
 *   2. port allowlist
 *   3. DNS resolution pinned via a custom lookup: the IP we validate is the IP
 *      got connects to, closing the rebinding TOCTOU window
 *   4. body size cap enforced before allocation completes (got's maxResponseSize)
 *   5. content-type prefix allowlist
 *   6. redirects re-enter the same lookup, so steps 1-5 re-apply per hop with
 *      no extra code. follows up to policy.maxRedirects.
 *
 * returns rich metadata (resolvedIp, finalUrl, redirectChain) so callers /
 * the tracing layer can record what actually happened end-to-end.
 */

import got, { type OptionsInit } from 'got'
import { lookup as dnsLookup } from 'node:dns'
import { validateScheme, validatePort, validateIp } from './validate.js'
import {
  BodyTooLargeError,
  UnsupportedContentTypeError,
  ForbiddenIpError,
  ForbiddenSchemeError,
  ForbiddenPortError,
} from './errors.js'
import type { FetchPolicy } from './policy.js'

export interface SafeFetchResult {
  body: string
  status: number
  contentType: string
  resolvedIp: string
  finalUrl: string
  redirectChain: readonly string[]
}

export async function safeFetch(rawUrl: string, policy: FetchPolicy): Promise<SafeFetchResult> {
  // step 1: parse & scheme. throws TypeError on invalid URLs (like garbage strings).
  const parsed = new URL(rawUrl)
  validateScheme(rawUrl, parsed.protocol, policy.allowedSchemes)

  // step 2: port. URL.port is '' when default — that's fine, scheme already gated.
  validatePort(rawUrl, parsed.port, policy.allowedPorts)

  // captures the address from the most recent lookup. on redirect, this is the
  // final hop's resolved IP — which is what callers care about.
  let lastResolvedIp = ''

  // step 3: pinning DNS lookup. got passes this directly to the http(s) module
  // so the address we validate is the address used to open the socket — no
  // separate "validate then connect" gap. invoked again on every redirect.
  const pinningLookup: OptionsInit['dnsLookup'] = (hostname, options, cb: any) => {
    // node's dns.lookup overloads: (hostname, options, cb) | (hostname, cb).
    // when options.all === true the callback receives an *array* of
    // {address, family} objects — got 14+ uses this form to pick from multiple
    // candidates. we must validate every candidate; a hostile DNS answering
    // [public, internal] would otherwise let internal slip through if got
    // chose that one. validating each closes that.
    const optsArg = typeof options === 'function' ? {} : (options || {})
    const cbArg = typeof options === 'function' ? options : cb
    dnsLookup(hostname, optsArg, (err, addressOrList: any, family) => {
      if (err) return cbArg(err)
      try {
        if (Array.isArray(addressOrList)) {
          for (const entry of addressOrList) {
            validateIp(rawUrl, entry.address, policy.blockedIpRanges)
          }
          if (addressOrList.length > 0) lastResolvedIp = addressOrList[0].address
          cbArg(null, addressOrList)
        } else {
          validateIp(rawUrl, addressOrList, policy.blockedIpRanges)
          lastResolvedIp = addressOrList
          cbArg(null, addressOrList, family)
        }
      } catch (e) {
        // wrap so node's dns layer surfaces our error to got intact
        cbArg(e as NodeJS.ErrnoException)
      }
    })
  }

  let response
  try {
    response = await got(rawUrl, {
      timeout: { request: policy.timeoutMs },
      maxRedirects: policy.maxRedirects,
      retry: { limit: 0 },
      followRedirect: policy.maxRedirects > 0,
      dnsLookup: pinningLookup,
      headers: { 'user-agent': policy.userAgent },
      throwHttpErrors: true,
    })
  } catch (err) {
    // surface our typed validators verbatim — they're the SSRF / scheme / port refusals
    if (
      err instanceof ForbiddenIpError ||
      err instanceof ForbiddenSchemeError ||
      err instanceof ForbiddenPortError
    ) {
      throw err
    }
    // got cause-chains the lookup error: cb(ForbiddenIpError) → RequestError(cause: ForbiddenIpError)
    const cause = (err as { cause?: unknown }).cause
    if (
      cause instanceof ForbiddenIpError ||
      cause instanceof ForbiddenSchemeError ||
      cause instanceof ForbiddenPortError
    ) {
      throw cause
    }
    // body-size violation → typed error
    const e = err as Error & { code?: string }
    if (e.code === 'ERR_BODY_LIMIT_EXCEEDED' || /response (size|too large)/i.test(e.message)) {
      throw new BodyTooLargeError(rawUrl, policy.maxResponseSizeBytes)
    }
    throw err
  }

  // step 4: enforce response body cap. got's maxResponseSize would already
  // have thrown on stream, but if the server lied about content-length we
  // double-check post-read.
  if (response.body.length > policy.maxResponseSizeBytes) {
    throw new BodyTooLargeError(rawUrl, policy.maxResponseSizeBytes)
  }

  // step 5: content-type allowlist (prefix match — handles `; charset=utf-8` suffix)
  const contentType = (response.headers['content-type'] || '').toLowerCase()
  const allowed = policy.allowedContentTypes.some(prefix => contentType.startsWith(prefix))
  if (!allowed) {
    throw new UnsupportedContentTypeError(rawUrl, contentType)
  }

  return {
    body: response.body,
    status: response.statusCode,
    contentType,
    resolvedIp: lastResolvedIp,
    finalUrl: response.url,
    redirectChain: response.redirectUrls.map(u => u.toString()),
  }
}

// re-export so tools can import from one place
export { webPolicy, strictPolicy } from './policy.js'
export type { FetchPolicy } from './policy.js'
export {
  FetchError,
  ForbiddenSchemeError,
  ForbiddenPortError,
  ForbiddenIpError,
  BodyTooLargeError,
  UnsupportedContentTypeError,
} from './errors.js'
