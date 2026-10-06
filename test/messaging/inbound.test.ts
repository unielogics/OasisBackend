import { describe, expect, it } from 'vitest'
import { FixedClock } from '../../src/platform/clock.js'
import { attributeInbound, nextUnconfirmed, type AppointmentRef } from '../../src/modules/messaging/inbound/attribution.js'
import { keywordToken, parseKeyword } from '../../src/modules/messaging/inbound/keywords.js'
import { InMemoryCustomerDirectory, InMemoryInboxRepository } from '../../src/modules/messaging/inbound/repositories.js'
import { routeInbound, type InboundCommand, type InboundContext, type InboundText } from '../../src/modules/messaging/inbound/router.js'
import { InboundService, type InboundEffects } from '../../src/modules/messaging/inbound/service.js'
import { InMemoryOptOutRepository } from '../../src/modules/messaging/policy/optouts.js'

const now = new Date('2026-06-13T10:36:00-04:00')
const h = (n: number): Date => new Date(now.getTime() + n * 3600_000)
const appt = (id: string, status: AppointmentRef['status'], start: Date, completedAt?: Date): AppointmentRef => ({ id, status, start, completedAt })

describe('parseKeyword', () => {
  it.each(['STOP', 'stop', ' Stop ', 'Stop.', 'STOP!', 'stopall', 'UNSUBSCRIBE', 'end', 'Quit'])('%j is an opt-out', (body) => {
    expect(parseKeyword(body).kind).toBe('opt_out')
  })

  it.each(['START', 'start', 'Unstop', 'UNSTOP.'])('%j is an opt-in', (body) => {
    expect(parseKeyword(body).kind).toBe('opt_in')
  })

  it.each([
    ['YES', 'yes'],
    ['y', 'none'],
    ['HELP', 'help'],
    ['help?', 'help'],
    ['C', 'confirm'],
    ['c', 'confirm'],
    ['Confirm', 'confirm'],
    ['confirmed', 'none'],
    ['CANCEL', 'cancel'],
    ['cancel my appointment', 'none'],
    ['please stop texting me', 'none'],
    ['stop it', 'none'],
    ['stop stop', 'none'],
    ['', 'none'],
    ['   ', 'none'],
    ['!!!', 'none'],
    ['see you at 3', 'none'],
  ])('%j -> %s', (body, kind) => {
    expect(parseKeyword(body).kind).toBe(kind)
  })

  it('CANCEL is not an opt-out', () => {
    expect(parseKeyword('CANCEL').kind).not.toBe('opt_out')
  })

  it('ignores zero-width characters and full-width letters', () => {
    expect(keywordToken(`S${String.fromCodePoint(0x200b)}TOP`)).toBe('STOP')
    expect(parseKeyword('ＳＴＯＰ').kind).toBe('opt_out')
  })
})

describe('attributeInbound', () => {
  it('prefers a job in progress', () => {
    const a = [appt('up', 'confirmed', h(2)), appt('wash', 'cleaning', h(-1))]
    expect(attributeInbound(a, now)).toEqual({ appointmentId: 'wash', basis: 'in_progress' })
  })

  it('takes the nearest upcoming appointment within 72 hours', () => {
    const a = [appt('far', 'confirmed', h(70)), appt('near', 'booked', h(5)), appt('mid', 'confirmed', h(30))]
    expect(attributeInbound(a, now)).toEqual({ appointmentId: 'near', basis: 'upcoming' })
  })

  it('ignores upcoming appointments beyond 72 hours', () => {
    expect(attributeInbound([appt('far', 'confirmed', h(73))], now)).toBeNull()
    expect(attributeInbound([appt('edge', 'confirmed', h(72))], now)).toEqual({ appointmentId: 'edge', basis: 'upcoming' })
  })

  it('counts an appointment that started a moment ago (a late customer replying)', () => {
    expect(attributeInbound([appt('late', 'booked', h(-0.5))], now)).toEqual({ appointmentId: 'late', basis: 'upcoming' })
    expect(attributeInbound([appt('gone', 'booked', h(-3))], now)).toBeNull()
  })

  it('falls back to the last completed appointment within 14 days', () => {
    const a = [appt('old', 'completed', h(-24 * 20)), appt('recent', 'completed', h(-24 * 5)), appt('newer', 'completed', h(-24 * 2))]
    expect(attributeInbound(a, now)).toEqual({ appointmentId: 'newer', basis: 'recent_completed' })
    expect(attributeInbound([appt('old', 'completed', h(-24 * 15))], now)).toBeNull()
    expect(attributeInbound([appt('boundary', 'completed', h(-24 * 14))], now)).toEqual({ appointmentId: 'boundary', basis: 'recent_completed' })
  })

  it('uses completedAt over the start time', () => {
    expect(attributeInbound([appt('x', 'completed', h(-24 * 20), h(-24))], now)).toEqual({ appointmentId: 'x', basis: 'recent_completed' })
  })

  it('upcoming beats completed, and canceled/no-show never count', () => {
    const a = [appt('done', 'completed', h(-2)), appt('next', 'confirmed', h(20)), appt('c', 'canceled', h(3)), appt('n', 'noshow', h(-1))]
    expect(attributeInbound(a, now)).toEqual({ appointmentId: 'next', basis: 'upcoming' })
    expect(attributeInbound([appt('c', 'canceled', h(3)), appt('n', 'noshow', h(-1))], now)).toBeNull()
    expect(attributeInbound([], now)).toBeNull()
  })

  it('nextUnconfirmed picks the earliest future booked appointment only', () => {
    const a = [appt('a', 'booked', h(30)), appt('b', 'booked', h(4)), appt('c', 'confirmed', h(1)), appt('d', 'booked', h(-1))]
    expect(nextUnconfirmed(a, now)?.id).toBe('b')
    expect(nextUnconfirmed([appt('c', 'confirmed', h(1))], now)).toBeNull()
  })
})

