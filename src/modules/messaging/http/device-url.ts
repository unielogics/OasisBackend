// Where an SMS device may live. The server calls this address with the device's stored credentials, so it must not be
// usable to reach cloud metadata, link-local or (in production) local services, and the credentials must not follow the
// address to a new host without being entered again.
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

const NEVER = new BlockList()
NEVER.addSubnet('0.0.0.0', 8, 'ipv4')
NEVER.addSubnet('169.254.0.0', 16, 'ipv4') // link-local, including 169.254.169.254 (cloud metadata)
NEVER.addSubnet('224.0.0.0', 4, 'ipv4')
NEVER.addSubnet('240.0.0.0', 4, 'ipv4')
NEVER.addAddress('::', 'ipv6')
NEVER.addSubnet('fe80::', 10, 'ipv6')
NEVER.addSubnet('ff00::', 8, 'ipv6')
NEVER.addSubnet('fd00:ec2::', 32, 'ipv6') // AWS IPv6 metadata

const LOCAL = new BlockList()
LOCAL.addSubnet('127.0.0.0', 8, 'ipv4')
LOCAL.addAddress('::1', 'ipv6')

const METADATA_NAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
])
const LOOKUP_TIMEOUT_MS = 2000

type Resolver = (host: string) => Promise<string[]>

const resolveAll: Resolver = async (host) => {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), LOOKUP_TIMEOUT_MS).unref(),
  )
  const found = await Promise.race([lookup(host, { all: true }), timeout])
  return found.map((a) => a.address)
}

const familyOf = (ip: string): 'ipv4' | 'ipv6' => (isIP(ip) === 6 ? 'ipv6' : 'ipv4')

function blocked(ip: string, production: boolean): boolean {
  const family = familyOf(ip)
  return NEVER.check(ip, family) || (production && LOCAL.check(ip, family))
}

const HINT = 'Use the address the tablet has on your tailnet, for example http://100.64.0.7:8080.'

/** A message for the form when `raw` is not an acceptable device address, or null. Names are resolved once, so a name that points somewhere forbidden is refused too. */
export async function deviceUrlProblem(
  raw: string,
  env: { NODE_ENV: string },
  resolve: Resolver = resolveAll,
): Promise<string | null> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return `Enter a full address such as http://100.64.0.7:8080.`
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `Use an http:// or https:// address. ${HINT}`
  if (u.username || u.password)
    return 'Do not put the username or password in the address; use their own fields.'
  const production = env.NODE_ENV === 'production'
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const refuse = `That address points at a metadata service or a local network interface. ${HINT}`
  if (METADATA_NAMES.has(host)) return refuse
  if (production && (host === 'localhost' || host.endsWith('.localhost'))) return refuse
  if (isIP(host)) return blocked(host, production) ? refuse : null
  let addresses: string[]
  try {
    addresses = await resolve(host)
  } catch {
    return null // not resolvable from here (a MagicDNS name before the tailnet is up): nothing to call yet
  }
  return addresses.some((a) => blocked(a, production)) ? refuse : null
}

export const originOf = (raw: string): string | null => {
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}
