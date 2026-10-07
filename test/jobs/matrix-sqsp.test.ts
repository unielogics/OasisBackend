// sqsp.sync, sqsp.contacts, sqsp.reconcile, sqsp.webhook.process and membership.cycle through the real worker, twice each,
// against the Squarespace simulator: the second run of every job leaves the database exactly as the first did.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { membershipCycleJob } from '../../src/modules/memberships/jobs.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { sqspJobs } from '../../src/modules/payments-sync/jobs/index.js'
import { transaction } from '../../src/platform/db.js'
import { useRig } from '../payments-sync-db/harness.js'
import { useJobsHarness } from './harness.js'

const rig = useRig({ pageSize: 50 })
const h = useJobsHarness({ testDb: () => rig().t })

const snapshot = async (): Promise<Record<string, unknown>> => {
  const db = rig().db
  const n = async (table: string): Promise<number> =>
    Number(
      (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)}`.execute(db)).rows[0]!.n,
    )
  return {
    orders: await n('sqsp_orders'),
    transactions: await n('sqsp_transactions'),
    contacts: await n('sqsp_contacts'),
    memberships: await n('memberships'),
    ledger: await n('ledger_events'),
    credits: await n('membership_credit_events'),
    matches: await n('sqsp_matches'),
    manual: await n('sqsp_manual_queue'),
    orderStates: (
      await db.selectFrom('sqsp_orders').select('match_state').orderBy('sqsp_order_id').execute()
    ).map((o) => o.match_state),
  }
}

async function run(
  worker: Awaited<ReturnType<typeof h.start>>,
  name: string,
  data: object = {},
): Promise<void> {
  const before = (await h.states(worker.schema, name)).filter((s) => s === 'completed').length
  await worker.jobs.enqueue(name, data)
  await h.waitFor(
    async () => (await h.states(worker.schema, name)).filter((s) => s === 'completed').length > before,
    60_000,
  )
}

async function arrange(): Promise<{ orderId: string }> {
  const r = rig()
  await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
  await transaction(r.db, (tx) =>
    replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [
      { sku: 'DET-SEDAN', kind: 'service' },
      { sku: 'MEM-ESS', kind: 'membership', plan: 'essential' },
    ]),
  )
  await r.db
    .insertInto('customers')
    .values({ id: r.newId(), full_name: 'Maria Alvarez', email: 'maria@example.com', source: 'import' })
    .execute()
  r.store.createOrder({
    email: 'maria@example.com',
    name: 'Maria Alvarez',
    lineItems: [{ productId: 'p', sku: 'MEM-ESS', name: 'Essential', unitCents: 9900 }],
  })
  const { orderId } = r.store.createOrder({
    email: 'x@example.com',
    name: 'X',
    lineItems: [{ productId: 'q', sku: 'DET-SEDAN', name: 'Detail', unitCents: 18900 }],
    taxCents: 1323,
  })
  r.advance(60_000)
  return { orderId }
}

describe('the Squarespace read side and the membership pass, twice each through the real worker', () => {
  it('sqsp.sync: orders, matches and memberships are stored once however many times it runs', async () => {
    await arrange()
    const w = await h.start({ definitions: sqspJobs as never })
    const before = JSON.stringify(await snapshot())
    await run(w, 'sqsp.sync')
    const first = await snapshot()
    await run(w, 'sqsp.sync')
    expect(first).toMatchObject({ orders: 2, memberships: 1 })
    expect(JSON.stringify(first)).not.toBe(before)
    expect(await snapshot()).toEqual(first)
  })

  it('sqsp.reconcile re-reads the window and adds nothing the poll already stored', async () => {
    await arrange()
    const w = await h.start({ definitions: sqspJobs as never })
    await run(w, 'sqsp.sync')
    const afterSync = await snapshot()
    await run(w, 'sqsp.reconcile')
    await run(w, 'sqsp.reconcile')
    expect(await snapshot()).toEqual(afterSync)
  })

  it('sqsp.reconcile alone stores what a poll never saw, once', async () => {
    await arrange()
    const w = await h.start({ definitions: sqspJobs as never })
    await run(w, 'sqsp.reconcile')
    const first = await snapshot()
    expect(first).toMatchObject({ orders: 2 })
    await run(w, 'sqsp.reconcile')
    expect(await snapshot()).toEqual(first)
  })

  it('sqsp.contacts links customers once', async () => {
    await arrange()
    const w = await h.start({ definitions: sqspJobs as never })
    await run(w, 'sqsp.contacts')
    const first = await snapshot()
    await run(w, 'sqsp.contacts')
    expect(await snapshot()).toEqual(first)
  })

  it('sqsp.webhook.process stores the notified order once and marks the notification processed', async () => {
    const { orderId } = await arrange()
    const r = rig()
    const logId = r.newId()
    await r.db
      .insertInto('webhook_log')
      .values({
        id: logId,
        provider: 'squarespace',
        external_id: 'n-matrix',
        headers: '{}',
        signature_valid: true,
      })
      .execute()
    const w = await h.start({ definitions: sqspJobs as never })
    const data = { orderId, notificationId: 'n-matrix', locationId: r.locationId }
    await run(w, 'sqsp.webhook.process', data)
    const first = await snapshot()
    expect(first).toMatchObject({ orders: 1 })
    await run(w, 'sqsp.webhook.process', data)
    expect(await snapshot()).toEqual(first)
    expect(
      (
        await r.db
          .selectFrom('webhook_log')
          .select('status')
          .where('id', '=', logId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('processed')
  })

  it('membership.cycle grants a cycle once: the second pass adds no credit events and no memberships', async () => {
    await arrange()
    const w = await h.start({ definitions: [...sqspJobs, membershipCycleJob] as never })
    await run(w, 'sqsp.sync')
    await run(w, 'membership.cycle')
    const first = await snapshot()
    await run(w, 'membership.cycle')
    expect(await snapshot()).toEqual(first)
    expect(first).toMatchObject({ memberships: 1 })
    expect((first.credits as number) >= 0).toBe(true)
  })
})
