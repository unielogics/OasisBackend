// The practice chat's runtime (ADR 0174 §4c, design §11 "Practice"): a scripted session that walks every tool and link kind, a
// proposal, the handoff and the opt-out, for both personas, leaves the row count of EVERY table but practice's own unchanged; a
// write the practice effects would miss fails under the read-only pool; it all works with AI_ENABLED=false and the policy judge
// forced on; the preview shows the links as "[booking link]", the confirmation a proposal would text, and the badges.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { seedLegacyWebsitePrices } from '../fixtures/legacy-website-prices.js'
import { runSeed } from '../../db/seeds/index.js'
import { SimAiProvider, simText, simToolUse, type SimStep } from '../../src/integrations/ai/sim.js'
import type { AiConverseRequest } from '../../src/integrations/ports/ai.js'
import { openTimes } from '../../src/modules/assistant/tools/common.js'
import type { AnyAssistantTool, ToolRegistry } from '../../src/modules/assistant/contract.js'
import { parsePracticeState } from '../../src/modules/assistant/practice/effects.js'
import { DEFAULT_BEHAVIOR } from '../../src/modules/assistant/policy.js'
import { TOPIC_HANDOFF_AFTER_PROPOSAL_TEXTS } from '../../src/modules/assistant/lang.js'
import { createToolRegistry } from '../../src/modules/assistant/tools/index.js'
import { addDays, toBizDate } from '../../src/platform/time.js'
import { useWorld } from '../messaging-db/world.js'
import { newSession, practiceDeps, rowCounts, say, useReadOnly } from './helpers.js'

const PEPPER = 'a1'.repeat(32)
const w = useWorld({
  env: {
    AI_ENABLED: 'false',
    AI_ACTIONS_ENABLED: 'true',
    PUBLIC_LINKS_ENABLED: 'true',
    PIN_PEPPER: PEPPER,
    AI_PRACTICE_ENABLED: 'true',
    BUSINESS_PHONE: '+12015986304',
    BUSINESS_TEXT_NUMBER: '+18623885827',
  },
})
const readDb = useReadOnly(w)

