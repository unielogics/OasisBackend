// The review of real conversations (ADR 0174 §5, design §11 "Corrections and review"): the list of the location's Oasis AI
// conversations with flags, filtered and paged, inside the 90-day window; one conversation turn by turn with the client's texts and
// the reply loaded on the server and redacted (numbers masked, links as "[link]"), the guard and the policy check in plain words,
// the tools, and the correction made from a turn (its wrong reply loaded from the turn, never shown to the model).
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { seedLegacyWebsitePrices } from '../fixtures/legacy-website-prices.js'
import { runSeed } from '../../db/seeds/index.js'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { SimAiProvider, simText, simToolUse, type SimStep } from '../../src/integrations/ai/sim.js'
import { createCorrection } from '../../src/modules/assistant/knowledge/corrections.js'
import { renderShopKnowledge } from '../../src/modules/assistant/knowledge/render.js'
import { loadActiveKnowledge } from '../../src/modules/assistant/facts.js'
import { getConversation, listConversations } from '../../src/modules/assistant/review.js'
import { AssistantRuntime } from '../../src/modules/assistant/runtime.js'
import { runTurn } from '../../src/modules/assistant/turn.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld({
  env: { AI_ENABLED: 'true', BUSINESS_PHONE: '+12015986304', BUSINESS_TEXT_NUMBER: '+18623885827' },
  deps: { assistant: { kick: { kick: async () => undefined } } },
})

