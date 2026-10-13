// A live turn with the owner's knowledge (ADR 0174 §1f and §3b): the active entries reach the model as the SHOP KNOWLEDGE block,
// cached between the rules and SHOP FACTS, masked (no amount, link or other number), the turn context ends with the fixed reminder,
// the policy judge reads the same block under the reworded rule (f), and every request keeps at most four cache points. A draft
// never reaches the model. Without active knowledge the requests are byte-identical to before (test/assistant/engine-parity.test.ts).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { runSeed } from '../../db/seeds/index.js'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { SimAiProvider, simText } from '../../src/integrations/ai/sim.js'
import type { AiConverseRequest } from '../../src/integrations/ports/ai.js'
import { JUDGE_FACTS_RULE, JUDGE_FACTS_RULE_WITH_KNOWLEDGE } from '../../src/modules/assistant/judge.js'
import { KNOWLEDGE_REMINDER, SHOP_KNOWLEDGE_HEADER } from '../../src/modules/assistant/knowledge/render.js'
import { STATIC_RULES } from '../../src/modules/assistant/prompt.js'
import { AssistantRuntime } from '../../src/modules/assistant/runtime.js'
import { runTurn } from '../../src/modules/assistant/turn.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld({ env: { AI_ENABLED: 'true', BUSINESS_PHONE: '+12015986304', BUSINESS_TEXT_NUMBER: '+18623885827' } })

beforeAll(async () => {
  await runSeed({ db: w.t.db, clock: w.clock, profile: 'website-catalog' })
})

beforeEach(async () => {
  await sql`truncate table assistant_conversations, assistant_knowledge cascade`.execute(w.t.db)
  await sql`delete from settings where key like 'assistant.%'`.execute(w.t.db)
  for (const [k, v] of [
    ['assistant.enabled', true],
    ['assistant.stage', 'everyone'],
  ] as const)
    await sql`insert into settings (location_id, key, value) values (${w.locationId}, ${k}, ${JSON.stringify(v)}::jsonb)
      on conflict (location_id, key) do update set value = excluded.value, version = settings.version + 1`.execute(w.t.db)
})

let n = 0
async function inbound(from: string, text: string): Promise<void> {
  n += 1
  const ev = w.signed('sms:received', { messageId: `kb-in-${n}`, sender: from, recipient: '+18623885827', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
}

async function note(o: { title: string; body: string; active: boolean }): Promise<void> {
  await w.t.db
    .insertInto('assistant_knowledge')
    .values({ id: w.newId(), location_id: w.locationId, kind: 'note', title: o.title, body: o.body, active: o.active, chars: o.title.length + o.body.length })
    .execute()
}

async function turn(text: string): Promise<{ model: AiConverseRequest[]; judge: AiConverseRequest[]; status: string }> {
  const provider = new SimAiProvider([simText('Yes, we have a waiting lounge with wifi and coffee.')])
  const judge = new SimAiProvider([simText('{"reason":"fine","category":"none","ok":true}')])
  const rt = new AssistantRuntime({ db: w.t.db, clock: w.clock, newId: w.newId, env: w.env, messaging: w.rt, provider, judgeProvider: judge })
  w.clock.advance(3 * 3600_000)
  const phone = w.customer('Maria Delgado').phone
  await inbound(phone, text)
  const c = await w.t.db.selectFrom('assistant_conversations').select('id').where('phone_e164', '=', phone).executeTakeFirstOrThrow()
  const r = await runTurn(rt.turnDeps, c.id)
  return { model: provider.requests, judge: judge.requests, status: r.status }
}

const cachePoints = (r: AiConverseRequest): number => r.system.filter((b) => b.cache).length + (r.cacheTools ? 1 : 0)

describe('a turn with the owner’s knowledge (ADR 0174 §1f)', () => {
  it('sends SHOP KNOWLEDGE (cached, masked) between the rules and the facts, the reminder, and the judge reads it too', async () => {
    await note({ title: 'Waiting area', body: 'We have a waiting lounge with wifi and coffee.\nA full detail is $189; call Mike at 201-555-0142.', active: true })
    await note({ title: 'Draft', body: 'DRAFT-CANARY-77 never shown', active: false })
    const t = await turn('Do you have a waiting room?')
    expect(t.status).toBe('replied')
    const req = t.model[0]!
    expect(req.system.map((b) => b.cache === true)).toEqual([false, true, true, false])
    expect(req.system[0]!.text).toBe(STATIC_RULES)
    const k = req.system[1]!.text
    expect(k.startsWith(SHOP_KNOWLEDGE_HEADER)).toBe(true)
    expect(k).toContain('> We have a waiting lounge with wifi and coffee.')
    expect(k).toContain('> A full detail is [price in Settings]; call Mike at [number].')
    expect(k).not.toMatch(/\$189|555-0142|DRAFT-CANARY/)
    expect(req.system[2]!.text.startsWith('SHOP FACTS')).toBe(true)
    expect(req.system[3]!.text.split('\n').at(-1)).toBe(KNOWLEDGE_REMINDER)
    expect(cachePoints(req)).toBe(3)
    const j = t.judge[0]!
    expect(j.system.map((b) => b.text).slice(1, 3)).toEqual([JUDGE_FACTS_RULE_WITH_KNOWLEDGE, k])
    expect(cachePoints(j)).toBeLessThanOrEqual(4)
  })

  it('without an active entry the prompt is what it was: no block, no reminder, the old rule (f)', async () => {
    await note({ title: 'Draft', body: 'DRAFT-CANARY-77 never shown', active: false })
    const t = await turn('Do you have a waiting room?')
    const req = t.model[0]!
    expect(req.system).toHaveLength(3)
    expect(JSON.stringify(req)).not.toContain('SHOP KNOWLEDGE')
    expect(JSON.stringify(req)).not.toContain('DRAFT-CANARY')
    expect(t.judge[0]!.system[1]!.text).toBe(JUDGE_FACTS_RULE)
  })
})