const msg = (body: string, from = '+17865550151'): InboundText => ({
  eventId: 'evt-1',
  deviceId: 'dev-1',
  providerMessageId: 'in-1',
  from,
  body,
  receivedAt: now,
})

const known = { id: 'cust-1', firstName: 'Liam' }
const ctx = (over: Partial<InboundContext> = {}): InboundContext => ({
  now,
  customer: known,
  optedOut: false,
  appointments: [],
  timeZone: 'America/New_York',
  ...over,
})

const types = (cmds: InboundCommand[]): string[] => cmds.map((c) => c.type)
const reply = (cmds: InboundCommand[]): string | undefined => {
  const r = cmds.find((c): c is Extract<InboundCommand, { type: 'send_reply' }> => c.type === 'send_reply')
  return r?.template
}

describe('routeInbound table', () => {
  const booked = [appt('A1', 'booked', h(20))]
  const confirmedOnly = [appt('A2', 'confirmed', h(20))]

  interface Row {
    name: string
    body: string
    ctx: Partial<InboundContext>
    from?: string
    kind: string
    commands: string[]
    reply?: string
  }
  const rows: Row[] = [
    { name: 'STOP from a customer', body: 'STOP', ctx: {}, kind: 'opt_out', commands: ['record_opt_out', 'send_reply', 'store_message'], reply: 'opt_out_confirm' },
    { name: 'stop. lower case with punctuation', body: 'stop.', ctx: {}, kind: 'opt_out', commands: ['record_opt_out', 'send_reply', 'store_message'], reply: 'opt_out_confirm' },
    { name: 'STOP from a stranger still opts the number out', body: 'STOP', ctx: { customer: null }, kind: 'opt_out', commands: ['record_opt_out', 'send_reply', 'quarantine'], reply: 'opt_out_confirm' },
    { name: 'STOP when already opted out: no second confirmation', body: 'STOP', ctx: { optedOut: true }, kind: 'opt_out', commands: ['record_opt_out', 'store_message'] },
    { name: 'UNSUBSCRIBE', body: 'Unsubscribe', ctx: {}, kind: 'opt_out', commands: ['record_opt_out', 'send_reply', 'store_message'], reply: 'opt_out_confirm' },
    { name: 'START opts back in', body: 'START', ctx: { optedOut: true }, kind: 'opt_in', commands: ['record_opt_in', 'send_reply', 'store_message'], reply: 'opt_in_confirm' },
    { name: 'START when not opted out still processes as opt-in', body: 'start', ctx: {}, kind: 'opt_in', commands: ['record_opt_in', 'send_reply', 'store_message'], reply: 'opt_in_confirm' },
    { name: 'UNSTOP from a stranger', body: 'UNSTOP', ctx: { customer: null }, kind: 'opt_in', commands: ['record_opt_in', 'send_reply', 'quarantine'], reply: 'opt_in_confirm' },
    { name: 'YES while opted out opts back in', body: 'YES', ctx: { optedOut: true, appointments: booked }, kind: 'opt_in', commands: ['record_opt_in', 'send_reply', 'store_message'], reply: 'opt_in_confirm' },
    { name: 'YES with an unconfirmed booking confirms it', body: 'yes', ctx: { appointments: booked }, kind: 'confirm', commands: ['confirm_appointment', 'send_reply', 'store_message'], reply: 'confirm_ack' },
    { name: 'YES with nothing to confirm is an ordinary message', body: 'YES', ctx: { appointments: confirmedOnly }, kind: 'message', commands: ['store_message', 'staff_alert'] },
    { name: 'C confirms the next unconfirmed appointment', body: 'C', ctx: { appointments: [...booked, appt('A0', 'booked', h(3))] }, kind: 'confirm', commands: ['confirm_appointment', 'send_reply', 'store_message'], reply: 'confirm_ack' },
    { name: 'CONFIRM works too', body: 'Confirm', ctx: { appointments: booked }, kind: 'confirm', commands: ['confirm_appointment', 'send_reply', 'store_message'], reply: 'confirm_ack' },
    { name: 'C with nothing to confirm', body: 'C', ctx: { appointments: confirmedOnly }, kind: 'confirm_nothing', commands: ['send_reply', 'store_message', 'staff_alert'], reply: 'confirm_none' },
    { name: 'C from a stranger is quarantined', body: 'C', ctx: { customer: null }, kind: 'quarantined', commands: ['quarantine'] },
    { name: 'HELP from a customer', body: 'HELP', ctx: {}, kind: 'help', commands: ['send_reply', 'store_message'], reply: 'help_reply' },
    { name: 'HELP from a stranger gets the reply but no customer row', body: 'help', ctx: { customer: null }, kind: 'help', commands: ['send_reply', 'quarantine'], reply: 'help_reply' },
    { name: 'CANCEL is a staff alert, never an opt-out', body: 'CANCEL', ctx: { appointments: booked }, kind: 'cancel_request', commands: ['store_message', 'staff_alert'] },
    { name: 'CANCEL from a stranger', body: 'CANCEL', ctx: { customer: null }, kind: 'quarantined', commands: ['quarantine'] },
    { name: 'free text from a customer with an appointment', body: 'Running 10 minutes late', ctx: { appointments: booked }, kind: 'message', commands: ['store_message', 'staff_alert'] },
    { name: 'free text from a customer with no appointment', body: 'Do you detail boats?', ctx: {}, kind: 'message', commands: ['store_message', 'staff_alert'] },
    { name: 'free text from a stranger is quarantined', body: 'Hello?', ctx: { customer: null }, kind: 'quarantined', commands: ['quarantine'] },
    { name: 'carrier short code is quarantined', body: 'Your code is 123456', ctx: { customer: null }, from: '32665', kind: 'quarantined', commands: ['quarantine'] },
    { name: 'alphanumeric sender is quarantined', body: 'STOP', ctx: { customer: null }, from: 'AMAZON', kind: 'quarantined', commands: ['quarantine'] },
    { name: 'a sentence containing stop is not a keyword', body: 'please stop calling the wrong number', ctx: {}, kind: 'message', commands: ['store_message', 'staff_alert'] },
    { name: 'opted-out customer writing normally is still recorded', body: 'Can I move my appointment?', ctx: { optedOut: true, appointments: booked }, kind: 'message', commands: ['store_message', 'staff_alert'] },
  ]

  it.each(rows)('$name', (row) => {
    const d = routeInbound(msg(row.body, row.from), ctx(row.ctx))
    expect(d.kind).toBe(row.kind)
    expect(types(d.commands)).toEqual(row.commands)
    expect(reply(d.commands)).toBe(row.reply)
  })

  it('never produces a customer-creating command for strangers', () => {
    for (const body of ['STOP', 'HELP', 'C', 'hi', 'CANCEL', 'START', 'YES']) {
      const d = routeInbound(msg(body), ctx({ customer: null }))
      expect(types(d.commands)).not.toContain('store_message')
      expect(types(d.commands)).not.toContain('confirm_appointment')
      expect(types(d.commands)).not.toContain('staff_alert')
    }
  })

  it('normalises the sender to E.164 and carries it on every reply', () => {
    const d = routeInbound(msg('HELP', '(786) 555-0151'), ctx())
    expect(d.phone).toBe('+17865550151')
    expect(d.commands.find((c) => c.type === 'send_reply')).toMatchObject({ to: '+17865550151' })
  })

  it('names the confirmed time in the acknowledgement', () => {
    const d = routeInbound(msg('C'), ctx({ appointments: [appt('A1', 'booked', new Date('2026-06-14T09:00:00-04:00'))] }))
    expect(d.commands.find((c) => c.type === 'send_reply')).toMatchObject({ template: 'confirm_ack', vars: { time: 'tomorrow at 9:00 AM' } })
    expect(d.commands.find((c) => c.type === 'confirm_appointment')).toMatchObject({ appointmentId: 'A1', customerId: 'cust-1' })
  })

  it('attributes plain messages and raises the right alert', () => {
    const a = routeInbound(msg('hi'), ctx({ appointments: [appt('A1', 'confirmed', h(5))] }))
    expect(a.attribution).toEqual({ appointmentId: 'A1', basis: 'upcoming' })
    expect(a.commands.find((c) => c.type === 'store_message')).toMatchObject({ appointmentId: 'A1', unread: true })
    expect(a.commands.find((c) => c.type === 'staff_alert')).toMatchObject({ kind: 'inbound_message', appointmentId: 'A1' })

    const u = routeInbound(msg('hi'), ctx())
    expect(u.attribution).toBeNull()
    expect(u.commands.find((c) => c.type === 'staff_alert')).toMatchObject({ kind: 'unattributed_inbound', appointmentId: null })
  })

  it('passes the business phone to the HELP reply when known', () => {
    const d = routeInbound(msg('HELP'), ctx({ businessPhone: '(786) 555-0100' }))
    expect(d.commands.find((c) => c.type === 'send_reply')).toMatchObject({ vars: { phone: '(786) 555-0100' } })
  })

  it('truncates long text in alerts', () => {
    const d = routeInbound(msg('x'.repeat(500)), ctx())
    const alert = d.commands.find((c) => c.type === 'staff_alert') as Extract<InboundCommand, { type: 'staff_alert' }>
    expect(alert.excerpt.length).toBeLessThanOrEqual(140)
  })
})

