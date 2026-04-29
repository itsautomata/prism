/**
 * policy presets for safeFetch.
 * policy is data, not branching code: tools pick a preset (or override one),
 * safeFetch enforces it.
 */

export interface FetchPolicy {
  allowedSchemes: ReadonlySet<string>
  allowedPorts: ReadonlySet<number>
  allowedContentTypes: readonly string[]   // matched by prefix
  blockedIpRanges: readonly string[]
  maxResponseSizeBytes: number
  maxRedirects: number
  timeoutMs: number
  userAgent: string
}

/**
 * universally blocked CIDR ranges. v4 + v6 + mappings:
 * - 127.0.0.0/8     loopback v4
 * - 10/8, 172.16/12, 192.168/16  RFC1918 private v4
 * - 169.254/16      link-local v4 (incl. AWS/GCP metadata 169.254.169.254)
 * - 0.0.0.0/8       this-network / self
 * - ::1/128         loopback v6
 * - fc00::/7        unique-local v6 (RFC 4193)
 * - fe80::/10       link-local v6
 */
const COMMON_BLOCKED_RANGES: readonly string[] = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '0.0.0.0/8',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
]

/**
 * default policy for the WebFetch tool. open enough to read mainstream sites
 * (http+https, common ports, common text content types), tight enough to
 * refuse SSRF / oversized bodies / unknown schemes.
 */
export const webPolicy: FetchPolicy = {
  allowedSchemes: new Set(['http:', 'https:']),
  allowedPorts: new Set([80, 443, 8080, 8000]),
  allowedContentTypes: [
    'text/html',
    'application/xhtml+xml',
    'application/json',
    'application/ld+json',
    'application/xml',
    'text/xml',
    'text/plain',
    'text/markdown',
  ],
  blockedIpRanges: COMMON_BLOCKED_RANGES,
  maxResponseSizeBytes: 5_000_000,
  maxRedirects: 5,
  timeoutMs: 10_000,
  userAgent: 'Prism/0.1 (CLI assistant; +https://github.com/prism-ai/prism)',
}

/**
 * stricter preset for high-trust contexts (e.g. fetching documents the model
 * explicitly proposes). https-only, no redirects, smaller body cap.
 */
export const strictPolicy: FetchPolicy = {
  ...webPolicy,
  allowedSchemes: new Set(['https:']),
  allowedPorts: new Set([443]),
  maxRedirects: 0,
  maxResponseSizeBytes: 1_000_000,
}
