// ledger.integrity_check (ADR 0123): the SQL invoice view equals the TypeScript calc over the raw rows, the append-only triggers
// are in place, store-credit allocations add up; the result is recorded per business date and a new problem notifies managers.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { runSeed } from '../../db/seeds/index.js'
import { calcInvoice } from '../../src/modules/payments/calc.js'
import {
  calcDifferences,
  checkLedgerIntegrity,
  runLedgerIntegrity,
} from '../../src/modules/payments/jobs-integrity.js'
import type { FixedClock } from '../../src/platform/clock.js'
import { truncateAll, useTestDb } from '../helpers/db.js'
import { addEvent, makeInvoice, setupEnv } from './helpers.js'

const t = useTestDb()

async function withManagers(): Promise<void> {
  await runSeed({ db: t.db, clock: t.clock, profile: 'people' })
  await sql`insert into users (id, employee_id, email, password_hash)
    select gen_random_uuid(), e.id, lower(e.first) || '@example.test', 'not-a-real-hash' from employees e
    where not exists (select 1 from users u where u.employee_id = e.id)`.execute(t.db)
}

const notices = async (): Promise<number> =>
  Number(
    (
      await sql<{
        n: number
      }>`select count(*)::int as n from notifications where kind = 'ledger.integrity_failed'`.execute(t.db)
    ).rows[0]!.n,
  )

describe('ledger integrity check', () => {
  it('finds nothing wrong with the Payments design history', async () => {
    await truncateAll(t.db)
    await runSeed({ db: t.db, clock: t.clock, profile: 'parity-pay' })
    const location = await t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()
    const report = await checkLedgerIntegrity(t.db, location.id)
    expect(report).toEqual({ invoicesChecked: 105, findings: [] })
  })

  it('reports a disabled append-only trigger', async () => {
    const env = await setupEnv(t)
    await sql`alter table ledger_events disable trigger ledger_events_guard`.execute(t.db)
    try {
      const report = await checkLedgerIntegrity(t.db, env.locationId)
      expect(report.findings).toEqual([
        {
          code: 'guard_missing',
          detail: 'ledger_events: the append-only trigger ledger_events_guard is disabled',
        },
      ])
    } finally {
      await sql`alter table ledger_events enable trigger ledger_events_guard`.execute(t.db)
    }
    expect((await checkLedgerIntegrity(t.db, env.locationId)).findings).toEqual([])
  })

  it('reports store credit applied without matching FIFO allocations', async () => {
    const env = await setupEnv(t)
    const inv = await makeInvoice(t.db, env, { no: 40100 })
    await addEvent(t.db, env, inv, {
      type: 'credit_apply',
      amountCents: 500,
      method: 'Store credit',
      methodKind: 'store_credit',
    })
    const report = await checkLedgerIntegrity(t.db, env.locationId)
    expect(report.findings).toEqual([
      {
        code: 'allocation_mismatch',
        invoiceNo: 40100,
        detail: 'INV-40100: store credit applied 500 cents but its FIFO allocations sum to 0',
      },
    ])
  })

  it('compares every calc field and names the ones that differ', () => {
    const base = calcInvoice({ itemPrices: [10_000], events: [], taxBp: 700, tipCents: 0, canceled: false })
    expect(calcDifferences(base, base)).toEqual([])
    expect(calcDifferences({ ...base, tax: 699, status: 'paid' }, base)).toEqual([
      'tax 699 != 700',
      'status paid != unpaid',
    ])
  })

  it('records one result per business date and announces a problem once', async () => {
    await withManagers()
    const env = await setupEnv(t)
    const inv = await makeInvoice(t.db, env, { no: 40200 })
    await addEvent(t.db, env, inv, { type: 'pay', amountCents: 16_478, method: 'Cash', methodKind: 'cash' })

    const clean = await runLedgerIntegrity(t.db, t.clock)
    expect(clean).toMatchObject([{ ok: true, recorded: true, notified: false, invoicesChecked: 1 }])
    expect((await runLedgerIntegrity(t.db, t.clock))[0]).toMatchObject({ recorded: false, notified: false })

    await addEvent(t.db, env, inv, {
      type: 'credit_apply',
      amountCents: 300,
      method: 'Store credit',
      methodKind: 'store_credit',
    })
    const bad = await runLedgerIntegrity(t.db, t.clock, { jobId: 'job-1' })
    expect(bad).toMatchObject([{ ok: false, recorded: true, notified: true }])
    const managers = await notices()
    expect(managers).toBeGreaterThan(0)
    expect((await runLedgerIntegrity(t.db, t.clock))[0]).toMatchObject({ recorded: false, notified: false })
    // more invoices, same problem: the count is recorded, nobody is told again
    await makeInvoice(t.db, env, { no: 40201 })
    expect((await runLedgerIntegrity(t.db, t.clock))[0]).toMatchObject({ recorded: true, notified: false })
    expect(await notices()).toBe(managers)

    const rows = await t.db
      .selectFrom('ledger_integrity_runs')
      .select(['check_date', 'ok', 'invoices_checked', 'findings'])
      .execute()
    expect(rows).toEqual([
      {
        check_date: '2026-06-13',
        ok: false,
        invoices_checked: 2,
        findings: [expect.objectContaining({ code: 'allocation_mismatch', invoiceNo: 40200 })],
      },
    ])
    // the next night is a new row
    ;(t.clock as FixedClock).set('2026-06-14T03:45:00-04:00')
    expect((await runLedgerIntegrity(t.db, t.clock))[0]).toMatchObject({ recorded: true, notified: true })
    expect(await t.db.selectFrom('ledger_integrity_runs').select('id').execute()).toHaveLength(2)
  })
})
