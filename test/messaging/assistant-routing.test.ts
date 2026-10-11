// The inbound router and service with the AI assistant's gate (ADR 0160, design section 3), pure and in memory: with the gate off
// every text routes exactly as before; with it on, keywords keep priority, AGENT is a handoff, codes are never filed readable and
// plain texts go to the assistant.
import { describe, expect, it } from 'vitest'
import { FixedClock } from '../../src/platform/clock.js'
import { GATE_OFF, type AssistantGateVerdict } from '../../src/modules/assistant/ports.js'
import type { AppointmentRef } from '../../src/modules/messaging/inbound/attribution.js'
import { CODE_MASK, parseKeyword, parseReplyCode } from '../../src/modules/messaging/inbound/keywords.js'
import { InMemoryCustomerDirectory, InMemoryInboxRepository } from '../../src/modules/messaging/inbound/repositories.js'
import { CODE_REPLY_TEMPLATE, routeInbound, type InboundCommand, type InboundContext, type InboundText } from '../../src/modules/messaging/inbound/router.js'
import { InboundService, type InboundAssistant, type InboundEffects } from '../../src/modules/messaging/inbound/service.js'
import { InMemoryOptOutRepository } from '../../src/modules/messaging/policy/optouts.js'
import { TEMPLATES } from '../../src/modules/messaging/templates/registry.js'

const now = new Date('2026-06-13T10:36:00-04:00')
const h = (n: number): Date => new Date(now.getTime() + n * 3600_000)
const appt = (id: string, status: AppointmentRef['status'], start: Date): AppointmentRef => ({ id, status, start })

const msg = (body: string, o: Partial<InboundText> = {}): InboundText => ({
  eventId: 'evt-1',
  deviceId: 'dev-1',
  providerMessageId: 'in-1',
  from: '+17865550151',
  body,
  receivedAt: now,
  ...o,
})
const known = { id: 'cust-1', firstName: 'Liam' }
const ctx = (over: Partial<InboundContext> = {}): InboundContext => ({ now, customer: known, optedOut: false, appointments: [], timeZone: 'America/New_York', ...over })
const ALLOW: AssistantGateVerdict = { active: true, allow: true, reason: null }
const PAUSED: AssistantGateVerdict = { active: true, allow: false, reason: 'thread_paused' }
const types = (cmds: InboundCommand[]): string[] => cmds.map((c) => c.type)
const replyOf = (cmds: InboundCommand[]): string | undefined => cmds.find((c): c is Extract<InboundCommand, { type: 'send_reply' }> => c.type === 'send_reply')?.template

describe('parseKeyword AGENT and parseReplyCode', () => {
  it.each(['AGENT', 'agent', ' Agent. ', 'AGENT!'])('%j is AGENT', (body) => expect(parseKeyword(body).kind).toBe('agent'))
  it.each(['an agent please', 'agents', 'AGENT STOP'])('%j is not AGENT', (body) => expect(parseKeyword(body).kind).not.toBe('agent'))

  it.each([
    ['4821', '4821'],
    [' 4821. ', '4821'],
    ['48 21', '4821'],
    ['4821-09', '482109'],
    ['12345678', '12345678'],
    [`48${String.fromCodePoint(0x200b)}21`, '4821'],
    ['４８２１', '4821'],
  ])('%j is the code %s', (body, code) => expect(parseReplyCode(body)).toBe(code))

  it.each(['123', '123456789', '40.00', '4821 ok', 'code 4821', '862-388-5827', '', 'C', '$40'])('%j is not a code', (body) => expect(parseReplyCode(body)).toBeNull())

  it('the canned code reply is an AI answer, never readable digits', () => {
    expect(TEMPLATES[CODE_REPLY_TEMPLATE]).toMatchObject({ klass: 'ai_reply', required: [], editable: false })
    expect(TEMPLATES[CODE_REPLY_TEMPLATE].body).not.toMatch(/\d/)
  })
})

