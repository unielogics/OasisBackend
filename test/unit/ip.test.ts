// Per-address limits key an IPv6 client by its /64 (W4c fixes P8): one subscriber holds a whole /64, so keyed by the full address
// every per-address limit would be unlimited on IPv6. IPv4 stays as it is; an IPv4-mapped IPv6 address is its IPv4 address.
import { describe, expect, it } from 'vitest'
import { ipLimitKey } from '../../src/platform/ip.js'
import { publicLimitChecks } from '../../src/modules/public/limits.js'

describe('ipLimitKey', () => {
  it('keeps IPv4 and anything that is not an address; maps ::ffff:a.b.c.d to its IPv4', () => {
    expect(ipLimitKey('203.0.113.7')).toBe('203.0.113.7')
    expect(ipLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(ipLimitKey('::FFFF:cb00:7107')).toBe('203.0.113.7')
    expect(ipLimitKey('10.91.0.1')).toBe('10.91.0.1')
    expect(ipLimitKey('not-an-ip')).toBe('not-an-ip')
  })

  it('keys every IPv6 address of one /64 alike, whatever its spelling, and two /64s apart', () => {
    const k = '2001:db8:1:2::/64'
    for (const a of ['2001:db8:1:2::1', '2001:0db8:0001:0002:ffff:ffff:ffff:ffff', '2001:DB8:1:2:a:b:c:d', '2001:db8:1:2::1%eth0', '2001:db8:1:2:0:0:1.2.3.4'])
      expect(ipLimitKey(a), a).toBe(k)
    expect(ipLimitKey('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64')
    expect(ipLimitKey('::1')).toBe('0:0:0:0::/64')
    expect(ipLimitKey('fe80::1')).toBe('fe80:0:0:0::/64')
  })

  it('the public limits charge an IPv6 caller by its /64', () => {
    const a = publicLimitChecks('booking', '2001:db8:1:2::1', '+12015550101')
    const b = publicLimitChecks('booking', '2001:db8:1:2:9::9', '+12015550101')
    expect(a.map((c) => c.key)).toEqual(b.map((c) => c.key))
    expect(a[0]!.key).toBe('booking:ip:2001:db8:1:2::/64')
  })
})
