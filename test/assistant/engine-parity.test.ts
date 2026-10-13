// The engine extraction gate (ADR 0174, design §4a and §11 "Engine refactor"): the turn's core moved from turn.ts into engine.ts
// with ZERO behaviour change. Recorded here, before the move, from the real tools and the real turn: every request the model and
// the policy judge received for a set of fixture turns that walk each branch of the core (a plain reply, a tool round, the link
// nudge, a guard rewrite, a judge fail and its rewrite, a judge error retried once, the reply-now call after the last tool round,
// a handoff with text in the same round, an opt-out). The requests must stay byte-identical (the judge's random marker key and the
// random reply numbers are normalised; the file holds each request's sha256): test/assistant/fixtures/engine-requests.json. Regenerate it only for a deliberate prompt
// change (UPDATE_ENGINE_GOLDEN=1, then review the diff).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { seedLegacyWebsitePrices } from '../fixtures/legacy-website-prices.js'
import { runSeed } from '../../db/seeds/index.js'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { SimAiProvider, simText, simToolUse, type SimStep } from '../../src/integrations/ai/sim.js'
import type { AiConverseRequest } from '../../src/integrations/ports/ai.js'
import { AssistantRuntime } from '../../src/modules/assistant/runtime.js'
import { runTurn } from '../../src/modules/assistant/turn.js'
import { useWorld } from '../messaging-db/world.js'

const GOLDEN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'engine-requests.json')

const w = useWorld({
  env: { AI_ENABLED: 'true', AI_ACTIONS_ENABLED: 'true', BUSINESS_PHONE: '+12015986304', BUSINESS_TEXT_NUMBER: '+18623885827' },
  deps: { assistant: { kick: { kick: async () => undefined } } },
})