describe('with the gate off every text routes exactly as before', () => {
  const booked = [appt('A1', 'booked', h(20))]
  const bodies = ['STOP', 'START', 'YES', 'HELP', 'C', 'CANCEL', 'AGENT', 'agent', '4821', '123456', 'hello there', 'Running late']
  const contexts: Array<Partial<InboundContext>> = [{}, { appointments: booked }, { customer: null }, { optedOut: true }]
  const senders = ['+17865550151', '32665', 'AMAZON', '+447700900123']

  it('the verdict GATE_OFF (and pendingAction false) changes no decision', () => {
    for (const body of bodies)
      for (const c of contexts)
        for (const from of senders) {
          const before = routeInbound(msg(body, { from }), ctx(c))
          expect(routeInbound(msg(body, { from }), ctx({ ...c, assistant: GATE_OFF, pendingAction: false }))).toEqual(before)
          expect(before.redacted).toBeUndefined()
        }
  })

  it('AGENT while the assistant does not serve the number is an ordinary message', () => {
    const d = routeInbound(msg('AGENT'), ctx({ assistant: GATE_OFF }))
    expect(d.kind).toBe('message')
    expect(types(d.commands)).toEqual(['store_message', 'staff_alert'])
  })

  it('a picture message routes as before even when the gate allows', () => {
    const pic = msg('[Picture message]', { kind: 'mms', placeholder: 'picture' })
    expect(routeInbound(pic, ctx({ assistant: ALLOW }))).toEqual(routeInbound(pic, ctx()))
    expect(routeInbound(pic, ctx({ customer: null, assistant: ALLOW }))).toEqual(routeInbound(pic, ctx({ customer: null })))
  })
})

describe('with the gate allowing', () => {
  it('keywords keep priority', () => {
    for (const [body, c] of [
      ['STOP', {}],
      ['START', { optedOut: true }],
      ['YES', { optedOut: true }],
      ['HELP', {}],
      ['C', { appointments: [appt('A1', 'booked', h(20))] }],
      ['C', {}],
      ['CANCEL', { appointments: [appt('A1', 'booked', h(20))] }],
      ['STOP', { customer: null }],
      ['HELP', { customer: null }],
    ] as Array<[string, Partial<InboundContext>]>)
      expect(routeInbound(msg(body), ctx({ ...c, assistant: ALLOW }))).toEqual(routeInbound(msg(body), ctx(c)))
  })

  it('a client\'s plain text goes to the assistant, filed read (no new-reply alert)', () => {
    const d = routeInbound(msg('Do you do ceramic coating?'), ctx({ assistant: ALLOW, appointments: [appt('A1', 'confirmed', h(5))] }))
    expect(d.kind).toBe('assistant')
    expect(d.commands).toEqual([
      { type: 'store_message', customerId: 'cust-1', appointmentId: 'A1', unread: false },
      { type: 'assistant', phone: '+17865550151', customerId: 'cust-1' },
    ])
  })

  it('an MMS text goes to the assistant like an SMS', () => {
    const d = routeInbound(msg('ok see you then', { kind: 'mms' }), ctx({ assistant: ALLOW }))
    expect(d.kind).toBe('assistant')
  })

  it('a YES with nothing to confirm is a plain text for the assistant', () => {
    expect(routeInbound(msg('YES'), ctx({ assistant: ALLOW })).kind).toBe('assistant')
  })

  it("a stranger's text goes to the assistant and is not quarantined", () => {
    const d = routeInbound(msg('How much is a wash?'), ctx({ customer: null, assistant: ALLOW }))
    expect(d.kind).toBe('assistant')
    expect(d.commands).toEqual([{ type: 'assistant', phone: '+17865550151', customerId: null }])
  })

  it('a non-E.164 sender is still quarantined', () => {
    for (const from of ['32665', 'AMAZON']) {
      const d = routeInbound(msg('Your code is 123456', { from }), ctx({ customer: null, assistant: ALLOW }))
      expect(d.kind).toBe('quarantined')
      expect(types(d.commands)).toEqual(['quarantine'])
    }
  })

  it('a code with no pending action is filed as [code] and answered with the link-page line, never sent to the AI', () => {
    const d = routeInbound(msg('4821'), ctx({ assistant: ALLOW, pendingAction: false }))
    expect(d).toMatchObject({ kind: 'message', redacted: true })
    expect(types(d.commands)).toEqual(['store_message', 'send_reply'])
    expect(replyOf(d.commands)).toBe(CODE_REPLY_TEMPLATE)
    expect(d.commands.find((c) => c.type === 'store_message')).toMatchObject({ unread: false })

    const s = routeInbound(msg('4821'), ctx({ customer: null, assistant: ALLOW }))
    expect(s).toMatchObject({ kind: 'quarantined', redacted: true })
    expect(types(s.commands)).toEqual(['quarantine', 'send_reply'])
  })
})

