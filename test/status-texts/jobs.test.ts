// appointments.checkin_texts and appointments.late_texts through the real pg-boss worker (src/worker.ts), on the `design` seed with
// the frozen clock the tests move: the checked-in text goes once its 3 minutes are up, the running-late text once the wash runs past
// its promised end + grace; a second run sends nothing more; with the settings off (the defaults) both jobs do nothing.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import type { Actor, SchedulingCtx } from '../../src/modules/scheduling/context.js'
import { arriveAppointment, startCleaning } from '../../src/modules/scheduling/lifecycle.js'
import { checkinTextsJob, lateTextsJob } from '../../src/modules/status-texts/jobs.js'
import type { Tx } from '../../src/platform/db.js'
import { NIL_UUID } from '../../src/platform/ids.js'
import { updateSetting } from '../../src/platform/settings.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { useJobsHarness } from '../jobs/harness.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld({ start: '2026-06-12T10:00:00-04:00' })
const h = useJobsHarness({ testDb: () => w.t })

const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  // the job handlers build their messaging runtime from the process environment
  const vars = {
    DATABASE_URL: testDatabaseUrl(),
    DB_SEARCH_PATH: `${w.t.schema},public`,
    SMS_ALLOWLIST: w.env.SMS_ALLOWLIST,
    SMSGATE_MIN_INTERVAL_MS: '0',
    EMAIL_CONSOLE_DIR: w.env.EMAIL_CONSOLE_DIR,
  }
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
})
afterEach(async () => {
  await sql`delete from settings where key like 'status_texts.%'`.execute(w.t.db)
})

const defs = [checkinTextsJob, lateTextsJob] as never

async function runThroughQueue(worker: Awaited<ReturnType<typeof h.start>>, name: string): Promise<void> {
  const before = (await h.states(worker.schema, name)).filter((s) => s === 'completed').length
  await worker.jobs.enqueue(name, {})
  await h.waitFor(async () => (await h.states(worker.schema, name)).filter((s) => s === 'completed').length > before)
}

const actor = (): Actor => ({
  auth: { userId: NIL_UUID, employeeId: null, locationId: w.locationId, permissions: new Set(['jobs.status', 'sched.edit']), actorName: 'Desk' },
  audit: { actor: { userId: null, name: 'Desk' } },
})
const step = async (fn: (tx: Tx, c: SchedulingCtx) => Promise<unknown>): Promise<void> => {
  const c = await w.rt.schedulingCtx(w.locationId)
  await w.tx((tx) => fn(tx, c))
}
const statusTexts = (id: string) =>
  w.t.db
    .selectFrom('messages')
    .select(['template_key', 'purpose'])
    .where('appointment_id', '=', id)
    .where('purpose', 'in', ['checked_in', 'running_late'])
    .orderBy('queued_at')
    .execute()

describe('the status-text jobs through the worker', () => {
  it('off (the defaults): both run and send nothing', async () => {
    const id = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-12T10:00:00-04:00' })
    await step((tx, c) => arriveAppointment(tx, c, actor(), id))
    await step((tx, c) => startCleaning(tx, c, actor(), id))
    const worker = await h.start({ definitions: defs })
    w.clock.set('2026-06-12T10:50:00-04:00')
    await runThroughQueue(worker, 'appointments.checkin_texts')
    await runThroughQueue(worker, 'appointments.late_texts')
    expect(await statusTexts(id)).toEqual([])
  })

  it('on: the checked-in text after 3 minutes and the running-late text past the promised end + grace, each once', async () => {
    await w.tx(async (tx) => {
      for (const key of ['status_texts.checked_in', 'status_texts.running_late'] as const) await updateSetting(tx, { locationId: w.locationId, key, value: true })
    })
    const id = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-12T10:00:00-04:00' })
    await step((tx, c) => arriveAppointment(tx, c, actor(), id))
    const worker = await h.start({ definitions: defs })
    w.clock.set('2026-06-12T10:03:00-04:00')
    await runThroughQueue(worker, 'appointments.checkin_texts')
    await runThroughQueue(worker, 'appointments.checkin_texts')
    expect(await statusTexts(id)).toEqual([{ template_key: 'welcome', purpose: 'checked_in' }])

    await step((tx, c) => startCleaning(tx, c, actor(), id)) // cleaning from 10:03: promised end 10:38, due 10:48
    w.clock.set('2026-06-12T10:49:00-04:00')
    await runThroughQueue(worker, 'appointments.late_texts')
    await runThroughQueue(worker, 'appointments.late_texts')
    expect(await statusTexts(id)).toEqual([
      { template_key: 'welcome', purpose: 'checked_in' },
      { template_key: 'job_delay', purpose: 'running_late' },
    ])
    expect(h.logs.some((l) => l.msg === 'checked-in texts processed')).toBe(true)
    expect(h.logs.some((l) => l.msg === 'running-late texts processed')).toBe(true)
    expect(JSON.stringify(h.logs)).not.toContain('Maria')
  })
})
