import { describe, expect, it } from 'vitest'
import { applyStopFooter, expiryFor, needsStopFooter, prepareOutboundBody, STOP_FOOTER } from '../../src/modules/messaging/policy/body.js'
import { canSendSms, type SmsPolicyContext, type SmsRecipient } from '../../src/modules/messaging/policy/canSend.js'
import { classSpec, QUIET_HOURS_HELD_CLASSES, SMS_CLASSES, TRANSACTIONAL_CLASSES, type SmsClass } from '../../src/modules/messaging/policy/classes.js'
import { InMemoryOptOutRepository } from '../../src/modules/messaging/policy/optouts.js'
import { DEFAULT_QUIET_HOURS, isQuietHour, localMinuteOfDay, quietHoursEnd } from '../../src/modules/messaging/policy/quietHours.js'

const noon = new Date('2026-06-13T12:00:00-04:00')
const at930pm = new Date('2026-06-13T21:30:00-04:00')

const customer = (over: Partial<SmsRecipient> = {}): SmsRecipient => ({
  kind: 'customer',
  id: 'c1',
  phone: '+17865550151',
  smsOptIn: true,
  activeOptOut: false,
  synthetic: false,
  consentSource: 'web_form',
  ...over,
})

const ctx = (over: Partial<SmsPolicyContext> = {}): SmsPolicyContext => ({ now: noon, environment: 'production', allowlist: [], ...over })

describe('quiet hours', () => {
  it('holds 21:00 to 08:00 Eastern and releases at 08:00', () => {
    const q = DEFAULT_QUIET_HOURS
    expect(isQuietHour(new Date('2026-06-13T20:59:00-04:00'), q)).toBe(false)
    expect(isQuietHour(new Date('2026-06-13T21:00:00-04:00'), q)).toBe(true)
    expect(isQuietHour(new Date('2026-06-14T03:00:00-04:00'), q)).toBe(true)
    expect(isQuietHour(new Date('2026-06-14T07:59:59-04:00'), q)).toBe(true)
    expect(isQuietHour(new Date('2026-06-14T08:00:00-04:00'), q)).toBe(false)
    expect(quietHoursEnd(at930pm, q).toISOString()).toBe(new Date('2026-06-14T08:00:00-04:00').toISOString())
    expect(quietHoursEnd(new Date('2026-06-14T02:15:30-04:00'), q).toISOString()).toBe(new Date('2026-06-14T08:00:00-04:00').toISOString())
  })

  it('returns the same instant outside quiet hours', () => {
    expect(quietHoursEnd(noon, DEFAULT_QUIET_HOURS)).toBe(noon)
  })

  it('follows DST in both directions', () => {
    // Spring forward 2026-03-08: 08:00 is EDT (-04:00)
    expect(quietHoursEnd(new Date('2026-03-07T22:00:00-05:00'), DEFAULT_QUIET_HOURS).toISOString()).toBe('2026-03-08T12:00:00.000Z')
    // Fall back 2026-11-01: 08:00 is EST (-05:00)
    expect(quietHoursEnd(new Date('2026-10-31T22:00:00-04:00'), DEFAULT_QUIET_HOURS).toISOString()).toBe('2026-11-01T13:00:00.000Z')
    expect(localMinuteOfDay(new Date('2026-11-01T13:00:00Z'), 'America/New_York')).toBe(8 * 60)
  })

  it('supports a same-day window and being disabled', () => {
    const lunch = { enabled: true, startMinute: 12 * 60, endMinute: 13 * 60, timeZone: 'America/New_York' }
    expect(isQuietHour(noon, lunch)).toBe(true)
    expect(isQuietHour(new Date('2026-06-13T13:00:00-04:00'), lunch)).toBe(false)
    expect(isQuietHour(at930pm, { ...DEFAULT_QUIET_HOURS, enabled: false })).toBe(false)
  })
})

describe('class registry', () => {
  it('lists the transactional classes explicitly', () => {
    expect([...TRANSACTIONAL_CLASSES].sort()).toEqual(
      [
        'addon_approval',
        'booking_confirmed_web',
        'booking_thanks',
        'confirm_ack',
        'confirm_none',
        'confirmed',
        'emergency',
        'help_reply',
        'in_progress',
        'membership_welcome_web',
        'opt_in_confirm',
        'opt_out_confirm',
        'otp_code',
        'password_reset',
        'payment_link',
        'quick_reply',
        'ready',
        'receipt',
        'reschedule',
        'staff_invite',
        'staff_message',
        'welcome',
      ].sort(),
    )
  })

  it('holds only automated and marketing classes', () => {
    expect([...QUIET_HOURS_HELD_CLASSES].sort()).toEqual(['broadcast', 'closure_notice', 'confirm_request', 'late_nudge', 'reminder', 'review'])
  })

  it('gives the checked-in message a 15 minute life and puts the emergency blast in the bulk lane', () => {
    expect(SMS_CLASSES.welcome.ttlSec).toBe(15 * 60)
    expect(SMS_CLASSES.emergency.priority).toBe(3)
    expect(SMS_CLASSES.ready.priority).toBe(0)
  })
})

