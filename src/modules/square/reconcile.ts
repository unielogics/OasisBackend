// square.reconcile (ADR 0171): read the last 72 hours of payments and refunds at our location, keep the counts in square_state (by
// status, source and product), and (wave Q2b) decide every completed payment Oasis has not decided yet and every completed refund it
// has not recorded (a webhook and the catch-up both missed them): the same paths, under the same advisory locks, so a payment is never
// recorded twice. Orphan payment links cannot exist (a link's row is written before the Square call and the sweep deletes the
// canceled ones), so the design's ListPaymentLinks pass is not needed; the subscription drift check comes with wave Q3b.
import { squareLiveConfigured, squareLocationId } from '../../integrations/square/config.js'
import type { WirePayment, WireRefund } from '../../integrations/square/wire.js'
import { advisoryXactLock, transaction } from '../../platform/db.js'
import { createIdGenerator } from '../../platform/ids.js'
import { paymentFacts, refundFacts } from './facts.js'
import { decideSquarePayment, lockPayment } from './payments.js'
import { ingestSquareRefund } from './refunds.js'
import { refundKey } from './ledger.js'
import { getDefaultLocation } from '../../platform/locations.js'
import { maskText } from '../../platform/logging.js'
import type { SquareReconcileSummary } from './db/schema.js'
import { saveSquareState, stampConnectionPoint } from './db/state.js'
import type { SquareEventDeps } from './events.js'

export const RECONCILE_WINDOW_MS = 72 * 3600_000
const MAX_PAGES = 50

const bump = (m: Record<string, number>, k: string | null | undefined) => {
  const key = k || 'UNKNOWN'
  m[key] = (m[key] ?? 0) + 1
}

export async function runSquareReconcile(
  d: Pick<SquareEventDeps, 'db' | 'clock' | 'logger' | 'env' | 'api'>,
  o: { force?: boolean } = {},
): Promise<{ status: 'skipped' | 'ok'; summary?: SquareReconcileSummary; reason?: string }> {
  if (!o.force && !squareLiveConfigured(d.env)) return { status: 'skipped', reason: 'SQUARE_PROVIDER is not live or not configured' }
  const location = await getDefaultLocation(d.db)
  if (!location) return { status: 'skipped', reason: 'no location' }
  const now = d.clock.now()
  const from = new Date(now.getTime() - RECONCILE_WINDOW_MS)
  // no end_time: Square's default is the current time (and a payment made this very millisecond is still in)
  const q = { begin_time: from.toISOString(), sort_order: 'ASC' as const, location_id: squareLocationId(d.env), limit: 100 }
  const s: SquareReconcileSummary = {
    from: from.toISOString(),
    to: now.toISOString(),
    payments: 0,
    refunds: 0,
    paymentsByStatus: {},
    refundsByStatus: {},
    bySource: {},
    byProduct: {},
    complete: true,
  }
  const payments: WirePayment[] = []
  const refunds: WireRefund[] = []
  try {
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await d.api.payments.list({ ...q, cursor })
      for (const p of page.items) {
        payments.push(p)
        s.payments++
        bump(s.paymentsByStatus, p.status)
        bump(s.bySource, p.source_type)
        bump(s.byProduct, p.application_details?.square_product)
      }
      cursor = page.cursor
    } while (cursor && ++pages < MAX_PAGES)
    if (cursor) s.complete = false
    pages = 0
    cursor = undefined
    do {
      const page = await d.api.refunds.list({ ...q, cursor })
      for (const r of page.items) {
        refunds.push(r)
        s.refunds++
        bump(s.refundsByStatus, r.status)
      }
      cursor = page.cursor
    } while (cursor && ++pages < MAX_PAGES)
    if (cursor) s.complete = false
  } catch (e) {
    const msg = maskText(e instanceof Error ? e.message : String(e)).slice(0, 300)
    await saveSquareState(d.db, location.id, d.env, now, { last_error: `reconcile: ${msg}`, last_error_at: now })
    throw e
  }
  // the first read of this Square (sandbox run F2): when nothing read it before, the connection point is now, so the 72 hours of
  // earlier sales listed here are history (kept as it is otherwise)
  await stampConnectionPoint(d.db, location.id, d.env, now)
  // what the webhook and the catch-up both missed: decided now, through the same locks and keys
  const newId = createIdGenerator(d.clock)
  const deps = { locationId: location.id, clock: d.clock, newId, env: d.env }
  const ours = squareLocationId(d.env)
  for (const p of payments) {
    if (p.status !== 'COMPLETED' || (ours && p.location_id && p.location_id !== ours)) continue
    const known = await d.db.selectFrom('square_payments').select('match_state').where('square_payment_id', '=', p.id).executeTakeFirst()
    if (known && known.match_state !== 'pending') continue
    try {
      await transaction(d.db, async (tx) => {
        await lockPayment(tx, p.id)
        const f = paymentFacts(p)
        await decideSquarePayment(tx, deps, f, { force: now.getTime() - f.createdAt.getTime() >= d.env.SQUARE_MATCH_DELAY_SECONDS * 1000 })
      })
      s.decided = (s.decided ?? 0) + 1
    } catch (e) {
      d.logger.warn({ square: { payment: p.id }, err: maskText(String(e)).slice(0, 200) }, 'square.reconcile: payment not decided')
    }
  }
  for (const r of refunds) {
    if (r.status !== 'COMPLETED' || (ours && r.location_id && r.location_id !== ours)) continue
    const leg = await d.db.selectFrom('square_refund_legs').select('id').where('square_refund_id', '=', r.id).executeTakeFirst()
    const ledger = await d.db.selectFrom('ledger_events').select('id').where('idempotency_key', '=', refundKey(r.id)).executeTakeFirst()
    if (leg || ledger) continue
    try {
      await transaction(d.db, async (tx) => {
        await advisoryXactLock(tx, `square:refund:${r.id}`)
        await ingestSquareRefund(tx, deps, refundFacts(r))
      })
    } catch (e) {
      d.logger.warn({ square: { refund: r.id }, err: maskText(String(e)).slice(0, 200) }, 'square.reconcile: refund not recorded')
    }
  }
  await saveSquareState(d.db, location.id, d.env, now, { last_reconcile_at: now, last_reconcile: s })
  d.logger.info({ square: s }, 'square.reconcile done')
  return { status: 'ok', summary: s }
}
