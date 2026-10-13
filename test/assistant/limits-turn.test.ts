// A live turn under the owner's limits and tone (ADR 0174 §3b, design §11 "Limits"): what is switched off is neither offered nor
// run; check_availability without booking links issues no link; a word to avoid gets one rewrite, then its sentences are dropped,
// then the fallback; the handoff topics' server backstop; Spanish "english" and "handoff" (no model call); the server's sign-off.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { seedLegacyWebsitePrices } from '../fixtures/legacy-website-prices.js'
import { runSeed } from '../../db/seeds/index.js'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { SimAiProvider, simText, simToolUse, type SimStep } from '../../src/integrations/ai/sim.js'
import type { AiConverseRequest } from '../../src/integrations/ports/ai.js'
import { addDays, toBizDate } from '../../src/platform/time.js'
import { DEFAULT_BEHAVIOR, DEFAULT_CAPABILITIES, type Behavior, type Capabilities } from '../../src/modules/assistant/policy.js'
import { CORE_RULES, OWNER_BLOCK_HEADER, OWNER_ONLY_REMINDER } from '../../src/modules/assistant/prompt.js'
import { AssistantRuntime } from '../../src/modules/assistant/runtime.js'
import { runTurn, type TurnResult } from '../../src/modules/assistant/turn.js'
import { BOOKING_LINKS_OFF_RULE } from '../../src/modules/assistant/tools/availability.js'
import { SPANISH_HANDOFF_TEXT, TOPIC_HANDOFF_TEXTS } from '../../src/modules/assistant/lang.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld({
  env: { AI_ENABLED: 'true', AI_ACTIONS_ENABLED: 'true', BUSINESS_PHONE: '+12015986304', BUSINESS_TEXT_NUMBER: '+18623885827' },
  deps: { assistant: { kick: { kick: async () => undefined } } },
})

