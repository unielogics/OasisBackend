// parity-pay under a clock that is not the design day: the fixtures' explicit dates ("Jun 11") keep their distance from
// today, so every store-credit apply still finds its lots (before the fix the seed died with "Not enough store credit").
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { FixedClock } from '../../src/platform/clock.js'
import { isoInTz } from '../../src/platform/time.js'
import { useTestDb } from '../helpers/db.js'

const t = useTestDb({ clock: new FixedClock('2026-10-06T09:00:00-04:00') })

describe('parity-pay seed on another day', () => {
  it('seeds the 105 invoices and keeps explicit dates two days before today', async () => {
    await runSeed({ db: t.db, clock: t.clock, profile: 'parity-pay' })
    const n = await sql<{ n: number }>`select count(*)::int n from invoices`.execute(t.db)
    expect(n.rows[0]!.n).toBe(105)
    const refund = await sql<{ occurred_at: Date }>`
      select e.occurred_at from ledger_events e join invoices i on i.id = e.invoice_id
      where i.invoice_no = 20571 and e.type = 'refund'`.execute(t.db)
    expect(isoInTz(refund.rows[0]!.occurred_at)).toBe('2026-10-04T09:12:00-04:00')
    const alloc = await sql<{ n: number }>`select count(*)::int n from credit_allocations`.execute(t.db)
    expect(alloc.rows[0]!.n).toBeGreaterThan(0)
  })
})