describe('InboundService', () => {
  function setup() {
    const clock = new FixedClock(now)
    const inbox = new InMemoryInboxRepository()
    const optouts = new InMemoryOptOutRepository()
    const directory = new InMemoryCustomerDirectory()
    directory.add('+17865550151', known, [appt('A1', 'booked', h(20))])
    const calls: string[] = []
    const effects: InboundEffects = {
      async sendReply(to, template) {
        calls.push(`reply:${template}:${to}`)
      },
      async confirmAppointment(id) {
        calls.push(`confirm:${id}`)
      },
      async storeMessage(m) {
        calls.push(`store:${m.customerId}:${m.unread}`)
      },
      async staffAlert(a) {
        calls.push(`alert:${a.kind}`)
      },
    }
    const service = new InboundService(inbox, optouts, directory, effects, clock, { timeZone: 'America/New_York' })
    return { service, inbox, optouts, calls, directory }
  }

  it('STOP records an opt-out by number, replies once and blocks the repeat', async () => {
    const { service, optouts, calls } = setup()
    const first = await service.process(msg('STOP'))
    expect(first).toMatchObject({ duplicate: false, decision: { kind: 'opt_out' } })
    expect(await optouts.findActive('+17865550151')).toMatchObject({ keyword: 'STOP', source: 'keyword' })
    expect(calls).toEqual(['reply:opt_out_confirm:+17865550151', 'store:cust-1:false'])

    calls.length = 0
    await service.process({ ...msg('STOP'), providerMessageId: 'in-2', eventId: 'evt-2' })
    expect(calls).toEqual(['store:cust-1:false'])
  })

  it('START after STOP clears the opt-out', async () => {
    const { service, optouts } = setup()
    await service.process(msg('STOP'))
    await service.process({ ...msg('START'), providerMessageId: 'in-2' })
    expect(await optouts.findActive('+17865550151')).toBeNull()
  })

  it('is idempotent on (device, provider message id): a replayed text does nothing twice', async () => {
    const { service, calls } = setup()
    await service.process(msg('C'))
    const n = calls.length
    expect(await service.process(msg('C'))).toEqual({ duplicate: true })
    expect(calls.length).toBe(n)
  })

  it('confirms through the effect and marks the inbox row', async () => {
    const { service, inbox, calls } = setup()
    await service.process(msg('C'))
    expect(calls).toContain('confirm:A1')
    expect(inbox.rows[0]).toMatchObject({ decision: 'confirm', quarantined: false })
    expect(inbox.rows[0]?.processedAt).not.toBeNull()
  })

  it('quarantines strangers: inbox row kept, no effects other than opt-out handling', async () => {
    const { service, inbox, calls } = setup()
    await service.process({ ...msg('Your verification code is 998877', '+13055559999'), providerMessageId: 'in-9' })
    expect(calls).toEqual([])
    expect(inbox.rows[0]).toMatchObject({ quarantined: true, decision: 'quarantined' })
  })

  it('a stranger STOP is honoured without creating anything else', async () => {
    const { service, optouts, calls } = setup()
    await service.process({ ...msg('STOP', '+13055559999'), providerMessageId: 'in-10' })
    expect(await optouts.findActive('+13055559999')).not.toBeNull()
    expect(calls).toEqual(['reply:opt_out_confirm:+13055559999'])
  })

  it('handleReceived adapts the port event', async () => {
    const { service } = setup()
    const out = await service.handleReceived({ kind: 'received', eventId: 'e1', from: '+17865550151', body: 'hello', at: now, deviceId: 'dev-1', providerMessageId: 'in-5' })
    expect(out).toMatchObject({ duplicate: false, decision: { kind: 'message' } })
  })
})