beforeAll(async () => {
  await runSeed({ db: w.t.db, clock: w.clock, profile: 'website-catalog' })
  await seedLegacyWebsitePrices(w.t.db, w.clock, (await w.t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id)
})

beforeEach(async () => {
  await sql`truncate table assistant_conversations, leads, sms_opt_outs, client_links cascade`.execute(w.t.db)
  await sql`delete from settings where key like 'assistant.%'`.execute(w.t.db)
  await setting('assistant.enabled', true)
  await setting('assistant.stage', 'everyone')
})

async function setting(key: string, value: unknown): Promise<void> {
  await sql`insert into settings (location_id, key, value) values (${w.locationId}, ${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (location_id, key) do update set value = excluded.value, version = settings.version + 1`.execute(w.t.db)
}

const limits = async (caps: Partial<Capabilities> = {}, behavior: Partial<Behavior> = {}): Promise<void> => {
  await setting('assistant.capabilities', { ...DEFAULT_CAPABILITIES, ...caps })
  await setting('assistant.behavior', { ...DEFAULT_BEHAVIOR, ...behavior })
}

let n = 0
async function inbound(from: string, text: string): Promise<void> {
  n += 1
  const ev = w.signed('sms:received', { messageId: `limits-in-${n}`, sender: from, recipient: '+18623885827', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
}

interface Played {
  r: TurnResult
  model: AiConverseRequest[]
  judge: AiConverseRequest[]
  conversationId: string
  phone: string
  sent: string[]
}

async function play(text: string, model: SimStep[], o: { who?: string; judge?: SimStep[] } = {}): Promise<Played> {
  const provider = new SimAiProvider(model)
  const judge = o.judge ? new SimAiProvider(o.judge) : new SimAiProvider()
  const rt = new AssistantRuntime({ db: w.t.db, clock: w.clock, newId: w.newId, env: w.env, messaging: w.rt, provider, judgeProvider: judge })
  w.clock.advance(3 * 3600_000)
  const phone = w.customer(o.who ?? 'Maria Delgado').phone
  await inbound(phone, text)
  const c = await w.t.db.selectFrom('assistant_conversations').select('id').where('phone_e164', '=', phone).executeTakeFirstOrThrow()
  const r = await runTurn(rt.turnDeps, c.id)
  const sent = (
    await w.t.db.selectFrom('messages').select(['body', 'queued_at']).where('peer_e164', '=', phone).where('direction', '=', 'out').orderBy('queued_at').orderBy('id').execute()
  ).map((m) => m.body)
  return { r, model: provider.requests, judge: judge.requests, conversationId: c.id, phone, sent }
}

const toolNames = (req: AiConverseRequest): string[] => (req.tools ?? []).map((t) => t.name)
const turnRow = (conversationId: string) =>
  w.t.db.selectFrom('assistant_turns').selectAll().where('conversation_id', '=', conversationId).orderBy('started_at', 'desc').executeTakeFirstOrThrow()
const calls = (conversationId: string) =>
  w.t.db
    .selectFrom('assistant_tool_calls as c')
    .innerJoin('assistant_turns as t', 't.id', 'c.turn_id')
    .select(['c.tool', 'c.outcome', 'c.error', 'c.output'])
    .where('t.conversation_id', '=', conversationId)
    .orderBy('c.seq')
    .execute()
const conversation = (id: string) => w.t.db.selectFrom('assistant_conversations').select(['handoff_state', 'handoff_reason']).where('id', '=', id).executeTakeFirstOrThrow()

describe('a turn under the owner’s limits (ADR 0174 §3b)', () => {
  it('switched-off abilities are not offered and refused when called; the owner block follows the rules; the turn records the policy', async () => {
    await limits({ availability: false, paymentLinks: false })
    const p = await play('Can I pay my bill online?', [simToolUse('send_link', { kind: 'pay', appointmentRef: null, tier: null }), simText('A team member will text you about paying.')])
    expect(p.r.status).toBe('replied')
    const req = p.model[0]!
    expect(req.system[0]!.text).toBe(CORE_RULES)
    expect(req.system[1]!.text.startsWith(OWNER_BLOCK_HEADER)).toBe(true)
    expect(req.system[1]!.cache).toBeUndefined()
    expect(req.system.at(-1)!.text.split('\n').at(-1)).toBe(OWNER_ONLY_REMINDER)
    expect(toolNames(req)).not.toContain('check_availability')
    const kinds = (req.tools!.find((t) => t.name === 'send_link')!.inputSchema as { properties: { kind: { enum: string[] } } }).properties.kind.enum
    expect(kinds).toEqual(['calendar', 'verify', 'pin', 'membership'])
    expect((await calls(p.conversationId)).filter((c) => c.tool !== 'policy_judge')).toEqual([expect.objectContaining({ tool: 'send_link', outcome: 'denied', error: 'policy_off' })])
    const row = await turnRow(p.conversationId)
    const system = (row.transcript as unknown as Array<{ kind: string; policy?: string }>).find((e) => e.kind === 'system')!
    expect(system.policy).toMatch(/^[0-9a-f]{16}$/)
  })

  it('check_availability without booking links: no link, no times; the team sets the visit up', async () => {
    await limits({ bookingLinks: false })
    const rt = new AssistantRuntime({ db: w.t.db, clock: w.clock, newId: w.newId, env: w.env, messaging: w.rt, provider: new SimAiProvider([]) })
    const service = (await rt.deps.facts.get(w.locationId)).catalog.items.find((i) => i.kind === 'package' && !i.quoteOnly)!.key
    const date = addDays(toBizDate(new Date(w.clock.now().getTime() + 3 * 3600_000), 'America/New_York'), 1)
    const p = await play('Can I come in tomorrow?', [
      simToolUse('check_availability', { serviceKey: service, date, partOfDay: null }),
      simText('A team member will text you to set that up.'),
    ])
    expect(p.r.status).toBe('replied')
    expect(JSON.stringify(p.model[1]!.messages.at(-1))).toContain(BOOKING_LINKS_OFF_RULE.slice(0, 60))
    expect(JSON.stringify(p.model[1]!.messages.at(-1))).toContain('"bookingLink":null')
    expect((await w.t.db.selectFrom('client_links').select('id').where('phone_e164', '=', p.phone).execute()).length).toBe(0)
    expect(p.model[0]!.system.at(-1)!.text).toContain('In-chat booking: off (a team member sets up bookings: booking links are off).')
  })

  it('an ability switched off: a reply that says a team member will text them opens the handoff (and asks nothing more)', async () => {
    await limits({ bookingLinks: false })
    const p = await play('I want to book a wash tomorrow', [simText('A team member will text you to set that up. Which wash would you like?')])
    expect(p.r.status).toBe('replied')
    expect(await conversation(p.conversationId)).toEqual({ handoff_state: 'open', handoff_reason: 'cannot_help' })
    expect(p.sent.at(-1)).toContain('A team member will text you to set that up.')
    expect(p.sent.at(-1)).not.toContain('Which wash')
    // with every ability on, the same words open nothing (today's behaviour)
    await limits()
    const q = await play('I want to book a wash tomorrow', [simText('A team member will text you to set that up.')], { who: 'Liam Chen' })
    expect((await conversation(q.conversationId)).handoff_state).toBeNull()
  })

  it('account questions off: the client’s own membership status is not looked up', async () => {
    await limits({ accountInfo: false })
    const p = await play('Am I a member?', [simToolUse('get_membership_info', {}), simText('A team member will text you about your membership.')])
    expect(toolNames(p.model[0]!)).not.toContain('get_balance')
    expect(JSON.stringify(p.model[1]!.messages.at(-1))).toContain('"mine":null')
    expect(p.model[0]!.system.at(-1)!.text).not.toContain('Membership:')
  })

  it('a word to avoid: one rewrite, then the sentences holding it are dropped', async () => {
    await limits({}, { avoidWords: ['cheap'] })
    const p = await play('Tell me about your wash', [simText('Our wash is cheap and fast. Want to book?'), simText('It is a cheap option. It is quick and careful.')])
    expect(p.r.status).toBe('replied')
    expect(p.r.status === 'replied' && p.r.text).toContain('It is quick and careful.')
    expect(p.sent.join(' ')).not.toMatch(/cheap/i)
    // the rewrite named the word
    expect(JSON.stringify(p.model[1]!.messages.at(-1))).toContain('Remove these from the text: \\"cheap\\"')
    const row = await turnRow(p.conversationId)
    expect(JSON.stringify(row.transcript)).toContain('avoid_word_cut')
    expect(p.model[0]!.system[1]!.text).toContain('Never use these words or phrases (the shop\'s list): "cheap".')
  })

  it('a word to avoid in every sentence after the rewrite: the fallback and a person', async () => {
    await limits({}, { avoidWords: ['cheap'] })
    const p = await play('Is it cheap?', [simText('So cheap!'), simText('Very cheap!')])
    expect(p.r.status).toBe('handed_off')
    expect((await turnRow(p.conversationId)).error).toBe('guard:avoid_word')
    expect(p.sent.join(' ')).not.toMatch(/cheap/i)
  })

  it('a handoff topic the model did not hand off: the server’s fixed line replaces the reply and the chat goes to the team', async () => {
    await limits({}, { handoffTopics: ['insurance claims'] })
    const p = await play('Can you help with an insurance claim for a scratch?', [simText('Sure, we can take care of that scratch!')])
    expect(p.r.status).toBe('replied')
    expect(p.sent.at(-1)).toContain(TOPIC_HANDOFF_TEXTS.en)
    expect(p.sent.join(' ')).not.toContain('take care of that')
    expect(await conversation(p.conversationId)).toEqual({ handoff_state: 'open', handoff_reason: 'policy' })
  })

  it('Spanish "english": a Spanish texter is answered in English, the server’s parts too', async () => {
    await limits({}, { spanish: 'english' })
    const p = await play('Hola, cuanto cuesta un lavado por favor?', [simText('We have great washes! Which one would you like?')])
    expect(p.r.status).toBe('replied')
    const ctx = p.model[0]!.system.at(-1)!.text
    expect(ctx).toContain('the shop answers in English: write your text in English, simply.')
    expect(ctx).not.toContain('Language: Spanish')
    expect(p.sent.at(-1)).toContain('Reply STOP to opt out.')
  })

  it('Spanish "handoff": the server’s fixed Spanish line, no model call, the chat to the team', async () => {
    await limits({}, { spanish: 'handoff' })
    const p = await play('Hola, cuanto cuesta un lavado por favor?', [])
    expect(p.r.status).toBe('replied')
    expect(p.model).toHaveLength(0)
    expect(p.judge).toHaveLength(0)
    expect(p.sent.at(-1)).toContain(SPANISH_HANDOFF_TEXT)
    expect(p.sent.at(-1)).toContain('Asistente automatizado de Oasis Auto Spa.')
    expect(await conversation(p.conversationId)).toEqual({ handoff_state: 'open', handoff_reason: 'language' })
    const row = await turnRow(p.conversationId)
    expect([row.model, row.cost_micros]).toEqual([null, 0])
    // an English texter is answered as usual
    const en = await play('Are you open today?', [simText('Yes, we are open today.')], { who: 'Liam Chen' })
    expect(en.model).toHaveLength(1)
  })

  it('the sign-off is the server’s, after the reply (never judged, room kept)', async () => {
    await limits({}, { signOff: '- Oasis team' })
    const p = await play('Are you open today?', [simText('Yes, we are open today.')])
    expect(p.r.status).toBe('replied')
    expect(p.sent.at(-1)).toMatch(/Yes, we are open today\. - Oasis team Reply STOP to opt out\.$/)
    expect(JSON.stringify(p.judge)).not.toContain('Oasis team')
  })
})
