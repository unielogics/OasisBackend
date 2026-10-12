// The client address a per-address limit counts (W4c fixes): an IPv4 address as it is, an IPv4-mapped IPv6 address
// (::ffff:203.0.113.7) as its IPv4 address, and an IPv6 address by its /64 prefix ("2001:db8:1:2::/64"). One subscriber gets a whole
// /64 (2^64 addresses), so keyed by the full address every per-address limit would be unlimited for anyone on IPv6. Anything that is
// not an IP address (a test's made-up address) is returned unchanged.
import { isIP } from 'node:net'

/** The eight 16-bit groups of an IPv6 address (a zone id dropped, an embedded IPv4 tail expanded), or null when it is not one. */
function ipv6Groups(ip: string): number[] | null {
  let a = (ip.split('%')[0] ?? '').toLowerCase()
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a)
  if (v4) {
    const [b0, b1, b2, b3] = [v4[2], v4[3], v4[4], v4[5]].map(Number) as [number, number, number, number]
    a = `${v4[1]}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`
  }
  const halves = a.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return null
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  return groups.length === 8 && groups.every((n) => !Number.isNaN(n)) ? groups : null
}

/** The key of `ip` for a per-address limit: IPv4 as is, IPv6 by its /64. */
export function ipLimitKey(ip: string): string {
  if (isIP(ip) !== 6) return ip
  const g = ipv6Groups(ip)
  if (!g) return ip
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(':')}::/64`
}
