// The ledger is append-only in the database: no deletes, and only the pending -> done/denied resolution of a refund and the
// processor fields may ever change. credit_allocations is insert-only. Table checks keep malformed rows out.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { useTestDb } from '../helpers/db.js'
import { addEvent, makeInvoice, setupEnv, type Env, type MadeInvoice } from './helpers.js'

const t = useTestDb()

async function fixture(): Promise<{ env: Env; inv: MadeInvoice }> {
  const env = await setupEnv(t)
  return { env, inv: await makeInvoice(t.db, env) }
}

const fails = async (p: Promise<unknown>, re: RegExp): Promise<void> => {
  await expect(p).rejects.toThrow(re)
}

describe('ledger_events guard trigger', () => {
  it('refuses deletes', async () => {
    const { env, inv } = await fixture()
    const id = await addEvent(t.db, env, inv, {
      type: 'pay',
      amountCents: 1000,
      method: 'Cash',
      methodKind: 'cash',
    })
    await fails(
      t.db.deleteFrom('ledger_events').where('id', '=', id).execute(),
      /append-only: rows cannot be deleted/,
    )
    await fails(sql`delete from ledger_events`.execute(t.db), /append-only/)
  })

  it('refuses to change any frozen column', async () => {
    const { env, inv } = await fixture()
    const id = await addEvent(t.db, env, inv, {
      type: 'pay',
      amountCents: 1000,
      method: 'Cash',
      methodKind: 'cash',
    })
    for (const set of [
      { amount_cents: 2000 },
      { note: 'edited' },
      { method: 'Visa' },
      { occurred_at: new Date('2020-01-01T00:00:00Z') },
      { invoice_id: (await makeInvoice(t.db, env)).id },
      { actor_name: 'Someone else' },
      { type: 'refund' as const },
    ]) {
      await fails(
        t.db.updateTable('ledger_events').set(set).where('id', '=', id).execute(),
        /append-only: only the refund resolution/,
      )
    }
    const row = await t.db
      .selectFrom('ledger_events')
      .select(['amount_cents', 'note'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ amount_cents: 1000, note: null })
  })

  it('allows the processor fields to move at any time', async () => {
    const { env, inv } = await fixture()
    const id = await addEvent(t.db, env, inv, {
      type: 'pay',
      amountCents: 1000,
      method: 'Visa',
      methodKind: 'card',
      processorState: 'awaiting_processor',
    })
    await t.db
      .updateTable('ledger_events')
      .set({
        processor_state: 'confirmed',
        processor_ref: 'txn_1',
        sqsp_order_id: 'o_1',
        processor_confirmed_at: t.clock.now(),
        processor_confirmed_by: 'Rafael M.',
      })
      .where('id', '=', id)
      .execute()
    await t.db.updateTable('ledger_events').set({ processor_state: 'failed' }).where('id', '=', id).execute()
    const row = await t.db
      .selectFrom('ledger_events')
      .select(['processor_state', 'processor_ref'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ processor_state: 'failed', processor_ref: 'txn_1' })
  })

  it('a pending refund resolves to done or denied once, with resolved_at, and its time never changes', async () => {
    const { env, inv } = await fixture()
    const at = new Date('2026-06-12T16:40:00-04:00')
    const a = await addEvent(t.db, env, inv, {
      type: 'refund',
      amountCents: 8000,
      status: 'pending',
      dest: 'card',
      at,
    })
    const b = await addEvent(t.db, env, inv, {
      type: 'refund',
      amountCents: 8000,
      status: 'pending',
      dest: 'card',
      at,
    })
    const now = t.clock.now()
    await t.db
      .updateTable('ledger_events')
      .set({ status: 'done', resolved_at: now, approved_at: now, approved_by_name: 'Rafael M.' })
      .where('id', '=', a)
      .execute()
    await t.db
      .updateTable('ledger_events')
      .set({ status: 'denied', resolved_at: now, denied_at: now, denied_by_name: 'Rafael M.' })
      .where('id', '=', b)
      .execute()
    const rows = await t.db
      .selectFrom('ledger_events')
      .select(['status', 'occurred_at'])
      .where('id', 'in', [a, b])
      .orderBy('status')
      .execute()
    expect(rows.map((r) => r.status)).toEqual(['denied', 'done'])
    expect(rows.every((r) => r.occurred_at.getTime() === at.getTime())).toBe(true)
    await fails(
      t.db
        .updateTable('ledger_events')
        .set({ status: 'pending', resolved_at: null })
        .where('id', '=', a)
        .execute(),
      /status can only move from pending/,
    )
    await fails(
      t.db
        .updateTable('ledger_events')
        .set({ status: 'done', resolved_at: now })
        .where('id', '=', b)
        .execute(),
      /status can only move from pending/,
    )
  })

  it('refuses a resolution without resolved_at, a status change on a non-refund, and approver fields without a status change', async () => {
    const { env, inv } = await fixture()
    const refund = await addEvent(t.db, env, inv, {
      type: 'refund',
      amountCents: 8000,
      status: 'pending',
      dest: 'card',
    })
    await fails(
      t.db.updateTable('ledger_events').set({ status: 'done' }).where('id', '=', refund).execute(),
      /must set resolved_at/,
    )
    const pay = await addEvent(t.db, env, inv, {
      type: 'pay',
      amountCents: 1000,
      method: 'Cash',
      methodKind: 'cash',
    })
    await fails(
      t.db
        .updateTable('ledger_events')
        .set({ status: 'denied', resolved_at: t.clock.now() })
        .where('id', '=', pay)
        .execute(),
      /status can only move from pending|ledger_events_check/,
    )
    const done = await addEvent(t.db, env, inv, { type: 'refund', amountCents: 100, dest: 'cash' })
    await fails(
      t.db.updateTable('ledger_events').set({ approved_at: t.clock.now() }).where('id', '=', done).execute(),
      /approval fields change only together|ledger_events_check/,
    )
  })

  it('table checks reject malformed rows', async () => {
    const { env, inv } = await fixture()
    await fails(addEvent(t.db, env, inv, { type: 'adjust', amountCents: 0 }), /ledger_events_check/)
    await fails(addEvent(t.db, env, inv, { type: 'pay', amountCents: -5 }), /ledger_events_check/)
    await fails(addEvent(t.db, env, inv, { type: 'void', amountCents: 5 }), /ledger_events_check/)
    await fails(
      t.db
        .insertInto('ledger_events')
        .values({
          id: env.newId(),
          location_id: env.locationId,
          invoice_id: inv.id,
          customer_id: inv.customerId,
          type: 'refund',
          amount_cents: 5,
          occurred_at: t.clock.now(),
        })
        .execute(),
      /ledger_events_check/,
    )
    await fails(
      t.db
        .insertInto('ledger_events')
        .values({
          id: env.newId(),
          location_id: env.locationId,
          invoice_id: inv.id,
          customer_id: inv.customerId,
          type: 'pay',
          amount_cents: 5,
          status: 'pending',
          occurred_at: t.clock.now(),
        })
        .execute(),
      /ledger_events_check/,
    )
    await addEvent(t.db, env, inv, { type: 'adjust', amountCents: -2500 })
  })

  it('idempotency_key is unique', async () => {
    const { env, inv } = await fixture()
    const base = {
      location_id: env.locationId,
      invoice_id: inv.id,
      customer_id: inv.customerId,
      type: 'pay' as const,
      amount_cents: 5,
      occurred_at: t.clock.now(),
      idempotency_key: 'u:k1',
    }
    await t.db
      .insertInto('ledger_events')
      .values({ id: env.newId(), ...base })
      .execute()
    await fails(
      t.db
        .insertInto('ledger_events')
        .values({ id: env.newId(), ...base })
        .execute(),
      /duplicate key/,
    )
  })
})

describe('credit_allocations is insert-only', () => {
  it('refuses updates and deletes', async () => {
    const { env, inv } = await fixture()
    const lot = await addEvent(t.db, env, inv, { type: 'credit_issue', amountCents: 2000, expiry: 'none' })
    const apply = await addEvent(t.db, env, inv, {
      type: 'credit_apply',
      amountCents: 500,
      method: 'Store credit',
      methodKind: 'store_credit',
    })
    const id = env.newId()
    await t.db
      .insertInto('credit_allocations')
      .values({ id, apply_event_id: apply, lot_event_id: lot, customer_id: inv.customerId, cents: 500 })
      .execute()
    await fails(
      t.db.updateTable('credit_allocations').set({ cents: 1 }).where('id', '=', id).execute(),
      /append-only/,
    )
    await fails(t.db.deleteFrom('credit_allocations').where('id', '=', id).execute(), /append-only/)
  })
})

describe('invoice numbering', () => {
  it('invoice_no is unique per location', async () => {
    const env = await setupEnv(t)
    await makeInvoice(t.db, env, { no: 40001 })
    await fails(makeInvoice(t.db, env, { no: 40001 }), /duplicate key/)
  })
})
