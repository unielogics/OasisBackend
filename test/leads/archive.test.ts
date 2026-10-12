// The nightly archive of the welcome flow's provisional clients (ADR 0160, owner 2026-10-11; job leads.provisional_archive; wave
// W3b): a client the assistant created that never gave a name and never booked is archived 30 days after their last text: soft
// delete + archived_at (never a delete; reversible), the lead closed, the thread kept, an audit row; a second run changes nothing.
import { describe, expect, it } from 'vitest'
import { createNewTexters } from '../../src/modules/assistant/welcome/new-texters.js'
import { createLeadJobs, PROVISIONAL_ARCHIVE_JOB } from '../../src/modules/leads/index.js'
import { STRANGER, STRANGER2, useToolWorld } from '../assistant-tools/world.js'

const w = useToolWorld()
const DAY = 86_400_000

const adopt = (phone: string) =>
  w.tx(async (tx) => (await createNewTexters(w.deps).adopt(tx, { locationId: w.locationId, phone, inboxId: w.newId(), receivedAt: w.clock.now() })) as { customerId: string } | null)
const runJob = async () => {
  const j = createLeadJobs(w.deps).find((d) => d.name === PROVISIONAL_ARCHIVE_JOB)!
  expect(j.name).toBe('leads.provisional_archive')
  await j.handler({ db: w.t.db, clock: w.clock, logger: { info: () => undefined } as never }, {} as never, { id: 'test' })
}
const client = (id: string) => w.t.db.selectFrom('customers').select(['id', 'deleted_at', 'archived_at', 'full_name']).where('id', '=', id).executeTakeFirstOrThrow()

describe('leads.provisional_archive', () => {
  it('archives a nameless, never-booked provisional client 30 days after its last text, closes its lead, once', async () => {
    await w.assistantOn()
    const a = (await adopt(STRANGER))!.customerId
    w.clock.advance(29 * DAY)
    await runJob()
    expect(await client(a)).toMatchObject({ deleted_at: null, archived_at: null })
    w.clock.advance(2 * DAY)
    await runJob()
    expect(await client(a)).toMatchObject({ deleted_at: w.clock.now(), archived_at: w.clock.now(), full_name: 'New texter ••0199' })
    expect((await w.t.db.selectFrom('leads').select(['status', 'closed_at']).executeTakeFirstOrThrow()).status).toBe('closed')
    expect(await w.t.db.selectFrom('audit_log').select(['action', 'actor_name']).where('action', '=', 'assistant.client.archived').execute()).toEqual([
      { action: 'assistant.client.archived', actor_name: 'Oasis AI (SMS)' },
    ])
    const before = JSON.stringify(await client(a))
    w.clock.advance(DAY)
    await runJob()
    expect(JSON.stringify(await client(a))).toBe(before)
  })

  it('keeps a client that gave a name, one that booked, and staff’s own clients', async () => {
    await w.assistantOn()
    const named = (await adopt(STRANGER))!.customerId
    await w.t.db.updateTable('customers').set({ full_name: 'Ana Lopez', needs_details: false }).where('id', '=', named).execute()
    const booked = (await adopt(STRANGER2))!.customerId
    const svc = await w.t.db.selectFrom('services').select(['id', 'name', 'price_cents', 'duration_min']).where('kind', '=', 'package').executeTakeFirstOrThrow()
    await w.t.db
      .insertInto('appointments')
      .values({ id: w.newId(), location_id: w.locationId, customer_id: booked, service_id: svc.id, package_name: svc.name, price_cents: svc.price_cents, duration_min: svc.duration_min, scheduled_start: new Date('2026-06-15T10:00:00-04:00'), scheduled_end: new Date('2026-06-15T11:00:00-04:00') })
      .execute()
    w.clock.advance(40 * DAY)
    await runJob()
    expect(await client(named)).toMatchObject({ deleted_at: null })
    expect(await client(booked)).toMatchObject({ deleted_at: null })
    const seeded = await w.t.db.selectFrom('customers').select('id').where('deleted_at', 'is not', null).where('source', '<>', 'inbound_sms').execute()
    expect(seeded).toEqual([])
  })
})
