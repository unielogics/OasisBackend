// credit.expire: announces store credit that expired unspent, daily.
//
// Expiry itself is enforced at query time (src/modules/payments/credit.ts): a lot whose expires_at has passed drops out of the
// balance and can no longer be allocated, and credit_allocations hold what FIFO consumed before that. The ledger is
// append-only, so nothing is written to it. This job finds every expired credit_issue lot with an unspent remainder (cents
// minus its allocations), records it once in credit_expiries and tells the managers and the payments channel. Running it twice,
// or from two workers, announces each lot once (the marker row is the lock).
import { sql } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db } from '../../platform/db.js'
import { createIdGenerator, type NewId } from '../../platform/ids.js'
import type { JobDefinition } from '../../platform/jobs.js'
import * as realtime from '../../platform/realtime.js'
import { notifyManagers } from '../messaging/notify.js'
import { money } from './format.js'

export const CREDIT_EXPIRE_JOB = 'credit.expire'
const BATCH = 500

export interface ExpiredLot {
  lotEventId: string
  customerId: string
  customerName: string
  cents: number
  expiresAt: Date
}

export interface CreditExpiryResult {
  expired: ExpiredLot[]
  totalCents: number
}

interface LotRow {
  id: string
  location_id: string
  customer_id: string
  full_name: string
  expires_at: Date
  remaining: number
}

export async function runCreditExpiry(
  db: Db,
  clock: Clock,
  newId: NewId = createIdGenerator(clock),
): Promise<CreditExpiryResult> {
  const now = clock.now()
  const lots = await sql<LotRow>`
    select e.id, e.location_id, e.customer_id, c.full_name, e.expires_at,
           (e.amount_cents - coalesce(a.used, 0))::int as remaining
    from ledger_events e
    join customers c on c.id = e.customer_id
    left join (select lot_event_id, sum(cents) as used from credit_allocations group by lot_event_id) a on a.lot_event_id = e.id
    where e.type = 'credit_issue' and e.expires_at is not null and e.expires_at <= ${now}
      and e.amount_cents - coalesce(a.used, 0) > 0
      and not exists (select 1 from credit_expiries x where x.lot_event_id = e.id)
    order by e.expires_at, e.seq
    limit ${BATCH}`.execute(db)

  const result: CreditExpiryResult = { expired: [], totalCents: 0 }
  for (const lot of lots.rows) {
    await transaction(db, async (tx) => {
      const marker = await tx
        .insertInto('credit_expiries')
        .values({
          lot_event_id: lot.id,
          location_id: lot.location_id,
          customer_id: lot.customer_id,
          expired_cents: lot.remaining,
          expires_at: lot.expires_at,
          recorded_at: now,
        })
        .onConflict((oc) => oc.column('lot_event_id').doNothing())
        .returning('lot_event_id')
        .executeTakeFirst()
      if (!marker) return
      await notifyManagers(
        tx,
        {
          locationId: lot.location_id,
          kind: 'credit.expired',
          title: 'Store credit expired',
          body: `${money(lot.remaining)} of ${lot.full_name}'s store credit expired unused`,
          entityType: 'customer',
          entityId: lot.customer_id,
        },
        { newId, clock },
      )
      await realtime.publish(tx, {
        locationId: lot.location_id,
        channel: 'payments',
        type: 'credit.expired',
        payload: { customerId: lot.customer_id, cents: lot.remaining },
      })
      result.expired.push({
        lotEventId: lot.id,
        customerId: lot.customer_id,
        customerName: lot.full_name,
        cents: lot.remaining,
        expiresAt: lot.expires_at,
      })
      result.totalCents += lot.remaining
    })
  }
  return result
}

export const creditExpireJob: JobDefinition = {
  name: CREDIT_EXPIRE_JOB,
  // 00:10 business time: credit issued with an expiry ends at the end of a business day, so the lot is expired by then
  cron: '10 0 * * *',
  policy: 'short',
  retryLimit: 2,
  retryDelaySeconds: 120,
  expireInSeconds: 10 * 60,
  async handler(ctx) {
    const r = await runCreditExpiry(ctx.db, ctx.clock)
    if (r.expired.length > 0)
      ctx.logger.info({ lots: r.expired.length, cents: r.totalCents }, 'store credit expired')
  },
}
