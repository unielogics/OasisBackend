// The SMS classes and consent of the AI assistant, personal links and status texts (ADR 0160, design section 2): the AI may text
// only as a reply (no_recent_inbound otherwise), a client it created has transactional consent only, and every new class sits in
// the lane the design gives it.
import { describe, expect, it } from 'vitest'
import { canSendSms, type SmsPolicyContext, type SmsRecipient } from '../../src/modules/messaging/policy/canSend.js'
import { classSpec, replyContextOf, SMS_CLASSES, TRANSACTIONAL_CLASSES, type SmsClass } from '../../src/modules/messaging/policy/classes.js'
import { STAFF_SENDABLE } from '../../src/modules/messaging/http/thread-routes.js'
import { consentSourceOf } from '../../src/modules/messaging/db/recipients.js'
import { renderTemplate } from '../../src/modules/messaging/templates/render.js'
import { TEMPLATES } from '../../src/modules/messaging/templates/registry.js'

const noon = new Date('2026-06-13T12:00:00-04:00')
const at930pm = new Date('2026-06-13T21:30:00-04:00')
const minutesBefore = (d: Date, m: number): Date => new Date(d.getTime() - m * 60_000)
const ctx = (over: Partial<SmsPolicyContext> = {}): SmsPolicyContext => ({ now: noon, environment: 'production', allowlist: [], ...over })
const person = (over: Partial<SmsRecipient> = {}): SmsRecipient => ({
  kind: 'customer',
  phone: '+12015550142',
  smsOptIn: true,
  activeOptOut: false,
  synthetic: false,
  consentSource: 'staff_attested',
  ...over,
})

describe('consent of a client the assistant created', () => {
  it('inbound_text (and the legacy inbound_sms) map to the transactional-only kind; keyword stays a reply opt-in', () => {
    expect(consentSourceOf('inbound_text')).toBe('inbound_text')
    expect(consentSourceOf('inbound_sms')).toBe('inbound_text')
    expect(consentSourceOf('keyword')).toBe('inbound_reply')
    expect(consentSourceOf('online')).toBe('web_booking')
    expect(consentSourceOf('nope')).toBe('unknown')
    expect(consentSourceOf(null)).toBeNull()
  })

  it('fails canSendSms for a broadcast, passes the transactional classes', () => {
    const ai = person({ consentSource: 'inbound_text' })
    expect(canSendSms(ai, { klass: 'broadcast' }, ctx())).toMatchObject({ verdict: 'deny', reason: 'consent_source_insufficient' })
    for (const klass of ['ready', 'receipt', 'confirmed', 'picked_up', 'job_delay', 'personal_link', 'booking_thanks'] as const)
      expect(canSendSms(ai, { klass }, ctx()).verdict, klass).toBe('allow')
    // automated classes go too (held overnight like everyone's), they are not marketing
    expect(canSendSms(ai, { klass: 'reminder' }, ctx()).verdict).toBe('allow')
  })
})

