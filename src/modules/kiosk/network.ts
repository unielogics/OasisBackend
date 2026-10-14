// "At the shop" means the shop's internet connection (ADR 0180 amendment, owner 2026-10-14). A PIN works only from an address in the
// shop's networks: an IPv4 address exactly (a /32), an IPv6 address by its /64 prefix (one subscriber's line gets a whole /64, and a
// device's own IPv6 address inside it changes for privacy).
//
// The caller's address is Fastify's `req.ip` and nothing else: TRUST_PROXY decides which hops may name the client (production: true =
// exactly one hop, nginx, which OVERWRITES X-Forwarded-For and X-Real-IP with $remote_addr; the API listens on 127.0.0.1 only, so
// nothing else can reach it; DNS points straight at the server, no CDN or load balancer). A forwarding header is never read here. An
// IPv4-mapped IPv6 address (::ffff:203.0.113.7, a dual-stack socket) counts as its IPv4 address.
import { isIP } from 'node:net'
import { ipLimitKey } from '../../platform/ip.js'

/** The caller's address as the server sees it: IPv4 as is, an IPv4-mapped IPv6 address as IPv4, IPv6 in lower case; null otherwise. */
export function callerAddress(ip: string | null | undefined): string | null {
  if (!ip) return null
  const bare = ip.trim().split('%')[0]!
  const family = isIP(bare)
  if (family === 4) return bare
  if (family !== 6) return null
  const key = ipLimitKey(bare)
  return isIP(key) === 4 ? key : bare.toLowerCase()
}

/**
 * The shop network an address belongs to, as a cidr: "203.0.113.7/32", or the IPv6 /64 "2001:db8:1:2::/64". Also accepts the forms
 * the refused list shows (an IPv4 address with /32, an IPv6 prefix with /64). Null for anything else.
 */
export function networkOf(input: string | null | undefined): string | null {
  if (!input) return null
  const raw = input.trim()
  const slash = raw.indexOf('/')
  const addr = callerAddress(slash < 0 ? raw : raw.slice(0, slash))
  if (!addr) return null
  const v4 = isIP(addr) === 4
  if (slash >= 0) {
    const bits = raw.slice(slash + 1)
    // an IPv4-mapped IPv6 network is not a thing we store; a prefix must be exactly the stored width
    if (bits !== (v4 ? '32' : '64') || (v4 && isIP(raw.slice(0, slash)) !== 4)) return null
  }
  return v4 ? `${addr}/32` : ipLimitKey(addr)
}

/** How a stored network shows: an IPv4 address without its /32, an IPv6 prefix with its /64. */
export function networkLabel(cidr: string): string {
  return cidr.endsWith('/32') ? cidr.slice(0, -3) : cidr
}
