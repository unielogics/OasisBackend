import { describe, expect, it } from 'vitest'
import { FixedClock } from '../../../src/platform/clock.js'
import { SmsWebhookError } from '../../../src/integrations/sms/errors.js'
import { signWebhook, verifySignature } from '../../../src/integrations/smsgate/signature.js'
import { verifyAndParse } from '../../../src/integrations/smsgate/webhook.js'
import { InMemoryProcessedEvents } from '../../../src/modules/messaging/dispatch/memory.js'
import { allWebhookFixtures, FIXTURE_NOW, FIXTURE_SECRET, webhookFixture } from './fixtures.js'

const opts = (clockAt: Date = FIXTURE_NOW, over: { toleranceSec?: number; secret?: string } = {}) => ({
  secret: over.secret ?? FIXTURE_SECRET,
  toleranceSec: over.toleranceSec ?? 86_400,
  clock: new FixedClock(clockAt),
})

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    if (e instanceof SmsWebhookError) return e.code
    throw e
  }
  return 'no error'
}

describe('signature scheme', () => {
  it('is hex HMAC-SHA256 over the raw body followed by the timestamp text (vector computed with Python hmac)', () => {
    expect(signWebhook('key', '{"a":1}', '1700000000')).toBe('5cff791334e7fd8344cc05c2398964f60329f4edd6ab1087ed1ba6c34eefeeca')
    expect(signWebhook('key', '{"a":1}', 1700000000)).toBe('5cff791334e7fd8344cc05c2398964f60329f4edd6ab1087ed1ba6c34eefeeca')
  })

  it('the pre-signed fixtures carry signatures computed independently of this code base', () => {
    const f = webhookFixture('sms-sent')
    expect(f.headers['x-signature']).toBe('9c7419bca1ee5ca907ddce18c3b97a17ada5e4d7ec9280fd8f7587840f893c7a')
    expect(signWebhook(FIXTURE_SECRET, f.body, f.headers['x-timestamp'] as string)).toBe(f.headers['x-signature'])
  })

  it('the signature depends on the key, the body and the timestamp', () => {
    const base = signWebhook('k', 'b', '1')
    expect(signWebhook('k2', 'b', '1')).not.toBe(base)
    expect(signWebhook('k', 'b2', '1')).not.toBe(base)
    expect(signWebhook('k', 'b', '2')).not.toBe(base)
    // the message is the plain concatenation body + timestamp, as the device builds it
    expect(signWebhook('k', 'b1', '')).toBe(base)
  })

  it('verifySignature accepts a correct signature in either case and rejects everything else without throwing', () => {
    const sig = signWebhook('k', 'body', '1700000000')
    expect(verifySignature('k', 'body', '1700000000', sig)).toBe(true)
    expect(verifySignature('k', 'body', '1700000000', sig.toUpperCase())).toBe(true)
    expect(verifySignature('k', 'body', '1700000000', ` ${sig} `)).toBe(true)
    expect(verifySignature('k', 'body', '1700000001', sig)).toBe(false)
    expect(verifySignature('k', 'body', '1700000000', sig.slice(0, 62))).toBe(false)
    expect(verifySignature('k', 'body', '1700000000', `${sig}00`)).toBe(false)
    expect(verifySignature('k', 'body', '1700000000', 'zz'.repeat(32))).toBe(false)
    expect(verifySignature('k', 'body', '1700000000', '')).toBe(false)
    expect(verifySignature('k', 'body', '1700000000', '0'.repeat(64))).toBe(false)
  })
})

