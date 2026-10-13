// The practice chat's and the corrections' routes (ADR 0174 §4c, §5, §6; api-spec 15.6e and 15.6f): a session is its creator's own
// (another user's is 404), a client persona needs cli.view, a text is a running turn answered by job ai.practice (queued after the
// commit, never twice for an idempotent replay), one running turn a session (409 PRACTICE_BUSY), the switches and limits
// (PRACTICE_OFF, PRACTICE_BUDGET, PRACTICE_LIMIT, PRACTICE_ENDED), "Try again", and corrections: the wrong reply loaded on the
// server (never the browser's), one per question (409 CORRECTION_EXISTS, or replaced), the budget, and the correction in the
// knowledge block of the re-run.
import { describe, expect, it } from 'vitest'
import { SimAiProvider, simText } from '../../src/integrations/ai/sim.js'
import { buildShopFacts } from '../../src/modules/assistant/facts.js'
import { emptyPracticeState } from '../../src/modules/assistant/practice/effects.js'
import { handlePracticeJob } from '../../src/modules/assistant/practice/jobs.js'
import { practiceConfig, type PracticeDeps } from '../../src/modules/assistant/practice/runner.js'
import { createToolRegistry } from '../../src/modules/assistant/tools/index.js'
import { json, type Session } from '../settings-http/harness.js'
import { useKnowledgeHarness } from '../assistant-knowledge/harness.js'

const h = useKnowledgeHarness({ env: { AI_PRACTICE_ENABLED: 'true', AI_PRACTICE_DAILY_BUDGET_USD: '3', AI_KNOWLEDGE_MAX_CHARS: '2000' } })
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }
let keyN = 0
const key = (): Record<string, string> => ({ 'idempotency-key': `practice-key-${String(++keyN).padStart(6, '0')}` })

async function session(s: Session, body: Record<string, unknown> = { persona: 'new_texter' }): Promise<{ id: string }> {
  const r = await h.call('POST', 'assistant/practice/sessions', { session: s, body })
  expect(r.statusCode, r.body).toBe(201)
  return json(r).session as { id: string }
}

async function text(s: Session, sessionId: string, t: string, headers = key()) {
  return h.call('POST', `assistant/practice/sessions/${sessionId}/turns`, { session: s, body: { text: t }, headers })
}

async function customer(name: string): Promise<string> {
  const id = h.fx.newId()
  await h.db
    .insertInto('customers')
    .values({ id, full_name: name, phone_e164: '+12015550142', phone_display: '(201) 555-0142', sms_opted_in: true, source: 'online' } as never)
    .execute()
  return id
}

/** Answers a turn as the worker would, with a simulated model. */
async function answer(turnId: string, reply: string): Promise<SimAiProvider> {
  const provider = new SimAiProvider([simText(reply)])
  const deps: PracticeDeps = {
    db: h.db,
    readDb: h.db,
    clock: h.clock,
    newId: h.fx.newId,
    env: h.t.env,
    cfg: practiceConfig(h.t.env),
    provider,
    judge: new SimAiProvider(),
    registry: createToolRegistry({} as never),
    facts: buildShopFacts({ db: h.db, clock: h.clock, env: h.t.env }),
    log: quiet,
  }
  await handlePracticeJob({ db: h.db, clock: h.clock, logger: quiet as never }, { turnId }, { env: h.t.env, deps })
  return provider
}

