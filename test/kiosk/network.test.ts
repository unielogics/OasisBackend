// "At the shop" is the shop's internet connection (ADR 0180 amendment): the caller's address (req.ip through TRUST_PROXY; an
// IPv4-mapped IPv6 address as IPv4) and the shop network it belongs to (IPv4 exactly, IPv6 by its /64).
import { describe, expect, it } from 'vitest'
import {
  callerAddress,
  KIOSK_NETWORK_CACHE_MS,
  KIOSK_NETWORK_SEEN_MS,
  KioskNetworkCache,
  networkLabel,
  networkOf,
} from '../../src/modules/kiosk/network.js'
import { browserSummary } from '../../src/modules/kiosk/service.js'

describe('callerAddress', () => {
  it('keeps IPv4, turns an IPv4-mapped IPv6 address into IPv4, lower-cases IPv6, refuses anything else', () => {
    expect(callerAddress('203.0.113.9')).toBe('203.0.113.9')
    expect(callerAddress('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(callerAddress('::FFFF:cb00:7109')).toBe('203.0.113.9')
    expect(callerAddress('2001:DB8:1:2::abcd')).toBe('2001:db8:1:2::abcd')
    expect(callerAddress('fe80::1%eth0')).toBe('fe80::1')
    for (const bad of [null, undefined, '', 'unknown', '203.0.113', '1.2.3.4:80', 'example.test']) expect(callerAddress(bad)).toBeNull()
  })
})

describe('networkOf', () => {
  it('an IPv4 address is its own /32; an IPv4-mapped one too', () => {
    expect(networkOf('203.0.113.9')).toBe('203.0.113.9/32')
    expect(networkOf('::ffff:203.0.113.9')).toBe('203.0.113.9/32')
    expect(networkOf('203.0.113.9/32')).toBe('203.0.113.9/32')
  })

  it('an IPv6 address is its /64: two addresses of one line are one network, another /64 is not', () => {
    const a = networkOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd')
    expect(a).toBe('2001:db8:1:2::/64')
    expect(networkOf('2001:db8:1:2::1')).toBe(a)
    expect(networkOf('2001:db8:1:3::1')).not.toBe(a)
    expect(networkOf('2001:db8:1:2::/64')).toBe(a)
  })

  it('refuses other prefixes and junk', () => {
    for (const bad of ['203.0.113.0/24', '203.0.113.9/31', '2001:db8::/48', '2001:db8::/128', '::ffff:1.2.3.4/32', 'x/32', '', null])
      expect(networkOf(bad), String(bad)).toBeNull()
  })

  it('shows an IPv4 network without its /32', () => {
    expect(networkLabel('203.0.113.9/32')).toBe('203.0.113.9')
    expect(networkLabel('2001:db8:1:2::/64')).toBe('2001:db8:1:2::/64')
  })
})

describe('browserSummary', () => {
  it('names the browser and the device of common tablets and phones', () => {
    expect(
      browserSummary('Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'),
    ).toBe('Safari on iPad')
    expect(
      browserSummary('Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'),
    ).toBe('Chrome on Android')
    expect(browserSummary('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36 Edg/129.0')).toBe(
      'Edge on Windows',
    )
    expect(browserSummary('curl/8.0')).toBeNull()
    expect(browserSummary(null)).toBeNull()
  })
})

describe('KioskNetworkCache (a kiosk request’s shop network, ADR 0180 A13)', () => {
  it('reuses an answer for 30 seconds, forgets them all on a network change, and stays bounded', () => {
    let now = 1_000_000
    const c = new KioskNetworkCache(() => now)
    expect(c.get('loc', '203.0.113.9')).toBeNull()
    c.set('loc', '203.0.113.9', { id: 'n1', networkSet: true })
    c.set('loc', '198.51.100.7', { id: null, networkSet: true })
    expect(c.get('loc', '203.0.113.9')).toEqual({ id: 'n1', networkSet: true })
    expect(c.get('other', '203.0.113.9')).toBeNull()
    now += KIOSK_NETWORK_CACHE_MS - 1
    expect(c.get('loc', '198.51.100.7')).toEqual({ id: null, networkSet: true })
    now += 1
    expect(c.get('loc', '198.51.100.7')).toBeNull()
    c.set('loc', '203.0.113.9', { id: 'n1', networkSet: true })
    c.forget()
    expect(c.get('loc', '203.0.113.9')).toBeNull()
    for (let i = 0; i < 1500; i++) c.set('loc', `10.0.${i >> 8}.${i & 255}`, { id: null, networkSet: true })
    expect(c.get('loc', '10.0.0.0')).toBeNull() // the oldest went
    expect(c.get('loc', '10.0.5.219')).toEqual({ id: null, networkSet: true })
  })

  it('lets a network’s last_seen_at be written at most once in 5 minutes', () => {
    let now = 0
    const c = new KioskNetworkCache(() => now)
    expect(c.shouldMarkSeen('n1')).toBe(true)
    expect(c.shouldMarkSeen('n1')).toBe(false)
    expect(c.shouldMarkSeen('n2')).toBe(true)
    now += KIOSK_NETWORK_SEEN_MS - 1
    expect(c.shouldMarkSeen('n1')).toBe(false)
    c.markedSeen('n2') // an unlock wrote it
    now += 1
    expect(c.shouldMarkSeen('n1')).toBe(true)
    expect(c.shouldMarkSeen('n2')).toBe(false)
    c.reset()
    expect(c.shouldMarkSeen('n2')).toBe(true)
  })
})
