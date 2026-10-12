// square.reconcile (ADR 0171), this wave: read the last 72 hours of payments and refunds at our location and keep the counts in
// square_state (by status, source and product). The classifier and matcher that decide what each one is come with wave Q2b; the
// orphan payment-link sweep and the subscription drift check come with the waves that create links and subscriptions.
import { squareLiveConfigured, squareLocationId } from '../../integrations/square/config.js'
import { getDefaultLocation } from '../../platform/locations.js'
import { maskText } from '../../platform/logging.js'
import type { SquareReconcileSummary } from './db/schema.js'
import { saveSquareState } from './db/state.js'
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
  try {
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await d.api.payments.list({ ...q, cursor })
      for (const p of page.items) {
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
  await saveSquareState(d.db, location.id, d.env, now, { last_reconcile_at: now, last_reconcile: s })
  d.logger.info({ square: s }, 'square.reconcile done (counts only in this wave)')
  return { status: 'ok', summary: s }
}