describe('reply-only classes', () => {
  it('ai_reply needs an inbound text from that number in the last 15 minutes, opted in or not', () => {
    expect(classSpec('ai_reply').replyWindowSec).toBe(15 * 60)
    expect(canSendSms(person(), { klass: 'ai_reply' }, ctx())).toMatchObject({ verdict: 'deny', reason: 'no_recent_inbound' })
    expect(canSendSms(person({ lastInboundAt: null }), { klass: 'ai_reply' }, ctx())).toMatchObject({ reason: 'no_recent_inbound' })
    expect(canSendSms(person({ lastInboundAt: minutesBefore(noon, 16) }), { klass: 'ai_reply' }, ctx())).toMatchObject({ reason: 'no_recent_inbound' })
    const stranger = person({ smsOptIn: false, consentSource: null, lastInboundAt: minutesBefore(noon, 14) })
    expect(canSendSms(stranger, { klass: 'ai_reply' }, ctx()).verdict).toBe('allow')
    expect(canSendSms(stranger, { klass: 'ai_fallback' }, ctx()).verdict).toBe('allow')
    // 24/7: quiet hours never hold a reply
    expect(canSendSms({ ...stranger, lastInboundAt: minutesBefore(at930pm, 1) }, { klass: 'ai_reply' }, ctx({ now: at930pm })).verdict).toBe('allow')
  })

  it('never answers an opted-out number: STOP beats the reply window', () => {
    const optedOut = person({ activeOptOut: true, lastInboundAt: minutesBefore(noon, 1) })
    for (const klass of ['ai_reply', 'ai_fallback', 'action_confirm', 'personal_link', 'lead_follow_up'] as const)
      expect(canSendSms(optedOut, { klass }, ctx()), klass).toMatchObject({ verdict: 'deny', reason: 'opted_out' })
  })

  it('a lead follow-up goes only within 24 hours of their last text and waits for morning', () => {
    const lead = person({ smsOptIn: false, consentSource: null, lastInboundAt: minutesBefore(noon, 3 * 60) })
    expect(canSendSms(lead, { klass: 'lead_follow_up' }, ctx()).verdict).toBe('allow')
    expect(canSendSms({ ...lead, lastInboundAt: minutesBefore(noon, 25 * 60) }, { klass: 'lead_follow_up' }, ctx())).toMatchObject({ reason: 'no_recent_inbound' })
    expect(canSendSms({ ...lead, lastInboundAt: minutesBefore(at930pm, 60) }, { klass: 'lead_follow_up' }, ctx({ now: at930pm }))).toMatchObject({ verdict: 'hold', reason: 'quiet_hours' })
  })

  it('an action confirmation answers the request it confirms (15 minutes), consent-exempt only as that reply', () => {
    expect(canSendSms(person(), { klass: 'action_confirm' }, ctx())).toMatchObject({ reason: 'no_recent_inbound' })
    expect(canSendSms(person({ lastInboundAt: minutesBefore(noon, 2) }), { klass: 'action_confirm' }, ctx()).verdict).toBe('allow')
    const stranger = person({ smsOptIn: false, consentSource: null })
    expect(canSendSms({ ...stranger, lastInboundAt: minutesBefore(noon, 2) }, { klass: 'action_confirm' }, ctx()).verdict).toBe('allow')
    expect(canSendSms({ ...stranger, lastInboundAt: minutesBefore(noon, 16) }, { klass: 'action_confirm' }, ctx())).toMatchObject({ reason: 'no_recent_inbound' })
    expect(canSendSms({ ...stranger, activeOptOut: true, lastInboundAt: minutesBefore(noon, 1) }, { klass: 'action_confirm' }, ctx())).toMatchObject({ reason: 'opted_out' })
  })

  it('a personal link is consent-exempt as a reply within 15 minutes; outside that window it needs normal consent', () => {
    const stranger = person({ smsOptIn: false, consentSource: null })
    expect(canSendSms({ ...stranger, lastInboundAt: minutesBefore(noon, 14) }, { klass: 'personal_link' }, ctx()).verdict).toBe('allow')
    expect(canSendSms({ ...stranger, lastInboundAt: minutesBefore(noon, 16) }, { klass: 'personal_link' }, ctx())).toMatchObject({ reason: 'not_opted_in' })
    expect(canSendSms(stranger, { klass: 'personal_link' }, ctx())).toMatchObject({ reason: 'not_opted_in' })
    // a client with consent gets one any time (staff send a pay link the next day)
    expect(canSendSms(person({ consentSource: 'inbound_text' }), { klass: 'personal_link' }, ctx()).verdict).toBe('allow')
    expect(canSendSms({ ...stranger, activeOptOut: true, lastInboundAt: minutesBefore(noon, 1) }, { klass: 'personal_link' }, ctx())).toMatchObject({ reason: 'opted_out' })
    expect(classSpec('personal_link').replyWindowSec).toBeUndefined()
    expect(replyContextOf('personal_link')).toBe(15 * 60)
    expect(replyContextOf('action_confirm')).toBe(15 * 60)
    expect(replyContextOf('ready')).toBeNull()
  })
})

