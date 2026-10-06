import { describe, expect, it } from 'vitest'
import { AppError } from '../../src/platform/errors.js'
import { assertValidKey, canonicalJson, requestHash } from '../../src/platform/idempotency.js'

describe('canonicalJson / requestHash', () => {
  it('ignores key order and undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}',
    )
    expect(canonicalJson(undefined)).toBe('null')
  })

  const base = {
    method: 'post',
    url: '/api/v1/invoices/1/refunds',
    body: { amountCents: 500, reason: 'Service issue' },
  }
  it('is stable for equal requests and sensitive to method, path, query and body', () => {
    const h = requestHash(base)
    expect(
      requestHash({ ...base, method: 'POST', body: { reason: 'Service issue', amountCents: 500 } }),
    ).toBe(h)
    expect(requestHash({ ...base, method: 'PUT' })).not.toBe(h)
    expect(requestHash({ ...base, url: '/api/v1/invoices/2/refunds' })).not.toBe(h)
    expect(requestHash({ ...base, body: { ...base.body, amountCents: 501 } })).not.toBe(h)
    expect(requestHash({ ...base, url: `${base.url}?a=1&b=2` })).toBe(
      requestHash({ ...base, url: `${base.url}?b=2&a=1` }),
    )
  })
})

describe('assertValidKey', () => {
  it('accepts UUIDs and similar tokens', () => {
    for (const k of ['0197b3f2-8d3c-7b1a-9c2e-1f2a3b4c5d6e', 'abc12345', 'order:2026.06.13_x-1'])
      expect(() => assertValidKey(k)).not.toThrow()
  })
  it('rejects short, long and odd keys', () => {
    for (const k of ['short', 'a'.repeat(129), 'has space 1234', 'semi;colon1234', '']) {
      expect(() => assertValidKey(k)).toThrow(AppError)
    }
  })
})
