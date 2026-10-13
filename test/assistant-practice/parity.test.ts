// The practice-parity check (ADR 0174 §4c "Prompt parity guarantee", design §7 and §11): for the same facts, settings and texts, a
// live turn (turn.ts, through the real webhook) and a practice turn (practice/runner.ts) send the model byte-identical requests and
// the policy judge identical requests (its random marker key normalised): the same rules, owner block, SHOP KNOWLEDGE, SHOP FACTS,
// turn context, conversation and tool specs. Three personas: a new texter, a client on file, and a client in Spanish under owner
// limits and tone with active knowledge.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { seedLegacyWebsitePrices } from '../fixtures/legacy-website-prices.js'
import { runSeed } from '../../db/seeds/index.js'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { SimAiProvider, simText } from '../../src/integrations/ai/sim.js'
import type { AiConverseRequest } from '../../src/integrations/ports/ai.js'
import { DEFAULT_BEHAVIOR, DEFAULT_CAPABILITIES } from '../../src/modules/assistant/policy.js'
import { AssistantRuntime } from '../../src/modules/assistant/runtime.js'
import { runTurn } from '../../src/modules/assistant/turn.js'
import { STRANGER, useWorld } from '../messaging-db/world.js'
import { newSession, practiceDeps, say, useReadOnly } from './helpers.js'

const w = useWorld({
  env: { AI_ENABLED: 'true', AI_PRACTICE_ENABLED: 'true', BUSINESS_PHONE: '+12015986304', BUSINESS_TEXT_NUMBER: '+18623885827' },
  deps: { assistant: { kick: { kick: async () => undefined } } },
})
const readDb = useReadOnly(w)

beforeAll(async () => {
  await runSeed({ db: w.t.db, clock: w.clock, profile: 'website-catalog' })
  await seedLegacyWebsitePrices(w.t.db, w.clock, (await w.t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id)
})

beforeEach(async () => {
  await sql`truncate table assistant_conversations, assistant_practice_sessions, assistant_knowledge, leads, sms_opt_outs cascade`.execute(w.t.db)
  await sql`delete from customers where source = 'inbound_sms'`.execute(w.t.db)
  await sql`delete from settings where key like 'assistant.%'`.execute(w.t.db)
  await setting('assistant.enabled', true)
  await setting('assistant.stage', 'everyone')
})

async function setting(key: string, value: unknown): Promise<void> {
  await sql`insert into settings (location_id, key, value) values (${w.locationId}, ${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (location_id, key) do update set value = excluded.value, version = settings.version + 1`.execute(w.t.db)
}

const REPLY = 'Yes, we are open today.'
const normalise = (r: AiConverseRequest): string => JSON.stringify(r).replace(/⟦(\/?)[0-9a-f]{8}⟧/g, '⟦$1K⟧').replace(/key=\\"[0-9a-f]{8}\\"/g, 'key=\\"K\\"')

let n = 0
async function live(phone: string, text: string): Promise<{ model: AiConverseRequest[]; judge: AiConverseRequest[] }> {
  const provider = new SimAiProvider([simText(REPLY)])
  const judge = new SimAiProvider()
  const rt = new AssistantRuntime({ db: w.t.db, clock: w.clock, newId: w.newId, env: w.env, messaging: w.rt, provider, judgeProvider: judge })
  // the welcome flow as production wires it: a first texter becomes a provisional client (the practice new texter mirrors that)
  w.rt.useAssistant(rt.ports())
  n += 1
  const ev = w.signed('sms:received', { messageId: `parity-in-${n}`, sender: phone, recipient: '+18623885827', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
  const c = await w.t.db.selectFrom('assistant_conversations').select('id').where('phone_e164', '=', phone).executeTakeFirstOrThrow()
  const r = await runTurn(rt.turnDeps, c.id)
  expect(r.status).toBe('replied')
  return { model: provider.requests, judge: judge.requests }
}

async function practice(input: Parameters<typeof newSession>[1], text: string): Promise<{ model: AiConverseRequest[]; judge: AiConverseRequest[] }> {
  const provider = new SimAiProvider([simText(REPLY)])
  const judge = new SimAiProvider()
  const sessionId = await newSession(w, input)
  const r = await say(w, practiceDeps(w, readDb(), { provider, judge }), sessionId, text)
  expect(r.status).toBe('replied')
  return { model: provider.requests, judge: judge.requests }
}

describe('live and practice send the same requests (ADR 0174 §4c)', () => {
  it('a new texter’s first text', async () => {
    const l = await live(STRANGER, 'hi there, do you do hand washes?')
    const p = await practice({ persona: 'new_texter' }, 'hi there, do you do hand washes?')
    expect(p.model).toHaveLength(1)
    expect(JSON.stringify(p.model[0])).toBe(JSON.stringify(l.model[0]))
    expect(p.judge.map(normalise)).toEqual(l.judge.map(normalise))
  })

  it('a client on file', async () => {
    const maria = w.customer('Maria Delgado')
    const l = await live(maria.phone, 'Are you open today?')
    const p = await practice({ persona: 'client', customerId: maria.id }, 'Are you open today?')
    expect(JSON.stringify(p.model[0])).toBe(JSON.stringify(l.model[0]))
    expect(p.judge.map(normalise)).toEqual(l.judge.map(normalise))
  })

  it('a client in Spanish under the owner’s limits and tone, with active knowledge', async () => {
    await setting('assistant.capabilities', { ...DEFAULT_CAPABILITIES, paymentLinks: false, availability: false })
    await setting('assistant.behavior', { ...DEFAULT_BEHAVIOR, tone: 'professional', avoidWords: ['barato'], handoffTopics: ['seguro'] })
    await w.t.db
      .insertInto('assistant_knowledge')
      .values({ id: w.newId(), location_id: w.locationId, kind: 'note', title: 'Sala', body: 'Tenemos sala de espera con wifi.', active: true, chars: 40 })
      .execute()
    const liam = w.customer('Liam Chen')
    const l = await live(liam.phone, 'Hola, están abiertos hoy por favor?')
    const p = await practice({ persona: 'client', customerId: liam.id }, 'Hola, están abiertos hoy por favor?')
    const req = JSON.stringify(l.model[0])
    expect(req).toContain("THE SHOP'S SETTINGS FOR YOU")
    expect(req).toContain('SHOP KNOWLEDGE')
    expect(req).toContain('Language: Spanish')
    expect(JSON.stringify(p.model[0])).toBe(req)
    expect(p.judge.map(normalise)).toEqual(l.judge.map(normalise))
  })
})
