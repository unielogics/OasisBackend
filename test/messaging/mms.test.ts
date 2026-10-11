// The pure parts of inbound MMS (ADR 0151): the router's treatment of a text-less MMS and the attachment plan.
import { describe, expect, it } from 'vitest'
import type { MmsPart } from '../../src/integrations/ports/sms.js'
import {
  MMS_MAX_PICTURE_BYTES,
  PICTURE_MESSAGE_TEXT,
  PICTURE_UNAVAILABLE_TEXT,
  messageSegment,
  mmsText,
  planAttachments,
  mmsAttachmentKey,
} from '../../src/modules/messaging/inbound/mms.js'
import { routeInbound, type InboundContext, type InboundText } from '../../src/modules/messaging/inbound/router.js'

const now = new Date('2026-06-13T10:36:00-04:00')
const ctx = (over: Partial<InboundContext> = {}): InboundContext => ({ now, customer: null, optedOut: false, appointments: [], timeZone: 'America/New_York', ...over })
const msg = (over: Partial<InboundText> = {}): InboundText => ({
  eventId: 'e1',
  deviceId: 'd1',
  providerMessageId: 'm1',
  from: '+13055550142',
  body: 'OK',
  receivedAt: now,
  ...over,
})
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex')
const part = (over: Partial<MmsPart> = {}): MmsPart => ({ partId: '1', contentType: 'image/jpeg', name: 'a.jpg', size: JPEG.length, data: JPEG, ...over })

describe('mmsText', () => {
  it('keeps the text, else says a picture came, else that nothing could be read', () => {
    expect(mmsText('  OK ', [])).toEqual({ text: 'OK', placeholder: null })
    expect(mmsText('', [part()])).toEqual({ text: PICTURE_MESSAGE_TEXT, placeholder: 'picture' })
    expect(mmsText(' ', [])).toEqual({ text: PICTURE_UNAVAILABLE_TEXT, placeholder: 'unavailable' })
  })

  it('reads the text of text parts when the body is empty, so a STOP there is a STOP, not a placeholder', () => {
    const textPart = part({ contentType: 'text/plain', data: Buffer.from('STOP'), text: 'STOP' })
    expect(mmsText('', [part(), textPart])).toEqual({ text: 'STOP', placeholder: null })
    expect(mmsText('C', [textPart])).toEqual({ text: 'C', placeholder: null })
    expect(mmsText('', [part({ contentType: 'text/plain', text: '' })])).toEqual({ text: PICTURE_MESSAGE_TEXT, placeholder: 'picture' })
  })
})

describe('routing an MMS', () => {
  it('an MMS with text is routed exactly like the same SMS', () => {
    for (const body of ['STOP', 'C', 'HELP', 'cancel', 'Running late']) {
      const customer = { id: 'c1' }
      const asSms = routeInbound(msg({ body }), ctx({ customer }))
      const asMms = routeInbound(msg({ body, kind: 'mms', placeholder: null }), ctx({ customer }))
      expect(asMms, body).toEqual(asSms)
    }
  })

  it('a placeholder is never a keyword and raises a picture-message alert instead of the reply alert', () => {
    const d = routeInbound(msg({ body: PICTURE_MESSAGE_TEXT, kind: 'mms', placeholder: 'picture' }), ctx({ customer: { id: 'c1' } }))
    expect(d.kind).toBe('message')
    expect(d.commands).toEqual([
      { type: 'store_message', customerId: 'c1', appointmentId: null, unread: true },
      { type: 'staff_alert', kind: 'picture_message', customerId: 'c1', appointmentId: null, excerpt: PICTURE_MESSAGE_TEXT, sender: '+13055550142' },
    ])
  })

  it('a stranger or an unreadable sender is still quarantined, with the picture alert', () => {
    const stranger = routeInbound(msg({ body: PICTURE_MESSAGE_TEXT, kind: 'mms', placeholder: 'picture' }), ctx())
    expect(stranger.commands.map((c) => c.type)).toEqual(['quarantine', 'staff_alert'])
    const unknown = routeInbound(msg({ from: 'unknown', body: PICTURE_UNAVAILABLE_TEXT, kind: 'mms', placeholder: 'unavailable' }), ctx())
    expect(unknown).toMatchObject({ kind: 'quarantined', phone: null })
    expect(unknown.commands).toEqual([
      { type: 'quarantine', reason: 'non_e164_sender' },
      { type: 'staff_alert', kind: 'picture_message', customerId: null, appointmentId: null, excerpt: PICTURE_UNAVAILABLE_TEXT, sender: 'unknown' },
    ])
    // a plain SMS from a short code raises nothing, as before
    expect(routeInbound(msg({ from: '32665', body: 'Your code is 1234' }), ctx()).commands).toEqual([{ type: 'quarantine', reason: 'non_e164_sender' }])
  })
})