beforeAll(async () => {
  await runSeed({ db: w.t.db, clock: w.clock, profile: 'website-catalog' })
  await seedLegacyWebsitePrices(w.t.db, w.clock, (await w.t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id)
})

beforeEach(async () => {
  await sql`truncate table assistant_conversations, assistant_knowledge, leads, sms_opt_outs cascade`.execute(w.t.db)
  await sql`delete from settings where key like 'assistant.%'`.execute(w.t.db)
  for (const [k, v] of [
    ['assistant.enabled', true],
    ['assistant.stage', 'everyone'],
  ] as const)
    await sql`insert into settings (location_id, key, value) values (${w.locationId}, ${k}, ${JSON.stringify(v)}::jsonb)
      on conflict (location_id, key) do update set value = excluded.value, version = settings.version + 1`.execute(w.t.db)
})

let n = 0
async function turn(who: string, text: string, model: SimStep[], judge?: SimStep[]): Promise<{ conversationId: string; turnId: string }> {
  const rt = new AssistantRuntime({
    db: w.t.db,
    clock: w.clock,
    newId: w.newId,
    env: w.env,
    messaging: w.rt,
    provider: new SimAiProvider(model),
    judgeProvider: judge ? new SimAiProvider(judge) : new SimAiProvider(),
  })
  rt.turnDeps.retryBackoffMs = () => 5
  w.clock.advance(3 * 3600_000)
  const phone = w.customer(who).phone
  n += 1
  const ev = w.signed('sms:received', { messageId: `review-in-${n}`, sender: phone, recipient: '+18623885827', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
  const c = await w.t.db.selectFrom('assistant_conversations').select('id').where('phone_e164', '=', phone).executeTakeFirstOrThrow()
  const r = await runTurn(rt.turnDeps, c.id)
  return { conversationId: c.id, turnId: 'turnId' in r ? r.turnId! : '' }
}

const pass = simText('{"reason":"fine","category":"none","ok":true}')
const fail = (category: string) => simText(JSON.stringify({ reason: 'not allowed', category, ok: false }))
const ctx = () => ({ locationId: w.locationId, now: w.clock.now() })

describe('the review of real conversations (ADR 0174 §5)', () => {
  it('lists the conversations with their flags, filtered and paged, inside the window', async () => {
    const maria = await turn('Maria Delgado', 'Any deals? my other phone is 201-555-0199', [simText('Sure, a discount on your next wash.'), simText('A team member can tell you about that.')], [fail('promise'), pass])
    const liam = await turn('Liam Chen', 'Are you open today?', [{ error: 'unavailable' }, { error: 'unavailable' }])
    const all = await listConversations(w.t.db, { ...ctx(), days: 30, filter: 'all', limit: 50 })
    expect(all.conversations.map((c) => c.id)).toEqual([liam.conversationId, maria.conversationId])
    const m = all.conversations.find((c) => c.id === maria.conversationId)!
    expect(m).toMatchObject({ client: { firstName: 'Maria', phoneLast4: `•••${w.customer('Maria Delgado').phone.slice(-4)}` }, turns: 1, handoff: null, flags: ['judge'] })
    const l = all.conversations.find((c) => c.id === liam.conversationId)!
    expect(l.flags).toEqual(['handed_off', 'fallback'])
    expect(l.handoff).toEqual({ open: true, reason: 'fallback' })
    expect((await listConversations(w.t.db, { ...ctx(), days: 30, filter: 'judge', limit: 50 })).conversations.map((c) => c.id)).toEqual([maria.conversationId])
    // pages
    const p1 = await listConversations(w.t.db, { ...ctx(), days: 30, filter: 'all', limit: 1 })
    expect(p1.conversations.map((c) => c.id)).toEqual([liam.conversationId])
    const p2 = await listConversations(w.t.db, { ...ctx(), days: 30, filter: 'all', limit: 1, cursor: p1.nextCursor! })
    expect([p2.conversations.map((c) => c.id), p2.nextCursor]).toEqual([[maria.conversationId], null])
    // the window: nothing older than `days` (at most 90)
    w.clock.advance(91 * 86_400_000)
    expect((await listConversations(w.t.db, { ...ctx(), days: 90, filter: 'all', limit: 50 })).conversations).toEqual([])
    await expect(getConversation(w.t.db, { ...ctx(), id: maria.conversationId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('shows one conversation turn by turn, redacted, in plain words; a correction made from a turn is linked and reaches the model as Q and A only', async () => {
    const t = await turn('Maria Delgado', 'Any deals? text my wife at 201-555-0199', [simToolUse('list_services', { category: null }), simText('Sure, a discount on your next wash.'), simText('A team member can tell you about that.')], [fail('promise'), pass])
    const v = await getConversation(w.t.db, { ...ctx(), id: t.conversationId })
    expect(v.turns).toHaveLength(1)
    const turn0 = v.turns[0]!
    expect(turn0.clientTexts).toHaveLength(1)
    expect(turn0.clientTexts[0]).toMatch(/^Any deals\? text my wife at /)
    expect(turn0.clientTexts[0]).not.toContain('555-0199')
    expect(turn0.reply).toContain('A team member can tell you about that.')
    expect(turn0.judge).toEqual({ verdict: 'pass', category: 'none', words: 'passed' })
    expect(turn0.tools).toEqual(['list_services'])
    expect(turn0.promptVersion).toMatch(/^q3d-/)
    expect(turn0.correctionEntryId).toBeNull()
    const entry = await w.t.db.transaction().execute((tx) =>
      createCorrection(tx, {
        locationId: w.locationId,
        userId: null,
        audit: { actor: { userId: null, name: 'Owner' } } as never,
        newId: w.newId,
        now: w.clock.now(),
        maxChars: 20_000,
        shopNumbers: ['+18623885827', '+12015986304'],
        canViewClients: true,
      }, { clientText: 'Any deals this week?', rightAnswer: 'We do not run deals by text; the team can tell you more.', source: 'live', assistantTurnId: t.turnId }),
    )
    expect(entry.wrongReply).toContain('A team member can tell you about that.')
    expect((await getConversation(w.t.db, { ...ctx(), id: t.conversationId })).turns[0]!.correctionEntryId).toBe(entry.id)
    expect((await listConversations(w.t.db, { ...ctx(), days: 30, filter: 'corrected', limit: 50 })).conversations.map((c) => c.id)).toEqual([t.conversationId])
    const block = renderShopKnowledge({ knowledge: await loadActiveKnowledge(w.t.db, w.locationId), contact: { textingNumber: '+18623885827', callingNumber: '+12015986304' } as never })
    expect(block).toContain('> Q: "Any deals this week?" A: "We do not run deals by text; the team can tell you more."')
    expect(block).not.toContain('A team member can tell you about that.')
  })
})