describe('canSendSms matrix', () => {
  it('allows an ordinary opted-in customer', () => {
    expect(canSendSms(customer(), { klass: 'ready' }, ctx())).toMatchObject({ verdict: 'allow', allowed: true })
  })

  it('denies when there is no usable number', () => {
    expect(canSendSms(customer({ phone: null }), { klass: 'ready' }, ctx())).toMatchObject({ verdict: 'deny', reason: 'no_valid_phone' })
    expect(canSendSms(customer({ phone: '7865550151' }), { klass: 'ready' }, ctx())).toMatchObject({ reason: 'no_valid_phone' })
  })

  it('an active opt-out blocks every class including emergencies, except the keyword replies', () => {
    const optedOut = customer({ activeOptOut: true })
    for (const klass of Object.keys(SMS_CLASSES) as SmsClass[]) {
      const spec = classSpec(klass)
      if (spec.recipient === 'employee') continue
      const d = canSendSms(optedOut, { klass }, ctx())
      if (spec.ignoresOptOut) expect(d.allowed, klass).toBe(true)
      else expect(d, klass).toMatchObject({ verdict: 'deny', reason: 'opted_out' })
    }
    expect(canSendSms(optedOut, { klass: 'emergency' }, ctx())).toMatchObject({ reason: 'opted_out' })
  })

  it('denies when the customer flag is off, except replies to inbound', () => {
    const off = customer({ smsOptIn: false })
    expect(canSendSms(off, { klass: 'confirmed' }, ctx())).toMatchObject({ reason: 'not_opted_in' })
    expect(canSendSms(off, { klass: 'reminder' }, ctx())).toMatchObject({ reason: 'not_opted_in' })
    expect(canSendSms(off, { klass: 'help_reply' }, ctx()).allowed).toBe(true)
    expect(canSendSms(off, { klass: 'confirm_ack' }, ctx()).allowed).toBe(true)
  })

  it('marketing needs an explicit consent source; other classes only warn', () => {
    expect(canSendSms(customer({ consentSource: 'import' }), { klass: 'broadcast' }, ctx())).toMatchObject({ reason: 'consent_source_insufficient' })
    expect(canSendSms(customer({ consentSource: null }), { klass: 'broadcast' }, ctx())).toMatchObject({ reason: 'consent_source_insufficient' })
    expect(canSendSms(customer({ consentSource: 'inbound_reply' }), { klass: 'broadcast' }, ctx()).allowed).toBe(true)
    const legacy = canSendSms(customer({ consentSource: null }), { klass: 'receipt' }, ctx())
    expect(legacy).toMatchObject({ verdict: 'allow' })
    expect(legacy.warnings).toContain('consent_source_missing')
  })

  it('refuses synthetic numbers in production and unless allowlisted elsewhere', () => {
    const seed = customer({ synthetic: true })
    expect(canSendSms(seed, { klass: 'ready' }, ctx())).toMatchObject({ reason: 'synthetic_number' })
    expect(canSendSms(seed, { klass: 'ready' }, ctx({ environment: 'production', allowlist: ['+17865550151'] }))).toMatchObject({ reason: 'synthetic_number' })
    expect(canSendSms(seed, { klass: 'ready' }, ctx({ environment: 'development' }))).toMatchObject({ reason: 'synthetic_number' })
    expect(canSendSms(seed, { klass: 'ready' }, ctx({ environment: 'development', allowlist: ['+17865550151'] })).allowed).toBe(true)
  })

  it('outside production only allowlisted numbers may be texted; an empty list allows nothing', () => {
    expect(canSendSms(customer(), { klass: 'ready' }, ctx({ environment: 'development' }))).toMatchObject({ reason: 'not_allowlisted' })
    expect(canSendSms(customer(), { klass: 'ready' }, ctx({ environment: 'test', allowlist: ['+13055550100'] }))).toMatchObject({ reason: 'not_allowlisted' })
    expect(canSendSms(customer(), { klass: 'ready' }, ctx({ environment: 'development', allowlist: ['+17865550151'] })).allowed).toBe(true)
  })

  it('a non-empty allowlist also restricts production (staging against the real tablet)', () => {
    expect(canSendSms(customer(), { klass: 'ready' }, ctx({ allowlist: ['+13055550100'] }))).toMatchObject({ reason: 'not_allowlisted' })
  })

  it('quiet hours hold non-transactional classes and release at 08:00', () => {
    for (const klass of QUIET_HOURS_HELD_CLASSES) {
      const d = canSendSms(customer(), { klass }, ctx({ now: at930pm }))
      expect(d, klass).toMatchObject({ verdict: 'hold', allowed: true, reason: 'quiet_hours' })
      if (d.verdict === 'hold') expect(d.holdUntil.toISOString()).toBe(new Date('2026-06-14T08:00:00-04:00').toISOString())
    }
  })

  it('transactional classes bypass quiet hours: a booking confirmation at 9:30 PM goes out now', () => {
    for (const klass of TRANSACTIONAL_CLASSES) {
      const rcpt = classSpec(klass).recipient === 'employee' ? customer({ kind: 'employee' }) : customer()
      expect(canSendSms(rcpt, { klass }, ctx({ now: at930pm })).verdict, klass).toBe('allow')
    }
  })

  it('a hard denial beats a hold', () => {
    expect(canSendSms(customer({ activeOptOut: true }), { klass: 'reminder' }, ctx({ now: at930pm }))).toMatchObject({ verdict: 'deny', reason: 'opted_out' })
  })

  it('staff invites go to employees, customers cannot receive them', () => {
    expect(canSendSms(customer(), { klass: 'staff_invite' }, ctx())).toMatchObject({ reason: 'recipient_kind_mismatch' })
    const employee = customer({ kind: 'employee', smsOptIn: false, consentSource: null })
    expect(canSendSms(employee, { klass: 'staff_invite' }, ctx()).allowed).toBe(true)
    expect(canSendSms(employee, { klass: 'ready' }, ctx())).toMatchObject({ reason: 'recipient_kind_mismatch' })
  })
})

