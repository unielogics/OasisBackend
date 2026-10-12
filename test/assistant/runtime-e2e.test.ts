// The W3 seams, end to end through the REAL assistant runtime (ADR 0160, design sections 3, 3b, 3c, 4 and 6): texts through the SMS
// Gate webhook into the real gate, the welcome flow (NewTexters.adopt), the conversation marker and AssistantRuntime.respond; the
// real tool registry (createToolRegistry), the real shop facts (buildShopFacts over the website catalog), the output guard v4 and the
// policy judge, the real reply-number handler (ActionCodeHandler), the leads and their follow-up job, the status texts. Only the
// model is simulated: a SimAiProvider scripts the assistant and a second one scripts the judge. W3a's suites ran the turn with
// contract stubs and W3b's suites ran the tools without the turn: these conversations are where the two meet.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { runSeed } from '../../db/seeds/index.js'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { DEFAULT_SIM_VERDICT, POLICY_JUDGE_HEADER, SimAiProvider, simText, simToolUse, type SimResponder, type SimStep } from '../../src/integrations/ai/sim.js'
import type { AiContentBlock, AiConverseRequest, AiJson } from '../../src/integrations/ports/ai.js'
import { placeholderValues } from '../../src/modules/assistant/facts.js'
import { SAFETY_LINE } from '../../src/modules/assistant/guard.js'
import { TRUSTED_CLOSE, TRUSTED_OPEN } from '../../src/modules/assistant/judge.js'
import { INTAKE_LINES } from '../../src/modules/assistant/prompt.js'
import { AssistantRuntime } from '../../src/modules/assistant/runtime.js'
import { grantTrust } from '../../src/modules/identity/trust.js'
import { runLeadFollowUps } from '../../src/modules/leads/follow-up.js'
import type { Actor, SchedulingCtx } from '../../src/modules/scheduling/context.js'
import { arriveAppointment, completeAppointment, startCleaning } from '../../src/modules/scheduling/lifecycle.js'
import type { Tx } from '../../src/platform/db.js'
import { NIL_UUID } from '../../src/platform/ids.js'
import { STRANGER, useWorld } from '../messaging-db/world.js'

const w = useWorld({
  env: {
    AI_ENABLED: 'true',
    AI_ACTIONS_ENABLED: 'true',
    PUBLIC_LINKS_ENABLED: 'true',
    PIN_PEPPER: Buffer.alloc(32, 7).toString('base64'),
    PUBLIC_SITE_URL: 'https://oasisautospanj.com',
    BUSINESS_PHONE: '+12015986304',
    BUSINESS_TEXT_NUMBER: '+18623885827',
  },
})
/** A number of the SMS allowlist that no seeded client has: the new texter of the welcome flow. */
const NEWCOMER = '+13055550198'
const MONDAY = '2026-06-15'
const TEN_AM = 600

beforeAll(async () => {
  // the website's catalog: Signature Hand Wash, tint by the matrix (sedan/suv/truck x carbon/ceramic), Gold and VIP
  await runSeed({ db: w.t.db, clock: w.clock, profile: 'website-catalog' })
})

beforeEach(async () => {
  await sql`truncate table assistant_conversations, leads, assistant_pending_actions, client_link_sessions, client_links, phone_trust, customer_pins cascade`.execute(w.t.db)
  await sql`delete from settings where key like 'assistant.%' or key like 'leads.%' or key like 'status_texts.%' or key = 'booking.guest_fee'`.execute(w.t.db)
  await sql`delete from vehicles where customer_id in (select id from customers where source = 'inbound_sms')`.execute(w.t.db)
  await sql`delete from customers where source = 'inbound_sms'`.execute(w.t.db)
  await sql`delete from vehicles where created_at > ${new Date(w.clock.now().getTime() - 60_000)} and plate is null`.execute(w.t.db)
  await sql`update customers set full_name = 'Maria Delgado', sms_opted_out_at = null where id = ${w.customer('Maria Delgado').id}`.execute(w.t.db)
  await setting('assistant.enabled', true)
  await setting('assistant.stage', 'everyone')
})

async function setting(key: string, value: unknown): Promise<void> {
  await sql`insert into settings (location_id, key, value) values (${w.locationId}, ${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (location_id, key) do update set value = excluded.value, version = settings.version + 1`.execute(w.t.db)
}