describe('practice sessions (ADR 0174 §4c)', () => {
  it('are their creator’s own: create, list with the switches and budget, read, delete; another user gets 404', async () => {
    const s = await h.admin()
    const created = await session(s, { persona: 'new_texter', verified: true, language: 'es' })
    expect(created).toMatchObject({ persona: 'new_texter', client: null, verified: true, language: 'es', includeEntryIds: [], turns: 0, costMicros: 0 })
    const list = json(await h.call('GET', 'assistant/practice/sessions', { session: s }))
    expect(list.sessions.map((x: { id: string }) => x.id)).toEqual([created.id])
    expect(list.practice).toEqual({ enabled: true, budgetUsd: 3, spentTodayUsd: 0, actionsEnabled: false, linksEnabled: false })
    expect(json(await h.call('GET', `assistant/practice/sessions/${created.id}`, { session: s }))).toMatchObject({ session: { id: created.id }, turns: [] })
    const other = await h.withPermissions(['set.assistant'])
    expect((await h.call('GET', `assistant/practice/sessions/${created.id}`, { session: other })).statusCode).toBe(404)
    expect((await h.call('DELETE', `assistant/practice/sessions/${created.id}`, { session: other })).statusCode).toBe(404)
    expect(json(await h.call('GET', 'assistant/practice/sessions', { session: other })).sessions).toEqual([])
    expect((await h.call('DELETE', `assistant/practice/sessions/${created.id}`, { session: s })).statusCode).toBe(204)
    expect((await h.call('GET', `assistant/practice/sessions/${created.id}`, { session: s })).statusCode).toBe(404)
  })

  it('a real client persona needs cli.view and a client of the shop; its first name shows', async () => {
    const id = await customer('Maria Delgado')
    const noClients = await h.withPermissions(['set.assistant'])
    expect((await h.call('POST', 'assistant/practice/sessions', { session: noClients, body: { persona: 'client', customerId: id } })).statusCode).toBe(403)
    const s = await h.withPermissions(['set.assistant', 'cli.view'])
    expect((await h.call('POST', 'assistant/practice/sessions', { session: s, body: { persona: 'client', customerId: h.fx.newId() } })).statusCode).toBe(404)
    expect(await session(s, { persona: 'client', customerId: id })).toMatchObject({ persona: 'client', client: { id, firstName: 'Maria' } })
    // a draft to try must exist
    expect((await h.call('POST', 'assistant/practice/sessions', { session: s, body: { persona: 'new_texter', includeEntryIds: [h.fx.newId()] } })).statusCode).toBe(422)
  })

  it('a text is a running turn answered by ai.practice (queued once, never on a replay); one running turn a session', async () => {
    const s = await h.admin()
    const { id } = await session(s)
    expect((await h.call('POST', `assistant/practice/sessions/${id}/turns`, { session: s, body: { text: 'Hi' } })).statusCode).toBe(400)
    const headers = key()
    const r = await text(s, id, 'Do you have a lounge?', headers)
    expect(r.statusCode, r.body).toBe(202)
    const turn = json(r).turn
    expect(turn).toMatchObject({ seq: 1, rerunOf: null, clientText: 'Do you have a lounge?', status: 'running', replyText: null, extraTexts: [], badges: [] })
    expect(h.queued).toEqual([{ name: 'ai.practice', data: { turnId: turn.id }, opts: undefined }])
    // the same key again: the stored answer, no second job
    const again = await text(s, id, 'Do you have a lounge?', headers)
    expect([again.statusCode, json(again).turn.id, again.headers['idempotent-replayed']]).toEqual([202, turn.id, 'true'])
    expect(h.queued).toHaveLength(1)
    expect(json(await text(s, id, 'Hello?')).code).toBe('PRACTICE_BUSY')
    // a turn still running after 5 minutes failed (a job that died): the session takes texts again
    h.clock.advance(6 * 60_000)
    const next = await text(s, id, 'Hello?')
    expect(next.statusCode).toBe(202)
    expect(json(next).turn.seq).toBe(2)
    const view = json(await h.call('GET', `assistant/practice/sessions/${id}`, { session: s }))
    expect(view.turns.map((t: { status: string; error: string | null }) => [t.status, t.error])).toEqual([
      ['failed', 'timeout'],
      ['running', null],
    ])
  })

  it('the switches and limits: off (409), the day’s budget (429), 40 turns (429), an opted-out chat (409)', async () => {
    const s = await h.admin()
    const { id } = await session(s)
    const env = h.t.app.env as { AI_PRACTICE_ENABLED: boolean }
    env.AI_PRACTICE_ENABLED = false
    try {
      expect(json(await h.call('POST', 'assistant/practice/sessions', { session: s, body: { persona: 'new_texter' } })).code).toBe('PRACTICE_OFF')
      expect(json(await text(s, id, 'Hi')).code).toBe('PRACTICE_OFF')
    } finally {
      env.AI_PRACTICE_ENABLED = true
    }
    // today's practice spend reached the budget
    await h.db
      .insertInto('assistant_practice_turns')
      .values({ id: h.fx.newId(), session_id: id, seq: 1, rerun_of: null, client_text: 'x', status: 'replied', cost_micros: 3_000_000, finished_at: h.clock.now(), started_at: h.clock.now() })
      .execute()
    const spent = await text(s, id, 'Hi')
    expect([spent.statusCode, json(spent).code]).toEqual([429, 'PRACTICE_BUDGET'])
    expect(json(await h.call('GET', 'assistant/practice/sessions', { session: s })).practice.spentTodayUsd).toBe(3)
    await h.db.updateTable('assistant_practice_turns').set({ cost_micros: 0 }).execute()
    await h.db.updateTable('assistant_practice_sessions').set({ turns: 40 }).where('id', '=', id).execute()
    const full = await text(s, id, 'Hi')
    expect([full.statusCode, json(full).code]).toEqual([429, 'PRACTICE_LIMIT'])
    await h.db.updateTable('assistant_practice_sessions').set({ turns: 1, state: JSON.stringify({ ...emptyPracticeState(), optedOut: true }) }).where('id', '=', id).execute()
    expect(json(await text(s, id, 'Hi')).code).toBe('PRACTICE_ENDED')
  })
})