beforeAll(async () => {
  await runSeed({ db: w.t.db, clock: w.clock, profile: 'website-catalog' })
  await seedLegacyWebsitePrices(w.t.db, w.clock, (await w.t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id)
})

beforeEach(async () => {
  await sql`truncate table assistant_practice_sessions, assistant_conversations, leads, client_links cascade`.execute(w.t.db)
  await sql`delete from settings where key like 'assistant.%'`.execute(w.t.db)
  await sql`insert into settings (location_id, key, value) values (${w.locationId}, 'assistant.actions_enabled', 'true'::jsonb)
    on conflict (location_id, key) do update set value = excluded.value, version = settings.version + 1`.execute(w.t.db)
})

async function shop() {
  const d = practiceDeps(w, readDb(), { provider: new SimAiProvider([]), judge: new SimAiProvider() })
  const facts = await d.facts.get(w.locationId)
  const service = facts.catalog.items.find((i) => i.kind === 'package' && !i.quoteOnly)!
  // the first open start of the next days (a proposal the slot check accepts)
  let date = toBizDate(w.clock.now(), w.env.BUSINESS_TZ)
  let startMin = 600
  for (let i = 1; i <= 7; i++) {
    const day = addDays(toBizDate(w.clock.now(), w.env.BUSINESS_TZ), i)
    const open = await openTimes(w.t.db, { locationId: w.locationId, tz: w.env.BUSINESS_TZ, now: w.clock.now(), date: day, durationMin: service.durationMin ?? 60, vip: false, customerId: null })
    if (open.slots.length > 0) {
      date = day
      startMin = open.slots[0]!.startMin
      break
    }
  }
  return { facts, service, tomorrow: date, startMin, category: service.category, size: facts.catalog.sizes[0]!.key, plan: facts.plans[0]?.key ?? 'gold' }
}

/** A scripted model whose steps may read the request (the reply after a proposal depends on its result). */
function scripted(steps: Array<SimStep | ((req: AiConverseRequest) => SimStep)>): SimAiProvider {
  return new SimAiProvider((req, i) => {
    const step = steps[i]
    if (!step) return { error: 'invalid_request', message: 'script exhausted' }
    return typeof step === 'function' ? step(req) : step
  })
}
const after = (req: AiConverseRequest): string => JSON.stringify(req.messages.at(-1))

const turnRow = (id: string) => w.t.db.selectFrom('assistant_practice_turns').selectAll().where('id', '=', id).executeTakeFirstOrThrow()

describe('the practice runtime writes nothing outside practice (ADR 0174 §4c)', () => {
  it('a new texter walks every tool, link kind, a proposal, the handoff and the opt-out: every other table’s row count is unchanged', async () => {
    const s = await shop()
    const sessionId = await newSession(w, { persona: 'new_texter', verified: true })
    const before = await rowCounts(w.t.db)
    const steps: Array<SimStep | ((req: AiConverseRequest) => SimStep)> = [
      // 1: a name and an interest
      simToolUse('set_my_name', { fullName: 'Ana' }, 'a1'),
      simToolUse('note_interest', { categories: [s.category] }, 'a2'),
      simText('Nice to meet you, Ana! What would you like today?'),
      // 2: four lookups, then the reply-now call
      simToolUse('list_services', { category: null }, 'b1'),
      simToolUse('get_membership_info', {}, 'b2'),
      simToolUse('get_business_info', { topic: 'hours' }, 'b3'),
      simToolUse('check_availability', { serviceKey: s.service.key, date: s.tomorrow, partOfDay: null }, 'b4'),
      simText('We have openings tomorrow. Want me to book one?'),
      // 3: a vehicle and three links
      simToolUse('set_my_vehicle', { size: s.size, make: 'Honda', model: 'Civic', year: 2020, color: null }, 'c1'),
      simToolUse('send_link', { kind: 'verify', appointmentRef: null, tier: null }, 'c2'),
      simToolUse('send_link', { kind: 'calendar', appointmentRef: null, tier: null }, 'c3'),
      simToolUse('send_link', { kind: 'pin', appointmentRef: null, tier: null }, 'c4'),
      simText('Here you go: {link2}'),
      // 4: a membership and a payment link, a proposal
      simToolUse('send_link', { kind: 'membership', appointmentRef: null, tier: s.plan }, 'd1'),
      simToolUse('send_link', { kind: 'pay', appointmentRef: null, tier: null }, 'd2'),
      simToolUse('propose_booking', { serviceKey: s.service.key, addonKeys: [], date: s.tomorrow, startMin: s.startMin, vehicle: null, vehicleClass: null }, 'd3'),
      (req) => (after(req).includes('confirmationTexted') ? simText('{confirm}.') : simText('A team member will help you book that.')),
      // 5: the client's own record, then a person
      simToolUse('list_my_appointments', {}, 'e1'),
      simToolUse('get_balance', {}, 'e2'),
      simToolUse('handoff_to_staff', { reason: 'client_asked', summary: 'Wants a person.' }, 'e3'),
      simText('A team member will text you back shortly.'),
      // 6: stop
      simToolUse('opt_out', {}, 'f1'),
    ]
    const provider = scripted(steps)
    const judge = new SimAiProvider()
    const d = practiceDeps(w, readDb(), { provider, judge })
    const texts = ['Hi, I’m Ana and I want a wash', 'What do you have? Memberships? Open tomorrow?', 'I have a 2020 Honda Civic, send me the links', 'Book me tomorrow at 10, and the plan, and pay', 'My visits and balance? Can I talk to a person', 'stop texting me']
    const statuses: (string | null)[] = []
    const ids: string[] = []
    for (const t of texts) {
      w.clock.advance(60_000)
      const r = await say(w, d, sessionId, t)
      statuses.push(r.status)
      ids.push(r.turnId)
    }
    expect(statuses).toEqual(['replied', 'replied', 'replied', 'replied', 'replied', 'opted_out'])
    expect(provider.requests.length).toBe(steps.length)
    // nothing outside practice changed: no client, lead, link, pending action, message, outbox row, opt-out, audit row, turn or call
    expect(await rowCounts(w.t.db)).toEqual(before)
    // the session's own state holds what the tools did
    const session = await w.t.db.selectFrom('assistant_practice_sessions').selectAll().where('id', '=', sessionId).executeTakeFirstOrThrow()
    const st = parsePracticeState(session.state)
    expect(st.name).toBe('Ana')
    expect(st.interests).toContain(s.category)
    expect(st.vehicles).toEqual([expect.objectContaining({ make: 'Honda', model: 'Civic', year: 2020, size: s.size })])
    expect(st.links.map((l) => l.kind)).toEqual(expect.arrayContaining(['verify', 'calendar', 'pin']))
    expect(st.membershipsShown).toBe(true)
    expect(st.pending).toBeNull() // the handoff canceled the proposal
    expect(st.optedOut).toBe(true)
    expect(session.turns).toBe(6)
    // the preview: the links as words, the confirmation the proposal would text, the badges
    const t3 = await turnRow(ids[2]!)
    expect(t3.reply_text).toContain('[booking link]')
    expect(t3.reply_text).toContain('[verify link]')
    expect(t3.reply_text).toContain('[PIN link]')
    expect(t3.reply_text).toContain('For your security, enter codes and your PIN only on the secure page')
    expect(JSON.stringify(t3.badges)).toContain('Booking link')
    const t2 = await turnRow(ids[1]!)
    expect(JSON.stringify(t2.badges)).toContain('Looked up: open times')
    const t1 = await turnRow(ids[0]!)
    expect(t1.reply_text).toMatch(/^Oasis Auto Spa['’]s automated assistant here\. Nice to meet you, Ana!/)
    const t4 = await turnRow(ids[3]!)
    const proposal = (t4.extra_texts as string[]).join(' ')
    expect((t4.tool_calls as Array<{ tool: string; outcome: string }>).find((c) => c.tool === 'propose_booking')!.outcome).toBe('ok')
    expect(proposal).toMatch(/Reply #### to confirm\.$/)
    expect(t4.reply_text).toContain('I just texted you the details with how to confirm')
    expect(JSON.stringify(t4.badges)).toContain('Would text a confirmation number')
    const t5 = await turnRow(ids[4]!)
    expect(JSON.stringify(t5.badges)).toContain('Handed to staff: asked for a person')
    const t6 = await turnRow(ids[5]!)
    expect(t6.reply_text).toBeNull()
    expect((t6.extra_texts as string[])[0]).toContain('unsubscribed')
    // works with AI_ENABLED=false, and the policy judge is forced on
    expect(w.env.AI_ENABLED).toBe(false)
    expect(judge.requests.length).toBeGreaterThan(0)
    expect(t1.prompt_version).toMatch(/^q3d-/)
  })

  it('a real client on file, read-only: their visits and balance are read, nothing of theirs changes', async () => {
    const maria = w.customer('Maria Delgado')
    await w.appointment({ customer: 'Maria Delgado', at: '2026-06-20T10:00:00-04:00' })
    const sessionId = await newSession(w, { persona: 'client', customerId: maria.id })
    const before = await rowCounts(w.t.db)
    const provider = new SimAiProvider([
      simToolUse('list_my_appointments', {}, 'a1'),
      simToolUse('get_balance', {}, 'a2'),
      simToolUse('set_my_name', { fullName: 'Mary' }, 'a3'),
      simToolUse('send_link', { kind: 'calendar', appointmentRef: 'A1', tier: null }, 'a4'),
      simText('Here is your link to move it: {link1}'),
      simToolUse('propose_cancel', { appointmentRef: 'A1', reason: 'busy' }, 'b1'),
      simText('Use the verify link first, then I can help.'),
    ])
    const d = practiceDeps(w, readDb(), { provider, judge: new SimAiProvider() })
    const one = await say(w, d, sessionId, 'When is my visit? What do I owe? Call me Mary. Can I move it?')
    const two = await say(w, d, sessionId, 'Cancel it please')
    expect([one.status, two.status]).toEqual(['replied', 'replied'])
    expect(await rowCounts(w.t.db)).toEqual(before)
    const calls = (await turnRow(one.turnId)).tool_calls as Array<{ tool: string; outcome: string; error: string | null }>
    expect(calls.find((c) => c.tool === 'list_my_appointments')!.outcome).toBe('ok')
    // a name on file is never changed by text, in practice either
    expect(calls.find((c) => c.tool === 'set_my_name')).toMatchObject({ outcome: 'error', error: 'not_allowed' })
    // the request named the client and their visit, never their number or id
    const req = JSON.stringify(provider.requests[0])
    expect(req).toContain('first name \\"Maria\\"')
    expect(req).toContain('- A1:')
    expect(req).not.toContain(maria.phone.slice(2))
    expect(req).not.toContain(maria.id)
    // an unverified phone cannot propose
    expect(((await turnRow(two.turnId)).tool_calls as Array<{ tool: string; outcome: string }>).find((c) => c.tool === 'propose_cancel')!.outcome).toBe('denied')
  })

  it('a write the practice effects would miss fails in the database under the read-only pool', async () => {
    await expect(readDb().insertInto('leads').values({ id: w.newId(), location_id: w.locationId, phone_e164: '+12015550188', source: 'text' } as never).execute()).rejects.toMatchObject({
      code: '25006',
    })
    // a tool that writes through ctx.db (a rogue one) gets an `unavailable` result; nothing is written
    const real = createToolRegistry({} as never)
    const rogue: AnyAssistantTool = {
      ...real.get('get_business_info')!,
      run: async (ctx) => {
        await ctx.db.insertInto('leads').values({ id: ctx.newId(), location_id: ctx.identity.locationId, phone_e164: ctx.identity.phone, source: 'text' } as never).execute()
        return { ok: true, data: {} }
      },
    }
    const registry: ToolRegistry = { tools: real.tools.map((t) => (t.name === 'get_business_info' ? rogue : t)), get: (n) => (n === 'get_business_info' ? rogue : real.get(n)) }
    const sessionId = await newSession(w, { persona: 'new_texter' })
    const before = await rowCounts(w.t.db)
    const d = practiceDeps(w, readDb(), { provider: new SimAiProvider([simToolUse('get_business_info', { topic: 'hours' }), simText('We are open today.')]), judge: new SimAiProvider(), registry })
    const r = await say(w, d, sessionId, 'Are you open?')
    expect(r.status).toBe('replied')
    expect(((await turnRow(r.turnId)).tool_calls as Array<{ tool: string; outcome: string; error: string }>)[0]).toMatchObject({ outcome: 'error', error: expect.stringMatching(/^exception:/) })
    expect(await rowCounts(w.t.db)).toEqual(before)
  })

  it('"Try this draft": a draft entry the session names is read as if it were on (only in that session)', async () => {
    const id = w.newId()
    await w.t.db.insertInto('assistant_knowledge').values({ id, location_id: w.locationId, kind: 'note', title: 'Lounge', body: 'We have a lounge with free-to-use wifi.', active: false, chars: 40 }).execute()
    const withDraft = await newSession(w, { persona: 'new_texter', includeEntryIds: [id] })
    const without = await newSession(w, { persona: 'new_texter' })
    const p1 = new SimAiProvider([simText('We have a lounge with wifi.')])
    const p2 = new SimAiProvider([simText('The team can confirm that.')])
    await say(w, practiceDeps(w, readDb(), { provider: p1, judge: new SimAiProvider() }), withDraft, 'Is there a lounge?')
    await say(w, practiceDeps(w, readDb(), { provider: p2, judge: new SimAiProvider() }), without, 'Is there a lounge?')
    expect(JSON.stringify(p1.requests[0]!.system)).toContain('> We have a lounge with free-to-use wifi.')
    expect(JSON.stringify(p2.requests[0]!.system)).not.toContain('lounge with')
  })

  it('a handoff topic after a texted proposal: the proposal is canceled as live does, the reply names the visit too (verifier F2)', async () => {
    const s = await shop()
    await sql`insert into settings (location_id, key, value) values (${w.locationId}, 'assistant.behavior', ${JSON.stringify({ ...DEFAULT_BEHAVIOR, handoffTopics: ['insurance claims'] })}::jsonb)
      on conflict (location_id, key) do update set value = excluded.value, version = settings.version + 1`.execute(w.t.db)
    const sessionId = await newSession(w, { persona: 'new_texter', verified: true })
    const provider = scripted([
      simToolUse('propose_booking', { serviceKey: s.service.key, addonKeys: [], date: s.tomorrow, startMin: s.startMin, vehicle: null, vehicleClass: null }, 'p1'),
      (req) => (after(req).includes('confirmationTexted') ? simText('{confirm}.') : simText('The team can help with that.')),
    ])
    const r = await say(w, practiceDeps(w, readDb(), { provider, judge: new SimAiProvider() }), sessionId, 'Book me a wash tomorrow, and I also have an insurance claim question')
    expect(r.status).toBe('replied')
    const t = await turnRow(r.turnId)
    expect(JSON.stringify(t.extra_texts)).toMatch(/Reply #### to confirm/)
    expect(t.reply_text).toContain(TOPIC_HANDOFF_AFTER_PROPOSAL_TEXTS.en)
    expect(JSON.stringify(t.badges)).toContain('Handed to staff')
    const session = await w.t.db.selectFrom('assistant_practice_sessions').select('state').where('id', '=', sessionId).executeTakeFirstOrThrow()
    expect(parsePracticeState(session.state).pending).toBeNull()
  })

  it('any handoff ends a proposal waiting for its reply number, as the live chat does (the fallback after a proposal)', async () => {
    const s = await shop()
    const sessionId = await newSession(w, { persona: 'new_texter', verified: true })
    const provider = scripted([
      simToolUse('propose_booking', { serviceKey: s.service.key, addonKeys: [], date: s.tomorrow, startMin: s.startMin, vehicle: null, vehicleClass: null }, 'q1'),
      { error: 'invalid_request', message: 'the model failed' },
    ])
    const r = await say(w, practiceDeps(w, readDb(), { provider, judge: new SimAiProvider() }), sessionId, 'Book me a wash tomorrow')
    expect(r.status).toBe('handed_off')
    const session = await w.t.db.selectFrom('assistant_practice_sessions').select('state').where('id', '=', sessionId).executeTakeFirstOrThrow()
    expect(parsePracticeState(session.state).pending).toBeNull()
  })
})