beforeAll(async () => {
  await runSeed({ db: w.t.db, clock: w.clock, profile: 'website-catalog' })
  await seedLegacyWebsitePrices(w.t.db, w.clock, (await w.t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id)
})

beforeEach(reset)

async function reset(): Promise<void> {
  await sql`truncate table assistant_conversations, leads, sms_opt_outs cascade`.execute(w.t.db)
  await sql`delete from settings where key like 'assistant.%'`.execute(w.t.db)
  await setting('assistant.enabled', true)
  await setting('assistant.stage', 'everyone')
}

async function setting(key: string, value: unknown): Promise<void> {
  await sql`insert into settings (location_id, key, value) values (${w.locationId}, ${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (location_id, key) do update set value = excluded.value, version = settings.version + 1`.execute(w.t.db)
}

let n = 0
async function inbound(from: string, text: string): Promise<void> {
  n += 1
  const ev = w.signed('sms:received', {
    messageId: `engine-in-${n}`,
    sender: from,
    recipient: '+18623885827',
    simNumber: 1,
    message: text,
    receivedAt: w.clock.now().toISOString(),
  })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** The judge's random marker key and the random reply numbers out; everything else as sent; stored as its sha256. */
const normalise = (r: AiConverseRequest): string => sha256(
  JSON.stringify(r)
    .replace(/⟦(\/?)[0-9a-f]{8}⟧/g, '⟦$1K⟧')
    .replace(/key=\\"[0-9a-f]{8}\\"/g, 'key=\\"K\\"')
    .replace(/(Reply|Responde) [0-9]{4}/g, '$1 NNNN'),
)

const pass = simText('{"reason":"fine","category":"none","ok":true}')
const fail = (category: string) => simText(JSON.stringify({ reason: 'not allowed', category, ok: false }))

interface Scenario {
  name: string
  who: string
  texts: string[]
  model: SimStep[]
  judge?: SimStep[]
  status: string
}

const SCENARIOS: Scenario[] = [
  { name: 'a plain reply with a price placeholder', who: 'Maria Delgado', texts: ['How much is a wash?'], model: [simText('{price:signature-hand-wash}.')], status: 'replied' },
  {
    name: 'a tool round, then the reply',
    who: 'Maria Delgado',
    texts: ['What services do you have?'],
    model: [simToolUse('list_services', { category: null }), simText('We have washes and details. Which one would you like?')],
    status: 'replied',
  },
  {
    name: 'a model-written amount: one guard rewrite',
    who: 'Maria Delgado',
    texts: ['What would a wash cost me?'],
    model: [simText('A wash is $54.'), simText('{price:signature-hand-wash}.')],
    status: 'replied',
  },
  {
    name: 'a judge fail, one rewrite, then a pass',
    who: 'Maria Delgado',
    texts: ['Any deals this week?'],
    model: [simText('Sure, a discount on your next wash.'), simText('A team member can tell you about that.')],
    judge: [fail('promise'), pass],
    status: 'replied',
  },
  {
    name: 'a throttled judge call retried once',
    who: 'Maria Delgado',
    texts: ['Are you open today?'],
    model: [simText('Yes, we are open today.')],
    judge: [{ error: 'throttled' }, pass],
    status: 'replied',
  },
  {
    name: 'the link nudge, then a reply without the offer',
    who: 'Maria Delgado',
    texts: ['I want to book a wash'],
    model: [simText('I can send you a link to book.'), simText('Which day works for you?')],
    status: 'replied',
  },
  {
    name: 'handoff_to_staff with text in the same round',
    who: 'Maria Delgado',
    texts: ['Can I talk to a person please'],
    model: [
      { content: [{ type: 'text', text: 'Sure, a team member will text you back shortly.' }, { type: 'toolUse', id: 'h1', name: 'handoff_to_staff', input: { reason: 'client_asked', summary: 'Wants a person.' } }] },
      simText('Thanks for your patience.'),
    ],
    status: 'replied',
  },
  {
    name: 'four tool rounds, then the reply-now call',
    who: 'Maria Delgado',
    texts: ['Tell me everything'],
    model: [
      simToolUse('get_business_info', { topic: 'hours' }, 't1'),
      simToolUse('get_business_info', { topic: 'address' }, 't2'),
      simToolUse('list_services', { category: null }, 't3'),
      simToolUse('get_membership_info', {}, 't4'),
      simText('We are open today. What would you like to know first?'),
    ],
    status: 'replied',
  },
  {
    name: 'an opt-out in words',
    who: 'Maria Delgado',
    texts: ['stop texting me please'],
    model: [simToolUse('opt_out', {})],
    status: 'skipped',
  },
]

async function play(s: Scenario): Promise<{ status: string; model: string[]; judge: string[] }> {
  const provider = new SimAiProvider(s.model)
  const judge = s.judge ? new SimAiProvider(s.judge) : new SimAiProvider()
  const rt = new AssistantRuntime({ db: w.t.db, clock: w.clock, newId: w.newId, env: w.env, messaging: w.rt, provider, judgeProvider: judge })
  rt.turnDeps.retryBackoffMs = () => 5
  const phone = w.customer(s.who).phone
  for (const t of s.texts) await inbound(phone, t)
  const c = await w.t.db.selectFrom('assistant_conversations').select('id').where('phone_e164', '=', phone).executeTakeFirstOrThrow()
  const r = await runTurn(rt.turnDeps, c.id)
  return { status: r.status, model: provider.requests.map(normalise), judge: judge.requests.map(normalise) }
}

describe('the engine extraction keeps every request byte-identical (ADR 0174 §4a)', () => {
  it('replays the fixture turns and compares the recorded requests with the golden file', async () => {
    const out: Record<string, { status: string; model: string[]; judge: string[] }> = {}
    for (const s of SCENARIOS) {
      w.clock.advance(3 * 3600_000)
      await reset()
      out[s.name] = await play(s)
      expect(out[s.name]!.status, s.name).toBe(s.status)
    }
    if (process.env.UPDATE_ENGINE_GOLDEN === '1' || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, `${JSON.stringify(out, null, 1)}\n`)
      if (process.env.UPDATE_ENGINE_GOLDEN !== '1') throw new Error('engine-requests.json was missing: written now, run again')
      return
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as typeof out
    expect(Object.keys(out)).toEqual(Object.keys(golden))
    for (const name of Object.keys(golden)) {
      expect(out[name]!.model.length, `${name}: model calls`).toBe(golden[name]!.model.length)
      out[name]!.model.forEach((r, i) => expect(r, `${name}: model request ${i}`).toBe(golden[name]!.model[i]))
      expect(out[name]!.judge.length, `${name}: judge calls`).toBe(golden[name]!.judge.length)
      out[name]!.judge.forEach((r, i) => expect(r, `${name}: judge request ${i}`).toBe(golden[name]!.judge[i]))
    }
  })
})