describe('opt-out repository', () => {
  it('is idempotent and keyed by number', async () => {
    const repo = new InMemoryOptOutRepository()
    const t = new Date('2026-06-13T10:00:00Z')
    expect(await repo.findActive('+17865550151')).toBeNull()
    expect((await repo.optOut({ phone: '+17865550151', optedOutAt: t, source: 'keyword', keyword: 'STOP' })).created).toBe(true)
    expect((await repo.optOut({ phone: '+17865550151', optedOutAt: t, source: 'keyword', keyword: 'STOP' })).created).toBe(false)
    expect(await repo.findActive('+17865550151')).not.toBeNull()
    expect((await repo.optIn('+17865550151', t)).wasOptedOut).toBe(true)
    expect((await repo.optIn('+17865550151', t)).wasOptedOut).toBe(false)
    expect(await repo.findActive('+17865550151')).toBeNull()
    expect((await repo.optOut({ phone: '+17865550151', optedOutAt: t, source: 'keyword', keyword: 'END' })).created).toBe(true)
  })
})

describe('STOP footer and expiry', () => {
  it('adds the footer to first messages and to confirmations and reminders', () => {
    expect(needsStopFooter('ready', true)).toBe(true)
    expect(needsStopFooter('ready', false)).toBe(false)
    expect(needsStopFooter('confirmed', false)).toBe(true)
    expect(needsStopFooter('confirm_request', false)).toBe(true)
    expect(needsStopFooter('reminder', false)).toBe(true)
    expect(needsStopFooter('staff_invite', true)).toBe(false)
    expect(needsStopFooter('opt_out_confirm', true)).toBe(false)
    expect(applyStopFooter('Your vehicle is ready!', 'ready', true)).toBe(`Your vehicle is ready! ${STOP_FOOTER}`)
    expect(applyStopFooter('Reply STOP to unsubscribe anytime.', 'confirmed', false)).toBe('Reply STOP to unsubscribe anytime.')
  })

  it('prepares a body: normalised, footer added, segments counted on the final text', () => {
    const p = prepareOutboundBody('Your appointment is confirmed for 2:30 PM — see you!', 'confirmed', { firstMessageToNumber: false })
    expect(p.body).toBe('Your appointment is confirmed for 2:30 PM - see you! Reply STOP to opt out.')
    expect(p.footerApplied).toBe(true)
    expect(p.encoding).toBe('GSM-7')
    expect(p.segments).toBe(1)
  })

  it('starts the expiry clock when the message may first go out', () => {
    const queued = new Date('2026-06-13T22:00:00-04:00')
    const release = new Date('2026-06-14T08:00:00-04:00')
    expect(expiryFor('reminder', queued).toISOString()).toBe(new Date('2026-06-14T00:00:00-04:00').toISOString())
    expect(expiryFor('reminder', queued, release).toISOString()).toBe(new Date('2026-06-14T10:00:00-04:00').toISOString())
    expect(expiryFor('welcome', noon).getTime() - noon.getTime()).toBe(15 * 60_000)
    expect(expiryFor('welcome', noon, null, 60).getTime() - noon.getTime()).toBe(60_000)
  })
})