describe('AGENT', () => {
  it('is a handoff while the assistant serves the number, paused or not', () => {
    for (const gate of [ALLOW, PAUSED, { active: true, allow: false, reason: 'handoff_open' } as AssistantGateVerdict]) {
      const d = routeInbound(msg('agent'), ctx({ assistant: gate, appointments: [appt('A1', 'confirmed', h(5))] }))
      expect(d.kind).toBe('handoff')
      expect(d.commands).toEqual([
        { type: 'handoff', phone: '+17865550151', customerId: 'cust-1', reason: 'agent_keyword' },
        { type: 'store_message', customerId: 'cust-1', appointmentId: 'A1', unread: true },
        { type: 'staff_alert', kind: 'ai_handoff', customerId: 'cust-1', appointmentId: 'A1', excerpt: 'agent', sender: '+17865550151' },
      ])
    }
  })

  it('from a stranger: handoff, kept for review, staff alerted', () => {
    const d = routeInbound(msg('AGENT'), ctx({ customer: null, assistant: ALLOW }))
    expect(d.kind).toBe('handoff')
    expect(types(d.commands)).toEqual(['handoff', 'quarantine', 'staff_alert'])
  })

  it('STOP still beats everything', () => {
    expect(routeInbound(msg('STOP'), ctx({ assistant: ALLOW })).kind).toBe('opt_out')
  })
})

describe('reply numbers', () => {
  it('a code while an action waits is an action_code, filed redacted and read, the model never involved', () => {
    for (const gate of [ALLOW, PAUSED, GATE_OFF]) {
      const d = routeInbound(msg(' 4821 '), ctx({ assistant: gate, pendingAction: true }))
      expect(d).toMatchObject({ kind: 'action_code', redacted: true })
      expect(d.commands).toEqual([
        { type: 'action_code', phone: '+17865550151', customerId: 'cust-1', code: '4821' },
        { type: 'store_message', customerId: 'cust-1', appointmentId: null, unread: false },
      ])
    }
  })

  it('text around the digits makes it a message', () => {
    expect(routeInbound(msg('4821 thanks'), ctx({ assistant: ALLOW, pendingAction: true })).kind).toBe('assistant')
  })
})

// ---- the service -----------------------------------------------------------------------------------------------------

