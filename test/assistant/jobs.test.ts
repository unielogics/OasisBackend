// The assistant's jobs (ADR 0160, design section 3): ai.respond (stately per conversation, the 8 s debounce and its deferral up to
// 45 s, then one turn) and ai.sweep (re-kicks markers older than 30 s, fails leases older than 3 minutes with the fallback and a
// handoff); the kick of the webhook path; both jobs twice through the REAL worker (the second run changes nothing).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { SimAiProvider, simText } from '../../src/integrations/ai/sim.js'
import { aiRespondJob, aiSweepJob, assistantJobs } from '../../src/modules/assistant/jobs.js'
import { AssistantRuntime, jobsKick } from '../../src/modules/assistant/runtime.js'
import { jobDefinitions } from '../../src/platform/job-registry.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { useJobsHarness } from '../jobs/harness.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld({ env: { AI_ENABLED: 'true' } })
const h = useJobsHarness({ testDb: () => w.t })

const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries({
    DATABASE_URL: testDatabaseUrl(),
    DB_SEARCH_PATH: `${w.t.schema},public`,
    SMS_ALLOWLIST: w.env.SMS_ALLOWLIST,
    SMSGATE_MIN_INTERVAL_MS: '0',
    AI_ENABLED: 'true',
  })) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
})

beforeEach(async () => {
  await sql`truncate table assistant_conversations cascade`.execute(w.t.db)
  await sql`delete from settings where key like 'assistant.%'`.execute(w.t.db)
  await setting('assistant.enabled', true)
  await setting('assistant.stage', 'everyone')
})

async function setting(key: string, value: unknown): Promise<void> {
  await sql`insert into settings (location_id, key, value) values (${w.locationId}, ${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (location_id, key) do update set value = excluded.value`.execute(w.t.db)
}

