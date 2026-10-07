// Sync and matching alerts (sqsp_alerts) and the AlertSink the match runner raises them through. Raising is idempotent per
// code, order and transaction: a re-run of the matcher never doubles an open alert; raising a resolved one again re-opens it.
import { sql } from 'kysely'
import type { Clock } from '../../../platform/clock.js'
import type { Db, Executor } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import { toJson } from './codec.js'
import type { AlertSink } from '../ledger-ports.js'

export type AlertInput = Parameters<AlertSink['raise']>[0] | {
  code: string
  orderId?: string
  transactionId?: string
  invoiceId?: string
  message: string
  variance?: unknown
  /** Distinguishes alerts of one code that are not tied to an order (e.g. a member without a customer). */
  subject?: string
}

export const alertKey = (a: { code: string; orderId?: string; transactionId?: string; subject?: string }): string =>
  `${a.code}:${a.orderId ?? ''}:${a.transactionId ?? ''}:${a.subject ?? ''}`

export async function raiseAlert(
  db: Executor,
  d: { locationId: string; newId: NewId; clock: Clock },
  a: AlertInput,
): Promise<boolean> {
  const variance = 'variance' in a && a.variance ? JSON.stringify(toJson(a.variance)) : null
  const r = await sql`
    insert into sqsp_alerts (id, location_id, dedupe_key, code, sqsp_order_id, sqsp_txn_id, invoice_id, message, variance, created_at)
    values (${d.newId()}, ${d.locationId}, ${alertKey(a as never)}, ${a.code}, ${a.orderId ?? null}, ${a.transactionId ?? null},
      ${a.invoiceId ?? null}, ${a.message}, ${variance}::jsonb, ${d.clock.now()})
    on conflict (location_id, dedupe_key) do update
      set resolved_at = null, resolved_by = null, message = excluded.message, variance = excluded.variance, created_at = excluded.created_at
      where sqsp_alerts.resolved_at is not null`.execute(db)
  return Number(r.numAffectedRows ?? 0) > 0
}

/** Closes open alerts of these codes (optionally one order); returns how many were closed. */
export async function resolveAlerts(
  db: Executor,
  d: { locationId: string; clock: Clock },
  codes: readonly string[],
  o: { orderId?: string; by?: string | null } = {},
): Promise<number> {
  if (codes.length === 0) return 0
  const r = await sql`
    update sqsp_alerts set resolved_at = ${d.clock.now()}, resolved_by = ${o.by ?? null}
    where location_id = ${d.locationId} and resolved_at is null and code = any(${codes as string[]}::text[])
      ${o.orderId ? sql`and sqsp_order_id = ${o.orderId}` : sql``}`.execute(db)
  return Number(r.numAffectedRows ?? 0)
}

export class PgAlertSink implements AlertSink {
  constructor(
    private readonly db: Db,
    private readonly d: { locationId: string; newId: NewId; clock: Clock },
  ) {}
  async raise(a: Parameters<AlertSink['raise']>[0]): Promise<void> {
    await raiseAlert(this.db, this.d, a)
  }
}

export interface OpenAlert {
  id: string
  code: string
  orderId: string | null
  transactionId: string | null
  invoiceId: string | null
  message: string
  variance: unknown
  createdAt: Date
}

export async function listOpenAlerts(db: Executor, locationId: string, limit = 100): Promise<OpenAlert[]> {
  const rows = await db
    .selectFrom('sqsp_alerts')
    .selectAll()
    .where('location_id', '=', locationId)
    .where('resolved_at', 'is', null)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute()
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    orderId: r.sqsp_order_id,
    transactionId: r.sqsp_txn_id,
    invoiceId: r.invoice_id,
    message: r.message,
    variance: r.variance,
    createdAt: r.created_at,
  }))
}

/** Closes open alerts by exact dedupe key (alerts keyed by a subject rather than an order). */
export async function resolveAlertKeys(
  db: Executor,
  d: { locationId: string; clock: Clock },
  keys: readonly string[],
): Promise<number> {
  if (keys.length === 0) return 0
  const r = await sql`
    update sqsp_alerts set resolved_at = ${d.clock.now()}
    where location_id = ${d.locationId} and resolved_at is null and dedupe_key = any(${keys as string[]}::text[])`.execute(db)
  return Number(r.numAffectedRows ?? 0)
}