function harness(o: { gate?: AssistantGateVerdict; pending?: boolean; assistant?: boolean } = {}) {
  const inbox = new InMemoryInboxRepository()
  const directory = new InMemoryCustomerDirectory()
  directory.add('+17865550151', { id: 'cust-1', firstName: 'Liam' })
  const calls: Array<{ kind: string; arg: unknown }> = []
  const gateInputs: unknown[] = []
  const effects: InboundEffects = {
    sendReply: async (to, template) => void calls.push({ kind: 'reply', arg: { to, template } }),
    confirmAppointment: async () => undefined,
    storeMessage: async (m) => void calls.push({ kind: 'store', arg: m }),
    staffAlert: async (a) => void calls.push({ kind: 'alert', arg: a }),
    assistant: async (c) => {
      calls.push({ kind: 'assistant', arg: c })
      return { conversationId: 'conv-1' }
    },
    handoff: async (c) => void calls.push({ kind: 'handoff', arg: c }),
    actionCode: async (c) => void calls.push({ kind: 'action_code', arg: c }),
  }
  const assistant: InboundAssistant = {
    gate: async (input) => {
      gateInputs.push(input)
      return o.gate ?? ALLOW
    },
    hasPendingAction: async () => o.pending ?? false,
  }
  const svc = new InboundService(inbox, new InMemoryOptOutRepository(), directory, effects, new FixedClock(now), {
    timeZone: 'America/New_York',
    ...(o.assistant === false ? {} : { assistant }),
  })
  return { svc, inbox, calls, gateInputs }
}

describe('InboundService with the assistant', () => {
  it('hands the text to the assistant and returns the conversation to kick', async () => {
    const { svc, inbox, calls, gateInputs } = harness()
    const out = await svc.handleReceived({ kind: 'received', eventId: 'e1', from: '+17865550151', body: 'hi there', at: now, deviceId: 'dev-1', providerMessageId: 'm1' }, { to: '+18623885827' })
    expect(out).toMatchObject({ duplicate: false, decision: { kind: 'assistant' }, assistantConversations: ['conv-1'] })
    expect(gateInputs).toEqual([{ from: '+17865550151', phone: '+17865550151', customerId: 'cust-1', optedOut: false, body: 'hi there', to: '+18623885827' }])
    expect(calls.map((c) => c.kind)).toEqual(['store', 'assistant'])
    expect(calls[1]!.arg).toEqual({ phone: '+17865550151', customerId: 'cust-1', inboxId: inbox.rows[0]!.id, receivedAt: now })
    expect(inbox.rows[0]).toMatchObject({ decision: 'assistant', quarantined: false, body: 'hi there' })
  })

  it('files a code as [code] everywhere and hands the digits only to the reply-number handler', async () => {
    const { svc, inbox, calls } = harness({ pending: true })
    const out = await svc.process(msg('4821'))
    expect(out).toMatchObject({ decision: { kind: 'action_code', redacted: true }, assistantConversations: [] })
    expect(inbox.rows[0]!.body).toBe(CODE_MASK)
    expect(calls).toEqual([
      { kind: 'action_code', arg: { phone: '+17865550151', customerId: 'cust-1', inboxId: inbox.rows[0]!.id, code: '4821' } },
      { kind: 'store', arg: expect.objectContaining({ body: CODE_MASK, unread: false }) },
    ])
    expect(JSON.stringify(calls.filter((c) => c.kind !== 'action_code'))).not.toContain('4821')
  })

  it('a code with nothing pending is redacted and answered', async () => {
    const { svc, inbox, calls } = harness({ pending: false })
    await svc.process(msg('9137'))
    expect(inbox.rows[0]!.body).toBe(CODE_MASK)
    expect(calls.map((c) => c.kind)).toEqual(['store', 'reply'])
    expect(JSON.stringify(calls)).not.toContain('9137')
  })

  it('without an assistant wired the code is filed as it was (the assistant never ran)', async () => {
    const { svc, inbox, calls } = harness({ assistant: false })
    await svc.process(msg('9137'))
    expect(inbox.rows[0]!.body).toBe('9137')
    expect(calls.map((c) => c.kind)).toEqual(['store', 'alert'])
  })

  it('AGENT opens a handoff and alerts', async () => {
    const { svc, calls } = harness({ gate: PAUSED })
    const out = await svc.process(msg('AGENT'))
    expect(out).toMatchObject({ decision: { kind: 'handoff' }, assistantConversations: [] })
    expect(calls.map((c) => c.kind)).toEqual(['handoff', 'store', 'alert'])
    expect(calls[2]!.arg).toMatchObject({ kind: 'ai_handoff', customerId: 'cust-1' })
  })
})
