import { describe, it, expect } from 'vitest'
import { validateScheme, validatePort, validateIp } from '../validate.js'
import {
  ForbiddenSchemeError,
  ForbiddenPortError,
  ForbiddenIpError,
} from '../errors.js'

const URL = 'http://example.com/'

describe('validateScheme', () => {
  const allowed = new Set(['http:', 'https:'])

  it('accepts allowed schemes', () => {
    expect(() => validateScheme(URL, 'http:', allowed)).not.toThrow()
    expect(() => validateScheme(URL, 'https:', allowed)).not.toThrow()
  })

  it('rejects unknown schemes', () => {
    expect(() => validateScheme(URL, 'ftp:', allowed)).toThrow(ForbiddenSchemeError)
    expect(() => validateScheme(URL, 'file:', allowed)).toThrow(ForbiddenSchemeError)
    expect(() => validateScheme(URL, 'data:', allowed)).toThrow(ForbiddenSchemeError)
    expect(() => validateScheme(URL, 'javascript:', allowed)).toThrow(ForbiddenSchemeError)
  })

  it('does not normalize case (URL.protocol already lowercased)', () => {
    // contract: scheme arrives lowercased from URL.protocol. an uppercase form
    // means the caller skipped the URL parser — we refuse.
    expect(() => validateScheme(URL, 'HTTP:', allowed)).toThrow(ForbiddenSchemeError)
  })
})

describe('validatePort', () => {
  const allowed = new Set([80, 443, 8080])

  it('accepts allowed numeric ports', () => {
    expect(() => validatePort(URL, '80', allowed)).not.toThrow()
    expect(() => validatePort(URL, '443', allowed)).not.toThrow()
    expect(() => validatePort(URL, '8080', allowed)).not.toThrow()
  })

  it('accepts the empty port (scheme default)', () => {
    expect(() => validatePort(URL, '', allowed)).not.toThrow()
  })

  it('rejects ports outside the set', () => {
    expect(() => validatePort(URL, '22', allowed)).toThrow(ForbiddenPortError)
    expect(() => validatePort(URL, '11434', allowed)).toThrow(ForbiddenPortError)  // ollama
    expect(() => validatePort(URL, '3306', allowed)).toThrow(ForbiddenPortError)   // mysql
  })

  it('rejects garbage port strings', () => {
    expect(() => validatePort(URL, 'abc', allowed)).toThrow(ForbiddenPortError)
  })
})

describe('validateIp', () => {
  const blocked = [
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

  it('accepts public ipv4', () => {
    expect(() => validateIp(URL, '1.1.1.1', blocked)).not.toThrow()
    expect(() => validateIp(URL, '8.8.8.8', blocked)).not.toThrow()
    expect(() => validateIp(URL, '93.184.216.34', blocked)).not.toThrow()  // example.com
  })

  it('rejects loopback v4', () => {
    expect(() => validateIp(URL, '127.0.0.1', blocked)).toThrow(ForbiddenIpError)
    expect(() => validateIp(URL, '127.255.255.254', blocked)).toThrow(ForbiddenIpError)
  })

  it('rejects rfc1918 private v4', () => {
    expect(() => validateIp(URL, '10.0.0.1', blocked)).toThrow(ForbiddenIpError)
    expect(() => validateIp(URL, '172.16.5.10', blocked)).toThrow(ForbiddenIpError)
    expect(() => validateIp(URL, '192.168.1.1', blocked)).toThrow(ForbiddenIpError)
  })

  it('rejects link-local v4 (incl. cloud metadata 169.254.169.254)', () => {
    expect(() => validateIp(URL, '169.254.0.1', blocked)).toThrow(ForbiddenIpError)
    expect(() => validateIp(URL, '169.254.169.254', blocked)).toThrow(ForbiddenIpError)
  })

  it('rejects v6 loopback', () => {
    expect(() => validateIp(URL, '::1', blocked)).toThrow(ForbiddenIpError)
  })

  it('rejects v6 unique-local (fc00::/7)', () => {
    expect(() => validateIp(URL, 'fc00::1', blocked)).toThrow(ForbiddenIpError)
    expect(() => validateIp(URL, 'fdff::1', blocked)).toThrow(ForbiddenIpError)
  })

  it('rejects v6 link-local (fe80::/10)', () => {
    expect(() => validateIp(URL, 'fe80::1', blocked)).toThrow(ForbiddenIpError)
  })

  it('unwraps IPv4-mapped IPv6 — the SSRF dodge by way of v6 form', () => {
    // ::ffff:127.0.0.1 is loopback. naive v4-only checks miss this.
    expect(() => validateIp(URL, '::ffff:127.0.0.1', blocked)).toThrow(ForbiddenIpError)
    expect(() => validateIp(URL, '::ffff:169.254.169.254', blocked)).toThrow(ForbiddenIpError)
    expect(() => validateIp(URL, '::ffff:10.0.0.1', blocked)).toThrow(ForbiddenIpError)
  })

  it('rejects malformed IP strings', () => {
    expect(() => validateIp(URL, 'not-an-ip', blocked)).toThrow(ForbiddenIpError)
    expect(() => validateIp(URL, '999.999.999.999', blocked)).toThrow(ForbiddenIpError)
    expect(() => validateIp(URL, '', blocked)).toThrow(ForbiddenIpError)
  })

  it('skips malformed CIDR entries in the policy without throwing', () => {
    // hardening against typos in policy config
    const broken = ['garbage', '999/8', '127.0.0.0/8']
    expect(() => validateIp(URL, '8.8.8.8', broken)).not.toThrow()
    expect(() => validateIp(URL, '127.0.0.1', broken)).toThrow(ForbiddenIpError)
  })

  it('cross-kind ranges do not match (v4 addr vs v6 range)', () => {
    expect(() => validateIp(URL, '8.8.8.8', ['fc00::/7'])).not.toThrow()
    expect(() => validateIp(URL, '2606:4700:4700::1111', ['10.0.0.0/8'])).not.toThrow()
  })

  it('preserves the original ip on the error for logging', () => {
    try {
      validateIp(URL, '127.0.0.1', blocked)
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenIpError)
      expect((e as ForbiddenIpError).ip).toBe('127.0.0.1')
      expect((e as ForbiddenIpError).url).toBe(URL)
    }
  })

  // regression: a public azure IP (52.x) was incorrectly reported as blocked
  // because safeFetch's pinning lookup received an array form from got and
  // passed it as `address` directly. the underlying validator must see strings;
  // arrays are an upstream-callsite bug. asserting here that public azure
  // ranges (at least the resolved sample that triggered the bug) pass the
  // validator cleanly when given a plain string.
  it('accepts public azure-range addresses as plain strings', () => {
    expect(() => validateIp(URL, '52.142.124.215', blocked)).not.toThrow()
    expect(() => validateIp(URL, '20.0.0.1', blocked)).not.toThrow()
  })
})