describe('corrections and "Try again" (ADR 0174 §5)', () => {
  it('a correction from a practice turn: the wrong reply loaded on the server; the re-run reads the correction, never the wrong reply', async () => {
    const s = await h.admin()
    const { id } = await session(s)
    const turn = json(await text(s, id, 'Do you have a waiting room?')).turn
    await answer(turn.id, 'No, we have no waiting room.')
    const done = json(await h.call('GET', `assistant/practice/sessions/${id}`, { session: s })).turns[0]
    expect(done.status).toBe('replied')
    const r = await h.call('POST', 'assistant/corrections', {
      session: s,
      body: { clientText: 'Do you have a waiting room?', rightAnswer: 'Yes, a lounge with wifi and coffee.', source: 'practice', practiceTurnId: turn.id },
    })
    expect(r.statusCode, r.body).toBe(201)
    const entry = json(r).entry
    expect(entry).toMatchObject({ kind: 'correction', question: 'Do you have a waiting room?', body: 'Yes, a lounge with wifi and coffee.', source: 'practice', active: true })
    expect(entry.wrongReply).toContain('No, we have no waiting room.')
    expect(json(r).budget.parts.corrections).toBe(entry.chars)
    // "Try again": the same text, from the session as it was, as an alternate turn that reads the correction
    const rerun = await h.call('POST', `assistant/practice/turns/${turn.id}/rerun`, { session: s })
    expect(rerun.statusCode, rerun.body).toBe(202)
    expect(json(rerun).turn).toMatchObject({ rerunOf: turn.id, seq: 1, clientText: 'Do you have a waiting room?', status: 'running' })
    expect(h.queued.at(-1)).toEqual({ name: 'ai.practice', data: { turnId: json(rerun).turn.id }, opts: undefined })
    const model = await answer(json(rerun).turn.id, 'Yes, we have a lounge with wifi and coffee.')
    const system = JSON.stringify(model.requests[0]!.system)
    expect(system).toContain('> Q: \\"Do you have a waiting room?\\" A: \\"Yes, a lounge with wifi and coffee.\\"')
    expect(system).not.toContain('no waiting room')
    // the re-run's history is the turns before the original, not the original's own answer
    expect(JSON.stringify(model.requests[0]!.messages)).not.toContain('no waiting room')
  })

  it('one correction per question (409 with its id, or replaced in place); the budget; a live turn needs cli.view; another user’s practice is 404', async () => {
    const s = await h.admin()
    const body = { clientText: 'Do you take Apple Pay?', rightAnswer: 'Yes, at the counter.', source: 'practice' }
    const first = json(await h.call('POST', 'assistant/corrections', { session: s, body }))
    const dup = await h.call('POST', 'assistant/corrections', { session: s, body: { ...body, clientText: 'do you take apple pay' } })
    expect([dup.statusCode, json(dup).code, json(dup).meta?.entryId ?? json(dup).entryId]).toEqual([409, 'CORRECTION_EXISTS', first.entry.id])
    const replaced = json(await h.call('POST', 'assistant/corrections', { session: s, body: { ...body, rightAnswer: 'Yes, cards and Apple Pay.', replaceEntryId: first.entry.id } }))
    expect(replaced.entry).toMatchObject({ id: first.entry.id, body: 'Yes, cards and Apple Pay.', version: 2 })
    // over the budget (2,000 characters here): refused, or saved as a draft
    const long = { clientText: 'Tell me everything about ceramic coating care', rightAnswer: 'x'.repeat(480), source: 'practice' }
    await h.db.updateTable('assistant_knowledge').set({ chars: 1900 }).where('id', '=', first.entry.id).execute()
    expect(json(await h.call('POST', 'assistant/corrections', { session: s, body: long })).code).toBe('KNOWLEDGE_BUDGET')
    expect(json(await h.call('POST', 'assistant/corrections', { session: s, body: { ...long, active: false } })).entry.active).toBe(false)
    // a live turn: only for a reader of clients
    const noClients = await h.withPermissions(['set.assistant'])
    expect(
      (await h.call('POST', 'assistant/corrections', { session: noClients, body: { ...body, clientText: 'Other?', source: 'live', assistantTurnId: h.fx.newId() } })).statusCode,
    ).toBe(403)
    // another user's practice turn is not theirs
    const { id } = await session(s)
    const turn = json(await text(s, id, 'Hi')).turn
    expect((await h.call('POST', 'assistant/corrections', { session: noClients, body: { ...body, clientText: 'Hi?', practiceTurnId: turn.id } })).statusCode).toBe(404)
    // plain text only
    expect((await h.call('POST', 'assistant/corrections', { session: s, body: { ...body, clientText: 'Hours?', rightAnswer: '<b>8 to 6</b>' } })).statusCode).toBe(422)
  })

  it('a wrong reply that may hold a real client’s words (a live turn, a client on file) is shown only with cli.view (verifier F3)', async () => {
    const clients = await h.withPermissions(['set.assistant', 'cli.view'])
    const noClients = await h.withPermissions(['set.assistant'])
    // a correction from a practice turn with a real client on file
    const maria = await customer('Maria Delgado')
    const real = await session(clients, { persona: 'client', customerId: maria })
    const t1 = json(await text(clients, real.id, 'What do I owe?')).turn
    await answer(t1.id, 'Hi Maria, the team can tell you your balance.')
    const fromClient = json(
      await h.call('POST', 'assistant/corrections', { session: clients, body: { clientText: 'What do I owe?', rightAnswer: 'The team can check that for you.', source: 'practice', practiceTurnId: t1.id } }),
    ).entry
    expect(fromClient.wrongReply).toContain('Hi Maria')
    // a correction from a synthetic new texter: nobody real is in it
    const synthetic = await session(noClients)
    const t2 = json(await text(noClients, synthetic.id, 'Do you have a lounge?')).turn
    await answer(t2.id, 'No, we have no lounge.')
    const fromSynthetic = json(
      await h.call('POST', 'assistant/corrections', { session: noClients, body: { clientText: 'Do you have a lounge?', rightAnswer: 'Yes, with wifi.', source: 'practice', practiceTurnId: t2.id } }),
    ).entry
    expect(fromSynthetic.wrongReply).toContain('no lounge')
    // a correction from a real conversation (its turn since deleted: the source still says live)
    const loc = (await h.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id
    const liveId = h.fx.newId()
    await h.db
      .insertInto('assistant_knowledge')
      .values({ id: liveId, location_id: loc, kind: 'correction', title: 'When is my visit?', question: 'When is my visit?', body: 'The team can confirm it.', wrong_reply: 'Hi Liam, your visit is Monday at 10.', source: 'live', active: false, chars: 40 } as never)
      .execute()
    const byId = (entries: Array<{ id: string; wrongReply: string | null }>) => Object.fromEntries(entries.map((e) => [e.id, e.wrongReply]))
    const hidden = byId(json(await h.call('GET', 'assistant/knowledge', { session: noClients })).entries)
    expect(hidden[fromClient.id]).toBeNull()
    expect(hidden[liveId]).toBeNull()
    expect(hidden[fromSynthetic.id]).toContain('no lounge')
    const shown = byId(json(await h.call('GET', 'assistant/knowledge', { session: clients })).entries)
    expect(shown[fromClient.id]).toContain('Hi Maria')
    expect(shown[liveId]).toBe('Hi Liam, your visit is Monday at 10.')
    expect(shown[fromSynthetic.id]).toContain('no lounge')
    // an edit answers the entry the same way
    const edited = await h.call('PUT', `assistant/knowledge/${liveId}`, { session: noClients, body: { version: 1, body: 'The team can confirm your visit.' } })
    expect(edited.statusCode, edited.body).toBe(200)
    expect(json(edited).entry.wrongReply).toBeNull()
    // once the practice session is gone, who was in it is unknown: hidden too
    await h.db.deleteFrom('assistant_practice_sessions').where('id', '=', synthetic.id).execute()
    expect(byId(json(await h.call('GET', 'assistant/knowledge', { session: noClients })).entries)[fromSynthetic.id]).toBeNull()
  })
})
