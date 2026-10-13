// The practice jobs (ADR 0174 §4c), each run twice: the second run changes nothing (the dedicated suite of test/jobs/matrix.test.ts).
//   ai.practice                    answers a running turn once; a turn already answered is left as it is; practice off fails it
//   assistant.practice.retention   deletes sessions older than 30 days and fails turns stuck running; a second run finds nothing
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { runSeed } from '../../db/seeds/index.js'
import { SimAiProvider, simText } from '../../src/integrations/ai/sim.js'
import { aiPracticeJob, handlePracticeJob, practiceJobs, practiceRetentionJob } from '../../src/modules/assistant/practice/jobs.js'
import { createTurn } from '../../src/modules/assistant/practice/service.js'
import { useWorld } from '../messaging-db/world.js'
import { newSession, practiceContext, practiceDeps, quiet, useReadOnly } from './helpers.js'

const w = useWorld({ env: { AI_PRACTICE_ENABLED: 'true', BUSINESS_PHONE: '+12015986304', BUSINESS_TEXT_NUMBER: '+18623885827' } })
const readDb = useReadOnly(w)
const job = () => ({ db: w.t.db, clock: w.clock, logger: quiet as never })

beforeAll(async () => {
  await runSeed({ db: w.t.db, clock: w.clock, profile: 'website-catalog' })
})

beforeEach(async () => {
  await sql`truncate table assistant_practice_sessions cascade`.execute(w.t.db)
})

async function running(sessionId: string, text = 'Are you open?'): Promise<string> {
  const c = await practiceContext(w)
  return (await w.t.db.transaction().execute((tx) => createTurn(tx, c, sessionId, text))).id
}

const turns = () => w.t.db.selectFrom('assistant_practice_turns').select(['id', 'status', 'reply_text', 'error', 'finished_at']).orderBy('started_at').orderBy('id').execute()

describe('the practice jobs', () => {
  it('are registered: ai.practice queue-only (no retry, 3 minutes), the retention daily', () => {
    expect(practiceJobs.map((j) => j.name)).toEqual(['ai.practice', 'assistant.practice.retention'])
    expect(aiPracticeJob).toMatchObject({ policy: 'standard', retryLimit: 0, expireInSeconds: 180 })
    expect(aiPracticeJob.cron).toBeUndefined()
    expect(practiceRetentionJob.cron).toBe('35 3 * * *')
  })

  it('ai.practice answers a running turn once; the second run changes nothing', async () => {
    const sessionId = await newSession(w, { persona: 'new_texter' })
    const turnId = await running(sessionId)
    const provider = new SimAiProvider([simText('Yes, we are open today.')])
    const deps = practiceDeps(w, readDb(), { provider, judge: new SimAiProvider() })
    await handlePracticeJob(job(), { turnId }, { env: w.env, deps })
    const first = JSON.stringify(await turns())
    expect((await turns())[0]).toMatchObject({ status: 'replied', error: null })
    await handlePracticeJob(job(), { turnId }, { env: w.env, deps })
    expect(JSON.stringify(await turns())).toBe(first)
    expect(provider.requests).toHaveLength(1)
    // the creator is told (assistant.practice.turn on the notifications channel, to them only)
    const ev = await w.t.db.selectFrom('realtime_events').select(['channel', 'type', 'payload', 'target_user_id']).where('type', '=', 'assistant.practice.turn').execute()
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ channel: 'notifications', payload: { sessionId, turnId } })
    expect(ev[0]!.target_user_id).not.toBeNull()
  })

  it('ai.practice while AI_PRACTICE_ENABLED is off: the queued turn fails (practice_off), no model call', async () => {
    const sessionId = await newSession(w, { persona: 'new_texter' })
    const turnId = await running(sessionId)
    const provider = new SimAiProvider([])
    const deps = practiceDeps(w, readDb(), { provider, judge: new SimAiProvider() })
    for (let i = 0; i < 2; i++) await handlePracticeJob(job(), { turnId }, { env: { ...w.env, AI_PRACTICE_ENABLED: false }, deps })
    expect((await turns())[0]).toMatchObject({ status: 'failed', error: 'practice_off' })
    expect(provider.requests).toHaveLength(0)
  })

  it('assistant.practice.retention: sessions older than 30 days go with their turns, a stuck turn fails; the second run changes nothing', async () => {
    const old = await newSession(w, { persona: 'new_texter' })
    const kept = await newSession(w, { persona: 'new_texter' })
    await running(old)
    const stuck = await running(kept)
    await w.t.db.updateTable('assistant_practice_sessions').set({ created_at: new Date(w.clock.now().getTime() - 31 * 86_400_000) }).where('id', '=', old).execute()
    w.clock.advance(10 * 60_000)
    await practiceRetentionJob.handler(job(), {} as never, {} as never)
    const first = JSON.stringify({ s: await w.t.db.selectFrom('assistant_practice_sessions').select('id').orderBy('id').execute(), t: await turns() })
    expect((await w.t.db.selectFrom('assistant_practice_sessions').select('id').execute()).map((x) => x.id)).toEqual([kept])
    expect(await turns()).toEqual([expect.objectContaining({ id: stuck, status: 'failed', error: 'timeout' })])
    await practiceRetentionJob.handler(job(), {} as never, {} as never)
    expect(JSON.stringify({ s: await w.t.db.selectFrom('assistant_practice_sessions').select('id').orderBy('id').execute(), t: await turns() })).toBe(first)
  })
})
