// Square webhook signatures: base64 HMAC-SHA256 over the registered URL plus the raw body, the current and the previous key.
import { describe, expect, it } from 'vitest'
import { hmacSha256Base64 } from '../../src/http/webhooks.js'
import {
  SQUARE_EVENT_TYPES,
  classifySquareEvent,
  parseSquareEvent,
  signSquareWebhook,
  verifySquareSignature,
} from '../../src/integrations/square/webhook.js'

const KEY = 'sq-test-signature-key-0001'
const PREVIOUS = 'sq-previous-key-0000'
const URL_ = 'https://oasis.example.com/hooks/square'
const BODY =
  '{"merchant_id":"MSIMOASIS0001","type":"payment.updated","event_id":"6a8f5f28-54a1-4eb0-a98a-3111513fd4fc","created_at":"2026-10-12T13:40:18Z","data":{"type":"payment","id":"KkAkhdMsgzn59SM8A89WgKwekxLZY"}}'
// fixed vectors (computed once with an independent HMAC; they must never change)
const SIG = 'CYTFeWcbMhT3yfzfjLi/PTdJUEMIbAlr8xAW55TffG0='
const SIG_PREVIOUS = 'xSGuKAG5fsS9aGuM3L63pKMGxZg4VuE8A4XGcToZuiY='

const verify = (o: Partial<Parameters<typeof verifySquareSignature>[0]>) =>
  verifySquareSignature({ notificationUrl: URL_, rawBody: BODY, signature: SIG, keys: { current: KEY, previous: PREVIOUS }, ...o })

describe('Square webhook signature', () => {
  it('matches the fixed vectors', () => {
    expect(signSquareWebhook(KEY, URL_, BODY)).toBe(SIG)
    expect(signSquareWebhook(PREVIOUS, URL_, BODY)).toBe(SIG_PREVIOUS)
    expect(hmacSha256Base64(KEY, URL_ + BODY)).toBe(SIG)
  })

  it('accepts the current key and, during a rotation, the previous key', () => {
    expect(verify({})).toBe('current')
    expect(verify({ signature: SIG_PREVIOUS })).toBe('previous')
    expect(verify({ signature: ` ${SIG}\n` })).toBe('current')
    expect(verify({ signature: SIG_PREVIOUS, keys: { current: KEY } })).toBeNull()
  })

  it('refuses a wrong URL, a tampered or re-serialised body, a missing signature, no URL and no key', () => {
    expect(verify({ notificationUrl: 'https://oasis.example.com/hooks/square/' })).toBeNull()
    expect(verify({ notificationUrl: 'http://oasis.example.com/hooks/square' })).toBeNull()
    expect(verify({ rawBody: BODY.replace('payment.updated', 'payment.created') })).toBeNull()
    expect(verify({ rawBody: JSON.stringify(JSON.parse(BODY), null, 1) })).toBeNull()
    expect(verify({ signature: undefined })).toBeNull()
    expect(verify({ signature: '' })).toBeNull()
    expect(verify({ notificationUrl: undefined })).toBeNull()
    expect(verify({ keys: {} })).toBeNull()
    expect(verify({ signature: SIG.slice(0, -2) })).toBeNull()
  })

  it('parses the envelope and classifies the object to re-fetch; unknown and id-less events are not handled', () => {
    const r = parseSquareEvent(BODY)
    expect(r.ok && r.event.event_id).toBe('6a8f5f28-54a1-4eb0-a98a-3111513fd4fc')
    expect(parseSquareEvent('nope')).toEqual({ ok: false, reason: 'body is not JSON' })
    expect(parseSquareEvent('{"type":"x"}').ok).toBe(false)
    const ev = (type: string, id?: string) => ({ type, data: { type: type.split('.')[0]!, ...(id ? { id } : {}) } })
    expect(classifySquareEvent(ev('payment.updated', 'P1'))).toEqual({ kind: 'payment', objectId: 'P1', deleted: false, type: 'payment.updated' })
    expect(classifySquareEvent(ev('refund.created', 'R1')).kind).toBe('refund')
    expect(classifySquareEvent(ev('invoice.payment_made', 'I1')).kind).toBe('invoice')
    expect(classifySquareEvent(ev('invoice.published', 'I1')).kind).toBeNull()
    expect(classifySquareEvent(ev('subscription.updated', 'S1')).kind).toBe('subscription')
    expect(classifySquareEvent(ev('card.forgotten', 'C1')).kind).toBe('card')
    expect(classifySquareEvent(ev('customer.deleted', 'K1'))).toMatchObject({ kind: 'customer', deleted: true })
    expect(classifySquareEvent(ev('customer.created', 'K1')).kind).toBeNull()
    expect(classifySquareEvent(ev('order.updated', 'O1')).kind).toBeNull()
    expect(classifySquareEvent(ev('catalog.version.updated')).kind).toBeNull()
    for (const t of SQUARE_EVENT_TYPES) expect(classifySquareEvent(ev(t, 'X')).kind, t).not.toBeNull()
  })
})