describe('the new classes', () => {
  it('sit in the design lanes, never lane 0, with the design lifetimes', () => {
    const lanes: Record<string, number> = { ai_reply: 1, ai_fallback: 1, personal_link: 1, action_confirm: 1, lead_follow_up: 2, picked_up: 1, job_delay: 1 }
    for (const [k, lane] of Object.entries(lanes)) expect(classSpec(k as SmsClass).priority, k).toBe(lane)
    expect(SMS_CLASSES.ai_reply.ttlSec).toBe(15 * 60)
    expect(SMS_CLASSES.job_delay.ttlSec).toBe(20 * 60)
    expect(SMS_CLASSES.ai_reply.footer).toBe('first_only')
    for (const k of ['ai_reply', 'ai_fallback', 'action_confirm', 'personal_link', 'lead_follow_up'] as const)
      expect((SMS_CLASSES[k] as { ignoresOptOut?: boolean }).ignoresOptOut, k).toBeUndefined()
    expect(TRANSACTIONAL_CLASSES).toEqual(expect.arrayContaining(['ai_reply', 'ai_fallback', 'personal_link', 'action_confirm', 'picked_up', 'job_delay']))
    expect(TRANSACTIONAL_CLASSES).not.toContain('lead_follow_up')
  })
})

describe('templates', () => {
  it('ai_fallback is the fixed text', () => {
    expect(renderTemplate('ai_fallback').text).toBe('Thanks — a team member will text you back shortly.')
    expect(TEMPLATES.ai_fallback.klass).toBe('ai_fallback')
  })

  it('action_confirm names what it confirms and the reply number', () => {
    expect(renderTemplate('action_confirm', { summary: 'Signature Wash, Sat 10:00 AM', code: '4821' }).text).toBe(
      'Signature Wash, Sat 10:00 AM. Reply 4821 to confirm.',
    )
    expect(() => renderTemplate('action_confirm', { summary: 'x' })).toThrow(/code/)
  })

  it('a personal link per kind, each carrying the link', () => {
    for (const kind of ['calendar', 'verify', 'pin', 'membership', 'pay', 'book_again'] as const) {
      const key = `personal_link_${kind}`
      expect(TEMPLATES[key as keyof typeof TEMPLATES].klass, key).toBe('personal_link')
      const text = renderTemplate(key, { first: 'Maria', link: 'https://oasisautospanj.com/#/c/TOKEN', plan: 'Gold' }).text
      expect(text, key).toContain('https://oasisautospanj.com/#/c/TOKEN')
      expect(text.length, key).toBeLessThanOrEqual(240)
    }
  })

  it('picked up, job delay and the lead follow-up (with and without a link)', () => {
    expect(renderTemplate('picked_up', { first: 'Maria' }).text).toMatch(/^Thanks for visiting Oasis Auto Spa, Maria!/)
    expect(renderTemplate('picked_up', { first: 'Maria', receipt: 'Paid $45.00 — receipt sent.' }).text).toContain('Paid $45.00')
    expect(renderTemplate('job_delay', { eta: '2:45 PM' }).text).toContain('2:45 PM')
    const plain = renderTemplate('lead_follow_up', { first: 'Maria', interest: 'window tint' }).text
    expect(plain).not.toContain('http')
    expect(renderTemplate('lead_follow_up', { first: 'Maria', interest: 'window tint', link: 'https://oasisautospanj.com/#/c/T' }).text).toContain('https://oasisautospanj.com/#/c/T')
  })
})

describe('the staff composer', () => {
  it('STAFF_SENDABLE holds no AI, link or code template', () => {
    const PRIVATE = new Set(['ai_reply', 'ai_fallback', 'personal_link', 'action_confirm', 'otp_code', 'staff_invite', 'password_reset'])
    for (const key of STAFF_SENDABLE) expect(PRIVATE.has(TEMPLATES[key].klass), key).toBe(false)
    // nor any class that answers a text (reply window or reply consent)
    for (const key of STAFF_SENDABLE) expect(replyContextOf(TEMPLATES[key].klass), key).toBeNull()
  })
})
