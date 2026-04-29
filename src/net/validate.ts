/**
 * pure validators for URL components and resolved IPs.
 * no IO, no globals — every input is explicit. trivially unit-testable.
 */

import ipaddr from 'ipaddr.js'
import { ForbiddenSchemeError, ForbiddenPortError, ForbiddenIpError } from './errors.js'

/**
 * scheme arrives from URL.protocol which is always lowercase and includes the
 * trailing colon (`http:`, `https:`). policy stores the same form.
 */
export function validateScheme(url: string, scheme: string, allowed: ReadonlySet<string>): void {
  if (!allowed.has(scheme)) throw new ForbiddenSchemeError(url, scheme)
}

/**
 * empty port = caller did not specify, so the default for the scheme applies
 * (80/443). that's fine — the scheme allowlist already gated this. callers
 * who want to forbid the default must set scheme-specific policy.
 */
export function validatePort(url: string, port: string, allowed: ReadonlySet<number>): void {
  if (port === '') return
  const n = parseInt(port, 10)
  if (!Number.isFinite(n) || !allowed.has(n)) throw new ForbiddenPortError(url, port)
}

/**
 * reject if the resolved IP falls inside any blocked CIDR range.
 * unwraps IPv4-mapped IPv6 (`::ffff:127.0.0.1`) before matching, since attackers
 * routinely use the v6 form to dodge naïve v4-only checks.
 */
export function validateIp(url: string, ip: string, blockedRanges: readonly string[]): void {
  let addr: ipaddr.IPv4 | ipaddr.IPv6
  try {
    addr = ipaddr.parse(ip)
  } catch {
    throw new ForbiddenIpError(url, ip)
  }

  const isMappedV4 = addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()
  const checkAddr = isMappedV4 ? (addr as ipaddr.IPv6).toIPv4Address() : addr
  const checkKind = checkAddr.kind()

  for (const range of blockedRanges) {
    let cidr: ReturnType<typeof ipaddr.parseCIDR>
    try {
      cidr = ipaddr.parseCIDR(range)
    } catch {
      continue
    }
    if (cidr[0].kind() !== checkKind) continue
    // the kind-equality check above narrows enough at runtime; TS can't follow,
    // hence the cast. branches are exhaustive: kinds match → match() is valid.
    const isMatch = checkAddr.kind() === 'ipv4' 
      ? (checkAddr as ipaddr.IPv4).match(cidr as [ipaddr.IPv4, number])
      : (checkAddr as ipaddr.IPv6).match(cidr as [ipaddr.IPv6, number]);

    if (isMatch) {
      throw new ForbiddenIpError(url, ip);
    }
  }
}
