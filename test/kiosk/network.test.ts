// "At the shop" is the shop's internet connection (ADR 0180 amendment): the caller's address (req.ip through TRUST_PROXY; an
// IPv4-mapped IPv6 address as IPv4) and the shop network it belongs to (IPv4 exactly, IPv6 by its /64).
import { describe, expect, it } from 'vitest'
import { callerAddress, networkLabel, networkOf } from '../../src/modules/kiosk/network.js'
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