describe('planAttachments', () => {
  it('saves pictures by their bytes under a deterministic key and lists the rest', () => {
    const plan = planAttachments('loc-1', 'dev-1', 'msg-1', [part(), part({ contentType: 'text/plain', name: 't.txt', data: Buffer.from('hi') })])
    expect(plan[0]!.record).toMatchObject({ status: 'stored', key: 'messaging/mms/loc-1/dev-1/msg-1/0.jpg', contentType: 'image/jpeg' })
    expect(plan[0]!.save).toEqual({ key: 'messaging/mms/loc-1/dev-1/msg-1/0.jpg', body: JPEG, contentType: 'image/jpeg' })
    expect(plan[1]).toEqual({ record: expect.objectContaining({ status: 'listed', reason: null, key: null }), save: null })
  })

  it('a declared image whose bytes are not JPEG, PNG or WebP is skipped; an oversized one too', () => {
    const plan = planAttachments('l', 'd', 'm', [
      part({ data: Buffer.from('GIF89a') }),
      part({ data: Buffer.concat([JPEG, Buffer.alloc(MMS_MAX_PICTURE_BYTES)]) }),
      part({ data: null, problem: 'decode_failed' }),
    ])
    expect(plan.map((p) => [p.record.status, p.record.reason, p.save])).toEqual([
      ['skipped', 'unsupported_type', null],
      ['skipped', 'too_large', null],
      ['unavailable', 'decode_failed', null],
    ])
  })

  it('puts the device in the key, so two tablets that number an MMS alike never share an object', () => {
    expect(mmsAttachmentKey('loc', 'dev-a', 'mms:4', 0, 'jpg')).toBe('messaging/mms/loc/dev-a/4/0.jpg')
    expect(mmsAttachmentKey('loc', 'dev-a', 'mms:4', 0, 'jpg')).not.toBe(mmsAttachmentKey('loc', 'dev-b', 'mms:4', 0, 'jpg'))
    expect(mmsAttachmentKey('loc', '../x', 'mms:4', 0, 'jpg')).toMatch(/^messaging\/mms\/loc\/x-[0-9a-f]{16}\/4\/0\.jpg$/)
  })

  it('makes any device message id a safe key segment', () => {
    expect(messageSegment('abc_DEF-1')).toBe('abc_DEF-1')
    expect(messageSegment('mms:4')).toBe('4')
    // the incomplete form of a message keeps its own folder: a placeholder and the complete message share no object
    expect(messageSegment('mms:4:incomplete')).toBe('4-incomplete')
    expect(messageSegment('mms:4:incomplete')).not.toBe(messageSegment('mms:4'))
    expect(messageSegment('../x y')).toMatch(/^xy-[0-9a-f]{16}$/)
    expect(messageSegment('///')).toMatch(/^m[0-9a-f]{16}$/)
    expect(messageSegment('a'.repeat(70))).toMatch(/^a{40}-[0-9a-f]{16}$/)
  })
})