let n = 0
async function inbound(from: string, text: string): Promise<void> {
  n += 1
  const ev = w.signed('sms:received', { messageId: `jobs-in-${n}`, sender: from, recipient: '+18623885827', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
}

const maria = (): string => w.customer('Maria Delgado').phone
const conversation = () => w.t.db.selectFrom('assistant_conversations').selectAll().executeTakeFirstOrThrow()
const aiTexts = () =>
  w.t.db.selectFrom('messages').select(['klass', 'body']).where('direction', '=', 'out').where('peer_e164', '=', maria()).where('sender_kind', '=', 'ai').orderBy('queued_at').execute()

function runtime(steps = [simText('We are open until 6 PM.')]) {
  const enqueued: Array<{ name: string; data: object; opts: unknown }> = []
  const provider = new SimAiProvider(steps)
  const rt = new AssistantRuntime({
    db: w.t.db,
    clock: w.clock,
    newId: w.newId,
    env: w.env,
    messaging: w.rt,
    provider,
    enqueue: async (name, data, opts) => {
      enqueued.push({ name, data, opts })
      return 'job'
    },
  })
  return { rt, enqueued, provider }
}

describe('the definitions', () => {
  it('ai.respond is queue-only and stately; ai.sweep runs every minute, stately; both are registered', () => {
    expect(aiRespondJob).toMatchObject({ name: 'ai.respond', policy: 'stately', retryLimit: 0, expireInSeconds: 180 })
    expect(aiRespondJob.cron).toBeUndefined()
    expect(aiSweepJob).toMatchObject({ name: 'ai.sweep', cron: '* * * * *', policy: 'stately', retryLimit: 0 })
    expect(jobDefinitions.map((j) => j.name)).toEqual(expect.arrayContaining(['ai.respond', 'ai.sweep']))
    expect(assistantJobs.map((j) => j.name)).toEqual(['ai.respond', 'ai.sweep'])
  })

  it('the kick enqueues one ai.respond per conversation, debounced, keyed by the conversation', async () => {
    const calls: unknown[][] = []
    await jobsKick(async (...a) => {
      calls.push(a)
      return null
    }, 8000).kick(['c1', 'c1', 'c2'])
    expect(calls).toEqual([
      ['ai.respond', { conversationId: 'c1' }, { singletonKey: 'c1', startAfter: 8 }],
      ['ai.respond', { conversationId: 'c2' }, { singletonKey: 'c2', startAfter: 8 }],
    ])
  })
})

describe('ai.respond: the debounce', () => {
  it('defers while the newest text is under 8 s old, then answers the burst once', async () => {
    const { rt, enqueued, provider } = runtime()
    await inbound(maria(), 'hi')
    const id = (await conversation()).id
    expect(await rt.respond(id)).toEqual({ status: 'deferred' })
    expect(enqueued).toEqual([{ name: 'ai.respond', data: { conversationId: id }, opts: { singletonKey: id, startAfter: 8 } }])
    w.clock.advance(6000)
    await inbound(maria(), 'are you open today?')
    w.clock.advance(3000)
    expect(await rt.respond(id)).toEqual({ status: 'deferred' })
    expect(enqueued[1]!.opts).toEqual({ singletonKey: id, startAfter: 5 })
    expect(provider.requests).toHaveLength(0)
    w.clock.advance(5000)
    expect(await rt.respond(id)).toMatchObject({ status: 'replied' })
    expect(provider.requests).toHaveLength(1)
    expect(JSON.stringify(provider.requests[0]!.messages)).toContain('are you open today?')
    expect(await aiTexts()).toHaveLength(1)
    expect(await rt.respond(id)).toEqual({ status: 'none' })
  })

  it('answers at the latest 45 s after the first text, even while texts keep coming', async () => {
    const { rt } = runtime()
    await inbound(maria(), 'one')
    const id = (await conversation()).id
    for (let i = 0; i < 4; i++) {
      w.clock.advance(12_000)
      await inbound(maria(), `more ${i}`)
    }
    // the first text is 48 s old, the newest 0 s
    expect(await rt.respond(id)).toMatchObject({ status: 'replied' })
  })
})

describe('ai.sweep', () => {
  it('re-kicks markers older than 30 s that no turn holds, and leaves fresh or running ones', async () => {
    const { rt, enqueued } = runtime()
    await inbound(maria(), 'hello')
    expect(await rt.sweep()).toEqual({ kicked: 0, leasesFailed: 0 })
    w.clock.advance(31_000)
    const id = (await conversation()).id
    expect(await rt.sweep()).toEqual({ kicked: 1, leasesFailed: 0 })
    expect(enqueued).toEqual([{ name: 'ai.respond', data: { conversationId: id }, opts: { singletonKey: id } }])
    await w.t.db.updateTable('assistant_conversations').set({ running_since: w.clock.now() }).execute()
    expect(await rt.sweep()).toEqual({ kicked: 0, leasesFailed: 0 })
  })

  it('fails a lease older than 3 minutes: the turn fails, the client gets the fallback, staff get the conversation', async () => {
    const { rt } = runtime()
    await inbound(maria(), 'hello')
    const c = await conversation()
    await w.t.db.insertInto('assistant_turns').values({ id: w.newId(), conversation_id: c.id, trust: 'known', provider: 'sim', started_at: w.clock.now() }).execute()
    await w.t.db.updateTable('assistant_conversations').set({ running_since: w.clock.now() }).execute()
    w.clock.advance(3 * 60_000 + 1000)
    expect(await rt.sweep()).toEqual({ kicked: 0, leasesFailed: 1 })
    expect(await w.t.db.selectFrom('assistant_turns').select(['status', 'error']).executeTakeFirstOrThrow()).toEqual({ status: 'failed', error: 'lease_timeout' })
    expect(await conversation()).toMatchObject({ running_since: null, pending_since: null, handoff_state: 'open', handoff_reason: 'lease_timeout' })
    expect((await aiTexts()).map((t) => t.klass)).toEqual(['ai_fallback'])
    expect(await rt.sweep()).toEqual({ kicked: 0, leasesFailed: 0 })
  })
})

describe('through the real worker, twice (the second run changes nothing)', () => {
  it('ai.respond answers once; ai.sweep fails a dead lease once', async () => {
    const worker = await h.start({ definitions: assistantJobs })
    const run = async (name: string, data: object = {}) => {
      const done = async () => (await h.states(worker.schema, name)).filter((s) => s === 'completed').length
      const before = await done()
      await worker.jobs.enqueue(name, data)
      await h.waitFor(async () => (await done()) > before, 60_000)
    }

    await inbound(maria(), 'Are you open?')
    w.clock.advance(20_000)
    const id = (await conversation()).id
    await run('ai.respond', { conversationId: id })
    const first = await aiTexts()
    expect(first).toHaveLength(1)
    await run('ai.respond', { conversationId: id })
    expect(await aiTexts()).toEqual(first)

    await w.t.db.insertInto('assistant_turns').values({ id: w.newId(), conversation_id: id, trust: 'known', provider: 'sim', started_at: w.clock.now() }).execute()
    await w.t.db.updateTable('assistant_conversations').set({ running_since: w.clock.now(), pending_since: w.clock.now() }).execute()
    w.clock.advance(4 * 60_000)
    await run('ai.sweep')
    const after = await conversation()
    expect(after).toMatchObject({ running_since: null, handoff_state: 'open', handoff_reason: 'lease_timeout' })
    await run('ai.sweep')
    expect(await conversation()).toEqual(after)
  }, 150_000)
})
