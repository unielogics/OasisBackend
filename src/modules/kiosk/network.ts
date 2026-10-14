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

/** How long a request's address -> shop network answer is reused (removing a network stops kiosk use from it within this). */
export const KIOSK_NETWORK_CACHE_MS = 30 * 1000
/** A shop network's last_seen_at is rewritten at most this often per process. */
export const KIOSK_NETWORK_SEEN_MS = 5 * 60 * 1000
const CACHE_MAX = 1000

export interface NetworkMatch {
  /** The kiosk_networks row the address belongs to, or null. */
  id: string | null
  /** The location has at least one shop network. */
  networkSet: boolean
}

/**
 * In-memory answers to "is this address a shop network?" for kiosk-session requests (ADR 0180 amendment A13), reused for 30 seconds;
 * an add, remove or approve in this process forgets them all at once. Bounded: past 1,000 addresses the expired, then the oldest, go.
 * Also the per-process throttle of a network's last_seen_at writes.
 */
export class KioskNetworkCache {
  private matches = new Map<string, { at: number; match: NetworkMatch }>()
  private seen = new Map<string, number>()

  constructor(private readonly now: () => number) {}

  get(locationId: string, address: string): NetworkMatch | null {
    const key = `${locationId}|${address}`
    const e = this.matches.get(key)
    if (!e) return null
    if (this.now() - e.at >= KIOSK_NETWORK_CACHE_MS) {
      this.matches.delete(key)
      return null
    }
    return e.match
  }

  set(locationId: string, address: string, match: NetworkMatch): void {
    const key = `${locationId}|${address}`
    const now = this.now()
    this.matches.delete(key)
    this.matches.set(key, { at: now, match })
    if (this.matches.size <= CACHE_MAX) return
    for (const [k, v] of this.matches) if (now - v.at >= KIOSK_NETWORK_CACHE_MS) this.matches.delete(k)
    for (const k of this.matches.keys()) {
      if (this.matches.size <= CACHE_MAX) break
      this.matches.delete(k)
    }
  }

  /** A network was added, removed or approved: every answer is asked again. */
  forget(): void {
    this.matches.clear()
  }

  /** True when the network's last_seen_at should be written now (at most once in 5 minutes per network); marks it written. */
  shouldMarkSeen(networkId: string): boolean {
    const now = this.now()
    const last = this.seen.get(networkId)
    if (last !== undefined && now - last < KIOSK_NETWORK_SEEN_MS) return false
    this.markedSeen(networkId)
    return true
  }

  /** The network's last_seen_at was just written (an unlock writes it in its own transaction). */
  markedSeen(networkId: string): void {
    this.seen.delete(networkId)
    this.seen.set(networkId, this.now())
    if (this.seen.size > CACHE_MAX) for (const k of this.seen.keys()) if (this.seen.size > CACHE_MAX) this.seen.delete(k)
  }

  reset(): void {
    this.matches.clear()
    this.seen.clear()
  }
}