describe('signed fixtures: valid', () => {
  const supported = allWebhookFixtures().filter((f) => !('error' in f.expect))

  it('has fixtures for every event Oasis handles', () => {
    const kinds = new Set(supported.map((f) => f.expect.kind))
    expect([...kinds].sort()).toEqual(['app_started', 'cancelled', 'delivered', 'failed', 'mms_notified', 'ping', 'received', 'sent'])
  })

  it.each(supported.map((f) => [f.name, f] as const))('%s verifies and parses', (_name, f) => {
    const parsed = verifyAndParse(f.headers, f.body, opts())
    const { at, ...rest } = parsed.event as unknown as Record<string, unknown>
    const { at: expectedAt, ...expectedRest } = f.expect
    expect(rest).toMatchObject({ ...expectedRest, eventId: parsed.envelopeId })
    expect((at as Date).toISOString()).toBe(expectedAt)
    expect(parsed.deviceId).toBe('FxDevice0000000001')
    expect(parsed.signedAt.toISOString()).toBe('2026-06-13T16:00:05.000Z')
  })

  it('exposes the envelope id as the dedupe key and the webhook id', () => {
    const f = webhookFixture('sms-delivered')
    const parsed = verifyAndParse(f.headers, f.body, opts())
    expect(parsed.envelopeId).toBe('FxEnvelope0000000007')
    expect(parsed.webhookId).toBe('oasis-sms-delivered')
    expect(parsed.event.eventId).toBe(parsed.envelopeId)
  })

  it('reads battery and charging from the ping health document', () => {
    const ok = verifyAndParse(webhookFixture('system-ping-pass').headers, webhookFixture('system-ping-pass').body, opts())
    expect(ok.extras.health).toMatchObject({ status: 'pass', battery: 87, charging: true })
    const warn = verifyAndParse(webhookFixture('system-ping-warn').headers, webhookFixture('system-ping-warn').body, opts())
    expect(warn.extras.health).toMatchObject({ status: 'warn', battery: 18, charging: false })
  })

  it('reads SIM cards from app:started and the part count from sms:sent', () => {
    const started = webhookFixture('app-started')
    expect(verifyAndParse(started.headers, started.body, opts()).extras.simCards?.[0]).toMatchObject({ simNumber: 1, phoneNumber: '+17865550100' })
    const sent = webhookFixture('sms-sent')
    expect(verifyAndParse(sent.headers, sent.body, opts()).extras).toMatchObject({ partsCount: 1, recipient: '+17865550151', simNumber: 1 })
  })

  it('keeps inbound text exactly, emoji and typography included', () => {
    const f = webhookFixture('sms-received-unicode')
    const e = verifyAndParse(f.headers, f.body, opts()).event
    expect(e.kind === 'received' && e.body).toBe('Thanks \u{1F64F} — see you at 3 ’ish')
  })

  it('normalises a bare-digit sender and leaves a short code as reported', () => {
    expect(verifyAndParse(webhookFixture('sms-received-bare-digits').headers, webhookFixture('sms-received-bare-digits').body, opts()).event).toMatchObject({ from: '+17865550151' })
    expect(verifyAndParse(webhookFixture('sms-received-shortcode').headers, webhookFixture('sms-received-shortcode').body, opts()).event).toMatchObject({ from: '32665' })
  })

  it('header names are case-insensitive and the signature may be upper case', () => {
    const f = webhookFixture('sms-sent')
    const headers = { 'X-Signature': f.headers['x-signature']?.toUpperCase(), 'X-TIMESTAMP': f.headers['x-timestamp'] }
    expect(verifyAndParse(headers, f.body, opts()).event.kind).toBe('sent')
  })
})