let n = 0
async function inbound(from: string, text: string): Promise<void> {
  n += 1
  const ev = w.signed('sms:received', { messageId: `e2e-in-${n}`, sender: from, recipient: '+18623885827', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
}

const maria = (): string => w.customer('Maria Delgado').phone
const conversationOf = (phone: string) => w.t.db.selectFrom('assistant_conversations').selectAll().where('phone_e164', '=', phone).executeTakeFirst()
const outTexts = (phone: string) =>
  w.t.db
    .selectFrom('messages')
    .select(['id', 'body', 'klass', 'sender_kind', 'template_key', 'appointment_id'])
    .where('peer_e164', '=', phone)
    .where('direction', '=', 'out')
    .orderBy('queued_at')
    .orderBy('id')
    .execute()
const outboxOf = (messageId: string) => w.t.db.selectFrom('sms_outbox').select(['body', 'klass']).where('message_id', '=', messageId).executeTakeFirstOrThrow()
const handoffAlerts = () => w.t.db.selectFrom('notifications').select(['kind', 'title', 'body', 'source_ref']).where('kind', '=', 'assistant.handoff').execute()
const contextOf = (r: AiConverseRequest): string => r.system[2]!.text
const toolCalls = () => w.t.db.selectFrom('assistant_tool_calls').select(['tool', 'outcome', 'error']).orderBy('turn_id').orderBy('seq').execute()

/** Every tool result the model read in a request, by tool use id. */
function toolResultsOf(req: AiConverseRequest): Record<string, AiJson> {
  const out: Record<string, AiJson> = {}
  for (const m of req.messages)
    for (const b of m.content as AiContentBlock[]) if (b.type === 'toolResult') for (const c of b.content) if (c.type === 'json') out[b.toolUseId] = c.json
  return out
}

/** A judge that passes every reply (and fails the test if anything but the judge's rubric reaches it). */
const passAll: SimResponder = (req) => {
  if (!req.system[0]?.text.startsWith(POLICY_JUDGE_HEADER)) throw new Error('the judge got a request without its rubric')
  return simText(DEFAULT_SIM_VERDICT)
}

type Step = SimStep | ((req: AiConverseRequest) => SimStep)

/** The assistant over the real runtime: the real registry, facts, gate, welcome flow and reply-number handler; the model scripted. */
function assistant(steps: Step[], judge: SimStep[] | SimResponder = passAll) {
  const provider = new SimAiProvider((req, i) => {
    const s = steps[i]
    if (s === undefined) throw new Error(`the assistant script has no step ${i}`)
    return typeof s === 'function' ? s(req) : s
  })
  const judgeProvider = new SimAiProvider(judge)
  const enqueued: Array<{ name: string; data: object }> = []
  const rt = new AssistantRuntime({
    db: w.t.db,
    clock: w.clock,
    newId: w.newId,
    env: w.env,
    messaging: w.rt,
    provider,
    judgeProvider,
    enqueue: async (name, data) => {
      enqueued.push({ name, data })
      return 'job'
    },
    // answer at once (the job's 8-second debounce is the jobs suite's)
    cfg: { debounceMs: 0 },
  })
  // the server's wiring (src/server.ts wireAssistant): the gate, the kick, the welcome flow and the reply-number handler
  w.rt.useAssistant(rt.ports())
  const respond = async (phone: string) => {
    const c = await conversationOf(phone)
    return c ? rt.respond(c.id) : { status: 'none' as const }
  }
  const facts = () => rt.deps.facts.get(w.locationId)
  return { rt, provider, judge: judgeProvider, enqueued, respond, facts, steps }
}

describe('seam 1: prices reach the model only as placeholders, and every placeholder a tool hands out renders', () => {
  it('a price question: list_services gives priceKeys (no amount), the model writes them, the server renders the facts wording', async () => {
    const a = assistant([simToolUse('list_services', { category: 'tint' }), simText('{price:tint:suv:carbon}. {price:tint:suv:ceramic}. The team confirms the exact price at the shop.')])
    await inbound(maria(), 'How much is window tint for my SUV?')
    expect(await a.respond(maria())).toMatchObject({ status: 'replied' })
    // the tool result the model read: placeholders, no cents, no dollar sign
    const result = JSON.stringify(toolResultsOf(a.provider.requests[1]!))
    expect(result).toContain('"priceKey":"{price:tint:suv:carbon}"')
    expect(result).toContain('"priceKey":"{price:ceramic-window-tint}"')
    expect(result).not.toMatch(/Cents|\$\d/)
    const values = placeholderValues(await a.facts())
    const [reply] = await outTexts(maria())
    expect(reply!.body).toContain(`${values.get('{price:tint:suv:carbon}')}. ${values.get('{price:tint:suv:ceramic}')}.`)
    expect(reply!.body).toMatch(/Carbon tint for an SUV\/crossover starts at \$269 for members, \$\d+(\.\d\d)? otherwise\./)
    // one model call per step: no rewrite was needed
    expect(a.provider.requests).toHaveLength(2)
    // the judge read the rendered price as the server's own segment
    expect(a.judge.requests).toHaveLength(1)
    expect(JSON.stringify(a.judge.requests[0]!.messages)).toContain(`${TRUSTED_OPEN}${values.get('{price:tint:suv:carbon}')}${TRUSTED_CLOSE}`)
  })

  it('a membership question: get_membership_info gives {plan:<tier>}, rendered "Gold is $99 a month"', async () => {
    const a = assistant([simToolUse('get_membership_info', {}), simText('{plan:gold}. {plan:vip}. Want me to text you a link to join?')])
    await inbound(maria(), 'What do the memberships cost?')
    expect(await a.respond(maria())).toMatchObject({ status: 'replied' })
    const result = JSON.stringify(toolResultsOf(a.provider.requests[1]!))
    expect(result).toContain('"priceKey":"{plan:gold}"')
    expect(result).not.toMatch(/Cents|\$\d/)
    expect((await outTexts(maria()))[0]!.body).toContain('Gold is $99 a month. VIP is $169 a month. Want me to text you a link to join?')
  })

  it('every placeholder list_services, get_membership_info, get_business_info, get_balance and set_my_vehicle hand out is one placeholderValues renders', async () => {
    const handedOut = new Set<string>()
    const collect = (req: AiConverseRequest): SimStep => {
      for (const m of JSON.stringify(toolResultsOf(req)).matchAll(/\{(?:price|plan|fee|balance)[^{}"]*\}/g)) handedOut.add(m[0])
      return simText('{fee}. {balance}. {price:signature-hand-wash}.')
    }
    const a = assistant([
      simToolUse('list_services', { category: null }),
      simToolUse('get_membership_info', {}),
      simToolUse('get_business_info', { topic: 'fee' }),
      { content: [
        { type: 'toolUse', id: 'b', name: 'get_balance', input: {} },
        { type: 'toolUse', id: 'v', name: 'set_my_vehicle', input: { type: 'truck_van', make: 'Ford', model: 'Transit', year: null, color: null } },
      ] },
      collect,
    ])
    await inbound(maria(), 'Prices for everything please, and what do I owe?')
    expect(await a.respond(maria())).toMatchObject({ status: 'replied' })
    const facts = await a.facts()
    const values = placeholderValues(facts, { balanceCents: 0 })
    // every catalog item, every tint row, every plan, the fee and the balance were handed out ...
    const expected = [...values.keys()]
    expect([...handedOut].sort()).toEqual(expected.sort())
    // ... and set_my_vehicle named the tint prices of its class (the matrix keys its vehicles "truck", the class is truck_van)
    const vehicle = toolResultsOf(a.provider.requests.at(-1)!)['v'] as { tintClass: string; tintPriceKeys: { priceKey: string }[] }
    expect(vehicle.tintClass).toBe('Truck / Van')
    expect(vehicle.tintPriceKeys.map((k) => k.priceKey)).toEqual(['{price:tint:truck:carbon}', '{price:tint:truck:ceramic}'])
    const body = (await outTexts(maria()))[0]!.body
    expect(body).toContain(`Guests pay a $25 booking fee. Your open balance is $0. ${values.get('{price:signature-hand-wash}')}.`)
    expect(JSON.stringify(a.provider.requests)).not.toMatch(/Cents/)
  })
})

describe('the welcome flow, verification and an in-chat booking, one conversation (owner 2026-10-11)', () => {
  it('a stranger is adopted at the first text, gives name, intent and vehicle, sees the plans, verifies, books by reply number; the lead closes', async () => {
    await setting('assistant.actions_enabled', true)
    const a = assistant([
      // turn 1: "Hi! How much is a wash?"
      simToolUse('list_services', { category: 'wash' }),
      simText('Hi! {price:signature-hand-wash}. What is your first name?'),
      // turn 2: "I'm Ana Lopez"
      simToolUse('set_my_name', { fullName: 'Ana Lopez' }),
      simText('Nice to meet you, Ana! Are you after a wash, window tint, detailing, or just info?'),
      // turn 3: "A wash, I want to book one"
      simToolUse('note_interest', { categories: ['wash'] }),
      simToolUse('get_membership_info', {}),
      simText('Great! Before your first visit: {plan:gold}. {plan:vip}. Would one of them interest you?'),
      // turn 4: "Not now"
      simText('No problem. What do you drive: a sedan or coupe, an SUV or crossover, or a truck or van, and which make and model?'),
      // turn 5: "An SUV, a Honda CR-V. Monday morning?"
      simToolUse('set_my_vehicle', { type: 'suv_crossover', make: 'Honda', model: 'CR-V', year: null, color: null }),
      simToolUse('check_availability', { serviceKey: 'signature-hand-wash', date: MONDAY, partOfDay: 'morning' }),
      simToolUse('propose_booking', { serviceKey: 'signature-hand-wash', addonKeys: [], date: MONDAY, startMin: TEN_AM, vehicle: 'the CR-V' }),
      simToolUse('send_link', { kind: 'verify', appointmentRef: null, tier: null }),
      simText('Monday morning has openings, 10:00 AM included. First, please confirm it is you here: {link1}'),
      // turn 6 (verified on the link page): "Done. Monday 10 please"
      simToolUse('propose_booking', { serviceKey: 'signature-hand-wash', addonKeys: [], date: MONDAY, startMin: TEN_AM, vehicle: 'the CR-V' }),
      (req) => {
        const result = JSON.stringify(toolResultsOf(req))
        // the tool tells the model to point at the server's text, never to ask for a number (the judge would fail that)
        expect(result).toContain('"confirmationTexted":true')
        expect(result).not.toMatch(/reply with (that|the) number/i)
        return simText('I just texted you the details: confirm with that text.')
      },
    ])
    const intakes: string[] = []
    const turn = async (text: string) => {
      w.clock.advance(70_000)
      await inbound(NEWCOMER, text)
      const before = a.provider.requests.length
      const r = await a.respond(NEWCOMER)
      intakes.push(/Intake: (.*)\.$/m.exec(contextOf(a.provider.requests[before]!))?.[1] ?? 'none')
      return r
    }

    // ---- the first text: the provisional client and the lead exist before the turn runs (the webhook's transaction)
    await inbound(NEWCOMER, 'Hi! How much is a wash?')
    const client = await w.t.db.selectFrom('customers').select(['id', 'full_name', 'source', 'needs_details', 'sms_opt_in_source']).where('phone_e164', '=', NEWCOMER).executeTakeFirstOrThrow()
    expect(client).toMatchObject({ full_name: 'New texter ••0198', source: 'inbound_sms', needs_details: true, sms_opt_in_source: 'inbound_text' })
    expect(await w.t.db.selectFrom('leads').select(['customer_id', 'status', 'source']).where('phone_e164', '=', NEWCOMER).executeTakeFirstOrThrow()).toEqual({
      customer_id: client.id,
      status: 'new',
      source: 'text',
    })
    expect((await conversationOf(NEWCOMER))!.customer_id).toBe(client.id)
    expect(await a.respond(NEWCOMER)).toMatchObject({ status: 'replied' })
    expect(contextOf(a.provider.requests[0]!)).toContain('Client: new client, name unknown, first contact.')
    intakes.push(/Intake: (.*)\.$/m.exec(contextOf(a.provider.requests[0]!))![1]!)
    const values = placeholderValues(await a.facts())
    const [first] = await outTexts(NEWCOMER)
    expect(first).toMatchObject({ sender_kind: 'ai', klass: 'ai_reply' })
    expect(first!.body).toBe(`Oasis Auto Spa's automated assistant here. Hi! ${values.get('{price:signature-hand-wash}')}. What is your first name? Reply STOP to opt out.`)

    expect(await turn('I’m Ana Lopez')).toMatchObject({ status: 'replied' })
    expect(await w.t.db.selectFrom('customers').select(['full_name', 'needs_details']).where('id', '=', client.id).executeTakeFirstOrThrow()).toEqual({ full_name: 'Ana Lopez', needs_details: false })
    expect(await turn('A wash, I want to book one')).toMatchObject({ status: 'replied' })
    expect((await w.t.db.selectFrom('leads').select('interests').where('phone_e164', '=', NEWCOMER).executeTakeFirstOrThrow()).interests).toEqual(['wash'])
    expect(await turn('Not now')).toMatchObject({ status: 'replied' })
    expect(contextOf(a.provider.requests.at(-1)!)).toContain('Client: a client on file, first name "Ana".')

    // ---- untrusted: the booking ask needs a verify link; the reply carries {link1} as a secret and the server's safety line
    expect(await turn('An SUV, a Honda CR-V. Can I come Monday morning?')).toMatchObject({ status: 'replied' })
    expect(await w.t.db.selectFrom('vehicles').select(['make', 'model', 'vehicle_type']).where('customer_id', '=', client.id).execute()).toEqual([
      { make: 'Honda', model: 'CR-V', vehicle_type: 'suv_crossover' },
    ])
    const availability = JSON.stringify(toolResultsOf(a.provider.requests.at(-1)!))
    expect(availability).toContain(`"startMin":${TEN_AM}`)
    expect(availability).toContain('"error":"needs_verification"')
    const verify = (await outTexts(NEWCOMER)).at(-1)!
    expect(verify.klass).toBe('personal_link')
    expect(verify.body).toContain('[private link]')
    expect(verify.body.endsWith(SAFETY_LINE)).toBe(true)
    expect((await outboxOf(verify.id)).body).toMatch(/https:\/\/oasisautospanj\.com\/#\/v\/[A-Za-z0-9_-]{20,}/)
    expect(JSON.stringify(a.provider.requests)).not.toMatch(/#\/v\//)
    expect(await w.t.db.selectFrom('client_links').select(['kind', 'customer_id', 'issued_by']).execute()).toEqual([{ kind: 'verify', customer_id: client.id, issued_by: 'assistant' }])

    // ---- verified on the link page (the link API grants the 30-day trust)
    await w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone: NEWCOMER, customerId: client.id, verifiedBy: 'code', now: w.clock.now() }))
    expect(await turn('Done. Monday at 10 please')).toMatchObject({ status: 'replied' })
    expect(contextOf(a.provider.requests.at(-2)!)).toContain('In-chat booking: on')
    expect(intakes).toEqual([INTAKE_LINES.name, INTAKE_LINES.name, INTAKE_LINES.intent, INTAKE_LINES.vehicle, INTAKE_LINES.vehicle, 'none'])
    const confirm = (await outTexts(NEWCOMER)).find((m) => m.klass === 'action_confirm')!
    expect(confirm.body).toBe('Signature Hand Wash, Mon Jun 15 at 10:00 AM. Reply [code] to confirm.')
    const code = /Reply (\d{4}) to confirm/.exec((await outboxOf(confirm.id)).body)![1]!
    expect(JSON.stringify(a.provider.requests)).not.toContain(`Reply ${code}`)
    expect((await outTexts(NEWCOMER)).at(-1)!.body).toBe('I just texted you the details: confirm with that text.')

    // ---- the client texts the number back: the handler books before any model, the lead closes
    w.clock.advance(30_000)
    const calls = a.provider.requests.length
    await inbound(NEWCOMER, code)
    expect(a.provider.requests).toHaveLength(calls)
    const [appt] = await w.t.db.selectFrom('appointments').select(['id', 'source', 'status', 'categories', 'scheduled_start', 'created_by']).where('customer_id', '=', client.id).execute()
    // the reply number's webhook applied cleanly (the assistant's actor is no user: created_by stays empty)
    expect(await w.t.db.selectFrom('webhook_log').select(['status', 'error']).where('error', 'is not', null).execute()).toEqual([])
    expect(appt).toMatchObject({ source: 'sms_ai', status: 'booked', categories: ['wash'], scheduled_start: new Date('2026-06-15T10:00:00-04:00'), created_by: null })
    expect(await w.t.db.selectFrom('leads').select(['status', 'booked_appointment_id']).where('phone_e164', '=', NEWCOMER).executeTakeFirstOrThrow()).toEqual({
      status: 'booked',
      booked_appointment_id: appt!.id,
    })
    const booked = (await outTexts(NEWCOMER)).at(-1)!
    expect(booked).toMatchObject({ klass: 'ai_reply', sender_kind: 'ai', template_key: 'action_booked' })
    expect(booked.body).toBe("You're booked: Signature Hand Wash, Mon Jun 15 at 10:00 AM. $25 booking fee due at the shop. See you then!")
    // the digits were filed masked and never became a turn
    const inboxRow = await w.t.db.selectFrom('sms_inbox').select(['body', 'decision']).where('from_e164', '=', NEWCOMER).orderBy('received_at', 'desc').executeTakeFirstOrThrow()
    expect(inboxRow.decision).toBe('action_code')
    expect(inboxRow.body).not.toContain(code)
    expect((await conversationOf(NEWCOMER))!.pending_since).toBeNull()
    // one judge call per AI reply, every one passed; the disclosure only once
    expect(a.judge.requests).toHaveLength(6)
    expect((await outTexts(NEWCOMER)).filter((t) => t.body.includes('automated assistant'))).toHaveLength(1)
    expect((await toolCalls()).filter((c) => c.tool === 'propose_booking').map((c) => [c.outcome, c.error])).toEqual([
      ['denied', 'trust_below_trusted'],
      ['ok', null],
    ])
  })
})

describe('the untrusted ask, the handoff, the staff reply, STOP and opt-out', () => {
  it('a client on file asks to book without a verified phone: needs_verification, then a verify link with the safety line', async () => {
    await setting('assistant.actions_enabled', true)
    const a = assistant([
      simToolUse('propose_booking', { serviceKey: 'signature-hand-wash', addonKeys: [], date: MONDAY, startMin: 600, vehicle: null }),
      simToolUse('send_link', { kind: 'verify', appointmentRef: null, tier: null }),
      simText('Happy to! First confirm it is you here: {link1}'),
    ])
    await inbound(maria(), 'Book me Monday at 10 for a Signature wash')
    expect(await a.respond(maria())).toMatchObject({ status: 'replied' })
    expect(contextOf(a.provider.requests[0]!)).toContain('Verified phone: no')
    const [m] = await outTexts(maria())
    expect(m!.klass).toBe('personal_link')
    expect(m!.body).toBe(`Oasis Auto Spa's automated assistant here. Happy to! First confirm it is you here: [private link] ${SAFETY_LINE} Reply STOP to opt out.`)
    expect(await w.t.db.selectFrom('assistant_pending_actions').select('id').execute()).toEqual([])
    expect(await w.t.db.selectFrom('appointments').select('id').where('customer_id', '=', w.customer('Maria Delgado').id).execute()).toEqual([])
  })

  it('handoff_to_staff: the reply goes out, the ai_handoff alert, the AI holds back; a staff reply resolves it and pauses the AI', async () => {
    const a = assistant([
      simToolUse('handoff_to_staff', { reason: 'client_asked', summary: 'Wants to talk to someone about her membership.' }),
      simText('Sure, a team member will text you back shortly.'),
    ])
    await inbound(maria(), 'Can I talk to a real person about my membership?')
    expect(await a.respond(maria())).toMatchObject({ status: 'replied', turn: { handoff: true } })
    expect(await conversationOf(maria())).toMatchObject({ handoff_state: 'open', handoff_reason: 'client_asked', pending_since: null })
    const [alert] = await handoffAlerts()
    expect(alert).toMatchObject({ body: 'Wants to talk to someone about her membership.' })
    expect(alert!.title).toContain('Maria Delgado')
    // the next text is the team's: no marker, no turn
    w.clock.advance(60_000)
    await inbound(maria(), 'hello?')
    expect((await conversationOf(maria()))!.pending_since).toBeNull()
    expect(await a.respond(maria())).toEqual({ status: 'none' })
    // a staff reply resolves the handoff and pauses the AI on the thread (12 hours)
    await w.tx(async (tx) => {
      const t = (await w.rt.queue.target(tx, w.locationId, w.customer('Maria Delgado').id))!
      const employee = await tx.selectFrom('employees').select('id').limit(1).executeTakeFirstOrThrow()
      await w.rt.queue.enqueueFor(tx, { locationId: w.locationId, customerId: w.customer('Maria Delgado').id, recipient: t.recipient, appointmentId: null, text: 'Hi Maria, this is Sam. How can I help?', klass: 'staff_message', purpose: 'staff', senderKind: 'staff', senderEmployeeId: employee.id })
    })
    expect(await conversationOf(maria())).toMatchObject({ handoff_state: 'resolved' })
    const thread = await w.t.db.selectFrom('message_threads').select('ai_paused_until').where('customer_id', '=', w.customer('Maria Delgado').id).executeTakeFirstOrThrow()
    expect(thread.ai_paused_until).toEqual(new Date(w.clock.now().getTime() + 12 * 3600_000))
    w.clock.advance(60_000)
    await inbound(maria(), 'I want to cancel my Gold plan')
    expect((await conversationOf(maria()))!.pending_since).toBeNull()
    expect(await a.respond(maria())).toEqual({ status: 'none' })
    expect(a.provider.requests).toHaveLength(2)
    expect((await outTexts(maria())).map((t) => t.sender_kind)).toEqual(['ai', 'staff'])
  })

  it('STOP: the keyword is answered by the opt-out confirmation, never by the AI, and later texts get no reply', async () => {
    const a = assistant([simText('We are open until 6 PM.')])
    await inbound(maria(), 'STOP')
    expect((await conversationOf(maria()))?.pending_since ?? null).toBeNull()
    w.clock.advance(60_000)
    await inbound(maria(), 'what are your hours?')
    expect((await conversationOf(maria()))?.pending_since ?? null).toBeNull()
    expect(await a.respond(maria())).toEqual({ status: 'none' })
    expect(a.provider.requests).toHaveLength(0)
    const texts = await outTexts(maria())
    expect(texts.filter((t) => t.sender_kind === 'ai')).toEqual([])
    expect(texts.map((t) => t.template_key)).toEqual(['opt_out_confirm'])
  })

  it('opt_out in words: recorded like STOP with one confirmation; the turn ends there (no reply to an opted-out number, no handoff)', async () => {
    // the model does what the tool says ("Send nothing else"): it has nothing more to write
    const a = assistant([simToolUse('opt_out', {}), simText(''), simText('')])
    await inbound(maria(), 'please stop texting me')
    const r = await a.respond(maria())
    expect(r).toMatchObject({ status: 'skipped', turn: { reason: 'opted_out' } })
    expect(await w.t.db.selectFrom('sms_opt_outs').select(['phone_e164', 'source']).execute()).toEqual([{ phone_e164: maria(), source: 'keyword' }])
    expect((await outTexts(maria())).map((t) => t.template_key)).toEqual(['opt_out_confirm'])
    expect(await handoffAlerts()).toEqual([])
    expect(await conversationOf(maria())).toMatchObject({ pending_since: null, running_since: null, handoff_state: null })
    // no rewrite call, no judge call: nothing more is written to a number that just opted out
    expect(a.provider.requests).toHaveLength(1)
    expect(a.judge.requests).toHaveLength(0)
    w.clock.advance(60_000)
    await inbound(maria(), 'actually what time do you close?')
    expect(await a.respond(maria())).toEqual({ status: 'none' })
  })
})

describe('the lead follow-up job and the status texts next to the assistant', () => {
  it('a stranger who asked about tint and did not book gets ONE follow-up with a calendar link; never after STOP', async () => {
    const a = assistant([simToolUse('note_interest', { categories: ['tint'] }), simText('Tint takes about 3 hours. What is your first name?')])
    await inbound(STRANGER, 'do you do window tint?')
    expect(await a.respond(STRANGER)).toMatchObject({ status: 'replied' })
    const deps = { db: w.t.db, clock: w.clock, newId: w.newId, env: w.env, queue: w.rt.queue, log: { info: () => undefined, warn: () => undefined, error: () => undefined } }
    expect(await runLeadFollowUps(deps)).toMatchObject({ sent: 0 })
    w.clock.advance(181 * 60_000)
    expect(await runLeadFollowUps(deps)).toMatchObject({ sent: 1 })
    expect(await runLeadFollowUps(deps)).toMatchObject({ sent: 0 })
    const followUp = (await outTexts(STRANGER)).filter((t) => t.template_key === 'lead_follow_up')
    expect(followUp).toHaveLength(1)
    expect(followUp[0]!.body).toContain('about window tint')
    expect(followUp[0]!.body).toContain('[private link]')
    expect((await outboxOf(followUp[0]!.id)).body).toMatch(/https:\/\/oasisautospanj\.com\/#\/c\//)
    expect(await w.t.db.selectFrom('leads').select('status').where('phone_e164', '=', STRANGER).executeTakeFirstOrThrow()).toEqual({ status: 'followed_up' })

    // a second stranger stops before the follow-up is due: nothing goes
    const b = assistant([simToolUse('note_interest', { categories: ['detail'] }), simText('Detailing takes most of a day. What is your first name?')])
    await inbound(NEWCOMER, 'how long is a detail?')
    expect(await b.respond(NEWCOMER)).toMatchObject({ status: 'replied' })
    w.clock.advance(60_000)
    await inbound(NEWCOMER, 'STOP')
    w.clock.advance(181 * 60_000)
    await runLeadFollowUps(deps)
    expect((await outTexts(NEWCOMER)).filter((t) => t.template_key === 'lead_follow_up')).toEqual([])
  })

  it('status texts go as before for a client the assistant serves, and the next turn reads them as the shop’s automatic texts', async () => {
    const desk: Actor = {
      auth: { userId: NIL_UUID, employeeId: null, locationId: w.locationId, permissions: new Set(['jobs.status', 'sched.edit']), actorName: 'Desk' },
      audit: { actor: { userId: null, name: 'Desk' } },
    }
    const step = async (fn: (tx: Tx, c: SchedulingCtx) => Promise<unknown>) => {
      const c = await w.rt.schedulingCtx(w.locationId)
      await w.tx((tx) => fn(tx, c))
    }
    const a = assistant([simText('We are open until 6 PM today.'), simText('You are welcome, Maria! See you next time.')])
    await inbound(maria(), 'are you open today?')
    expect(await a.respond(maria())).toMatchObject({ status: 'replied' })
    const id = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T10:30:00-04:00' })
    await step((tx, c) => arriveAppointment(tx, c, desk, id))
    await step((tx, c) => startCleaning(tx, c, desk, id))
    await step((tx, c) => completeAppointment(tx, c, desk, id))
    const status = (await outTexts(maria())).filter((t) => t.appointment_id === id)
    expect(status.map((t) => t.template_key)).toEqual(['in_progress', 'ready'])
    expect(status.every((t) => t.sender_kind !== 'ai')).toBe(true)
    // the status texts neither started a turn nor paused the AI
    expect((await conversationOf(maria()))!.pending_since).toBeNull()
    w.clock.advance(5 * 60_000)
    await inbound(maria(), 'thanks!')
    expect(await a.respond(maria())).toMatchObject({ status: 'replied' })
    const history = JSON.stringify(a.provider.requests[1]!.messages[0])
    expect(history).toContain('(shop, automatic text)')
    expect((await outTexts(maria())).at(-1)!.body).toBe('You are welcome, Maria! See you next time.')
  })
})

describe('W4 live eval: what the eval on Bedrock found in these seams', () => {
  it('asking for open times notes the service on the new texter’s lead: the next intake step is the memberships, not "what would you like" again', async () => {
    // on Bedrock the model almost never called note_interest, so the intake stayed on its "intent" step for whole conversations
    // and the memberships were never presented before a first booking (owner 2026-10-11 intake order)
    const a = assistant([
      simToolUse('set_my_name', { fullName: 'Ana Lopez' }),
      simToolUse('check_availability', { serviceKey: 'signature-hand-wash', date: MONDAY, partOfDay: 'morning' }),
      simText('Monday morning has openings, 10:00 AM included. Do you want to hear about our memberships first?'),
      simText('{plan:gold}. {plan:vip}. Would one of them interest you?'),
    ])
    await inbound(NEWCOMER, 'Hi, I’m Ana Lopez, can I get a wash Monday morning?')
    expect(await a.respond(NEWCOMER)).toMatchObject({ status: 'replied' })
    expect(contextOf(a.provider.requests[0]!)).toContain(`Intake: ${INTAKE_LINES.name}.`)
    expect((await w.t.db.selectFrom('leads').select('interests').where('phone_e164', '=', NEWCOMER).executeTakeFirstOrThrow()).interests).toEqual(['wash'])
    w.clock.advance(70_000)
    await inbound(NEWCOMER, 'Sure')
    expect(await a.respond(NEWCOMER)).toMatchObject({ status: 'replied' })
    expect(contextOf(a.provider.requests.at(-1)!)).toContain(`Intake: ${INTAKE_LINES.memberships}.`)
    // the intent line itself tells the model to save what the texter already said
    expect(INTAKE_LINES.intent).toContain('note_interest')
  })

  it('a client on file without a lead: open times open no lead (only the welcome flow and note_interest do)', async () => {
    const a = assistant([simToolUse('check_availability', { serviceKey: 'signature-hand-wash', date: MONDAY, partOfDay: null }), simText('Monday has openings at 10:00 AM.')])
    await inbound(maria(), 'Any openings Monday?')
    expect(await a.respond(maria())).toMatchObject({ status: 'replied' })
    expect(await w.t.db.selectFrom('leads').select('id').execute()).toEqual([])
  })
})