describe('signed fixtures: rejected', () => {
  const f = webhookFixture('sms-received-confirm')

  it('rejects a bad signature', () => {
    const sig = f.headers['x-signature'] as string
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`
    expect(code(() => verifyAndParse({ ...f.headers, 'x-signature': flipped }, f.body, opts()))).toBe('bad_signature')
  })

  it('rejects a signature made with another key', () => {
    expect(code(() => verifyAndParse(f.headers, f.body, opts(FIXTURE_NOW, { secret: 'someone-elses-key' })))).toBe('bad_signature')
  })

  it('rejects a tampered body, even a whitespace change (the signature covers the raw bytes)', () => {
    expect(code(() => verifyAndParse(f.headers, f.body.replace('"C"', '"STOP"'), opts()))).toBe('bad_signature')
    expect(code(() => verifyAndParse(f.headers, `${f.body}\n`, opts()))).toBe('bad_signature')
    expect(code(() => verifyAndParse(f.headers, JSON.stringify(JSON.parse(f.body), null, 1), opts()))).toBe('bad_signature')
  })

  it('rejects a replayed body under a different timestamp', () => {
    expect(code(() => verifyAndParse({ ...f.headers, 'x-timestamp': '1781366406' }, f.body, opts()))).toBe('bad_signature')
  })

  it('rejects missing and malformed headers', () => {
    expect(code(() => verifyAndParse({ 'x-timestamp': f.headers['x-timestamp'] }, f.body, opts()))).toBe('missing_header')
    expect(code(() => verifyAndParse({ 'x-signature': f.headers['x-signature'] }, f.body, opts()))).toBe('missing_header')
    expect(code(() => verifyAndParse({ ...f.headers, 'x-timestamp': 'yesterday' }, f.body, opts()))).toBe('bad_timestamp')
    expect(code(() => verifyAndParse({ ...f.headers, 'x-timestamp': '1781366405.5' }, f.body, opts()))).toBe('bad_timestamp')
    expect(code(() => verifyAndParse({}, f.body, opts()))).toBe('missing_header')
  })

  it('rejects a stale timestamp but accepts the device retrying for up to 24 hours by default', () => {
    expect(code(() => verifyAndParse(f.headers, f.body, opts(new Date(FIXTURE_NOW.getTime() + 23 * 3600_000))))).toBe('no error')
    expect(code(() => verifyAndParse(f.headers, f.body, opts(new Date(FIXTURE_NOW.getTime() + 24 * 3600_000 + 1000))))).toBe('stale_timestamp')
    expect(code(() => verifyAndParse(f.headers, f.body, opts(new Date(FIXTURE_NOW.getTime() + 6 * 60_000), { toleranceSec: 300 })))).toBe('stale_timestamp')
    expect(code(() => verifyAndParse(f.headers, f.body, opts(new Date(FIXTURE_NOW.getTime() + 4 * 60_000), { toleranceSec: 300 })))).toBe('no error')
  })

  it('rejects a timestamp from the future beyond the tolerance', () => {
    expect(code(() => verifyAndParse(f.headers, f.body, opts(new Date(FIXTURE_NOW.getTime() - 2 * 86_400_000))))).toBe('stale_timestamp')
  })

  it('checks the signature before the clock so a forger learns nothing about the window', () => {
    const stale = opts(new Date(FIXTURE_NOW.getTime() + 10 * 86_400_000))
    expect(code(() => verifyAndParse({ ...f.headers, 'x-signature': '0'.repeat(64) }, f.body, stale))).toBe('bad_signature')
  })

  it('rejects a correctly signed body that is not an envelope', () => {
    const body = 'not json'
    const ts = f.headers['x-timestamp'] as string
    const headers = { 'x-signature': signWebhook(FIXTURE_SECRET, body, ts), 'x-timestamp': ts }
    expect(code(() => verifyAndParse(headers, body, opts()))).toBe('bad_body')
    const noId = JSON.stringify({ deviceId: 'd', event: 'sms:sent', payload: {} })
    expect(code(() => verifyAndParse({ 'x-signature': signWebhook(FIXTURE_SECRET, noId, ts), 'x-timestamp': ts }, noId, opts()))).toBe('bad_body')
    const noMessageId = JSON.stringify({ id: 'e', deviceId: 'd', event: 'sms:sent', payload: {} })
    expect(code(() => verifyAndParse({ 'x-signature': signWebhook(FIXTURE_SECRET, noMessageId, ts), 'x-timestamp': ts }, noMessageId, opts()))).toBe('bad_body')
  })

  it('reports events Oasis does not handle as unsupported once the signature is good', () => {
    for (const name of ['sms-batch-received']) {
      const u = webhookFixture(name)
      expect(code(() => verifyAndParse(u.headers, u.body, opts())), name).toBe('unsupported_event')
      expect(code(() => verifyAndParse({ ...u.headers, 'x-signature': '0'.repeat(64) }, u.body, opts())), name).toBe('bad_signature')
    }
  })
})

describe('MMS (docs.sms-gate.app/features/mms)', () => {
  const parse = (name: string) => verifyAndParse(webhookFixture(name).headers, webhookFixture(name).body, opts())

  it('mms:downloaded is a received message: trimmed body, normalised sender, the message id as provider id, the parts decoded', () => {
    const p = parse('mms-downloaded-ok')
    expect(p.eventName).toBe('mms:downloaded')
    expect(p.envelopeId).toBe('FxEnvelope0000000014')
    const e = p.event
    if (e.kind !== 'received') throw new Error('expected received')
    expect(e).toMatchObject({ from: '+17865550151', body: 'OK', providerMessageId: 'mms:fx-mms-0002', eventId: 'FxEnvelope0000000014' })
    expect(e.mms?.subject).toBeNull()
    expect(e.mms?.parts.map(({ data, ...rest }) => ({ ...rest, bytes: data?.toString('hex') ?? null }))).toEqual([
      { partId: '1', contentType: 'image/jpeg', name: 'IMG_0001.jpg', size: 22, bytes: 'ffd8ffe000104a46494600010100000100010000ffd9' },
      { partId: '2', contentType: 'text/plain', name: 'text_0.txt', size: 2, bytes: Buffer.from('OK').toString('hex') },
    ])
  })

  it('reads the sender from phoneNumber when sender is absent (the docs show both)', () => {
    const e = parse('mms-downloaded-phonenumber').event
    expect(e).toMatchObject({ kind: 'received', from: '+17865550151', body: 'STOP' })
    expect(e.kind === 'received' && e.mms?.parts).toEqual([])
  })

  it('a picture with no text has an empty body; an MMS with nothing at all keeps an unknown sender rather than failing', () => {
    expect(parse('mms-downloaded-picture-only').event).toMatchObject({ kind: 'received', body: '' })
    const incomplete = parse('mms-downloaded-incomplete').event
    expect(incomplete).toMatchObject({ kind: 'received', from: 'unknown', body: '' })
    expect(incomplete.kind === 'received' && incomplete.mms).toEqual({ subject: null, parts: [] })
  })

  it('uses the subject when the body is empty, accepts a data: prefix and the URL alphabet, and marks broken or missing data', () => {
    const ts = '1781366405'
    const body = JSON.stringify({
      id: 'env-x',
      event: 'mms:downloaded',
      deviceId: 'd',
      payload: {
        messageId: 'm-x',
        sender: '+17865550151',
        body: '   ',
        subject: ' C ',
        attachments: [
          { partId: '1', contentType: 'IMAGE/PNG; name=a.png', name: 'a.png', size: 4, data: 'data:image/png;base64,iVBORw0KGgo=' },
          { partId: '2', contentType: 'image/jpeg', name: 'b.jpg', size: 99, data: '***not base64***' },
          { partId: '3', contentType: 'image/jpeg', name: 'c.jpg', size: 7, data: null },
          { partId: 4, contentType: 'image/jpeg', name: 'd.jpg', data: '_-8' },
          { partId: '5', contentType: 'video/mp4', name: 'e.mp4', size: 12.5, data: null },
          { partId: '6', size: -3, data: null },
        ],
      },
    })
    const e = verifyAndParse({ 'x-signature': signWebhook(FIXTURE_SECRET, body, ts), 'x-timestamp': ts }, body, opts()).event
    if (e.kind !== 'received' || !e.mms) throw new Error('expected an mms')
    expect(e.body).toBe('C')
    expect(e.mms.subject).toBe('C')
    expect(e.mms.parts.map((x) => [x.partId, x.contentType, x.size, x.problem ?? null, x.data?.length ?? null])).toEqual([
      ['1', 'image/png', 8, null, 8],
      ['2', 'image/jpeg', 99, 'decode_failed', null],
      ['3', 'image/jpeg', 7, 'missing', null],
      ['4', 'image/jpeg', 2, null, 2],
      ['5', 'video/mp4', null, 'missing', null],
      ['6', 'application/octet-stream', null, 'missing', null],
    ])
  })

  it('mms:received is a notice only (no text): its own event kind, never a received message', () => {
    const p = parse('mms-received')
    expect(p.event).toMatchObject({ kind: 'mms_notified', providerMessageId: 'mms:fx-mms-0001', from: '+17865550151' })
  })

  it('a signed but unusable event says which event and envelope it was', () => {
    const f = webhookFixture('sms-batch-received')
    try {
      verifyAndParse(f.headers, f.body, opts())
      throw new Error('no error')
    } catch (e) {
      expect(e).toBeInstanceOf(SmsWebhookError)
      expect(e).toMatchObject({ code: 'unsupported_event', event: 'sms:batch:received', signed: true })
      expect((e as SmsWebhookError).envelopeId).toBeTruthy()
    }
    const ts = '1781366405'
    const noId = JSON.stringify({ id: 'env-y', event: 'mms:downloaded', deviceId: 'd', payload: { body: 'hi' } })
    try {
      verifyAndParse({ 'x-signature': signWebhook(FIXTURE_SECRET, noId, ts), 'x-timestamp': ts }, noId, opts())
      throw new Error('no error')
    } catch (e) {
      expect(e).toMatchObject({ code: 'bad_body', event: 'mms:downloaded', envelopeId: 'env-y', signed: true })
    }
  })
})

describe('replay and dedupe', () => {
  it('a redelivered envelope has the same id, so the second one is dropped', async () => {
    const f = webhookFixture('sms-received-confirm')
    const seen = new InMemoryProcessedEvents()
    const first = verifyAndParse(f.headers, f.body, opts())
    const again = verifyAndParse(f.headers, f.body, opts())
    expect(again.envelopeId).toBe(first.envelopeId)
    expect(await seen.markIfNew(first.envelopeId)).toBe(true)
    expect(await seen.markIfNew(again.envelopeId)).toBe(false)
  })

  it('different envelopes for the same message (multipart delivery receipts) have different ids', () => {
    const a = webhookFixture('sms-delivered')
    const b = webhookFixture('sms-sent')
    expect(verifyAndParse(a.headers, a.body, opts()).envelopeId).not.toBe(verifyAndParse(b.headers, b.body, opts()).envelopeId)
  })
})
