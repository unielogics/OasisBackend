// Database access of the Payments module: invoices, items, ledger events and the invoice_calc function.
import { sql, type Insertable, type Selectable } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { InvoiceCalc } from './calc.js'
import type {
  InvoiceCalcRow,
  InvoiceItemsTable,
  InvoicesTable,
  LedgerEventsTable,
  MethodKind,
} from './schema.js'

export type InvoiceRow = Selectable<InvoicesTable>
export type ItemRow = Selectable<InvoiceItemsTable>
export type EventRow = Selectable<LedgerEventsTable>
export type NewEvent = Insertable<LedgerEventsTable>

export function calcFromRow(r: InvoiceCalcRow): InvoiceCalc {
  return {
    items: r.items,
    adj: r.adj,
    sub: r.sub,
    tax: r.tax,
    tip: r.tip,
    total: r.total,
    paidOrig: r.paid_orig,
    creditApplied: r.credit_applied,
    paid: r.paid,
    refunded: r.refunded,
    refOrig: r.ref_orig,
    pendingAmt: r.pending_amt,
    pendingN: r.pending_n,
    issued: r.issued,
    balance: r.balance,
    refundable: r.refundable,
    toOrigMax: r.to_orig_max,
    net: r.net,
    overpaid: r.overpaid,
    status: r.status,
  }
}

/** The calc of one invoice from SQL. */
export async function calcOf(db: Executor, invoiceId: string): Promise<InvoiceCalc> {
  const r = await sql<InvoiceCalcRow>`select * from invoice_calc_of(${invoiceId}::uuid)`.execute(db)
  const row = r.rows[0]
  if (!row || row.invoice_id === null)
    throw new AppError('NOT_FOUND', { detail: 'That invoice does not exist' })
  return calcFromRow(row)
}

/** Locks the invoice row for the duration of the transaction; every money command starts here. */
export async function lockInvoice(tx: Tx, locationId: string, invoiceId: string): Promise<InvoiceRow> {
  const row = await tx
    .selectFrom('invoices')
    .selectAll()
    .where('id', '=', invoiceId)
    .where('location_id', '=', locationId)
    .forUpdate()
    .executeTakeFirst()
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That invoice does not exist' })
  return row
}

export async function getInvoice(db: Executor, locationId: string, invoiceId: string): Promise<InvoiceRow> {
  const row = await db
    .selectFrom('invoices')
    .selectAll()
    .where('id', '=', invoiceId)
    .where('location_id', '=', locationId)
    .executeTakeFirst()
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That invoice does not exist' })
  return row
}

export const listItems = (db: Executor, invoiceId: string): Promise<ItemRow[]> =>
  db.selectFrom('invoice_items').selectAll().where('invoice_id', '=', invoiceId).orderBy('position').execute()

/** Newest first by when it happened, then insertion order (review B31). */
export const listEvents = (db: Executor, invoiceId: string): Promise<EventRow[]> =>
  db
    .selectFrom('ledger_events')
    .selectAll()
    .where('invoice_id', '=', invoiceId)
    .orderBy('occurred_at', 'desc')
    .orderBy('seq', 'desc')
    .execute()

export async function insertEvent(tx: Tx, e: NewEvent): Promise<EventRow> {
  return tx.insertInto('ledger_events').values(e).returningAll().executeTakeFirstOrThrow()
}

/** Bumps the optimistic version after any change that affects what the invoice shows. */
export async function touchInvoice(tx: Tx, invoiceId: string, at: Date): Promise<number> {
  const r = await tx
    .updateTable('invoices')
    .set((eb) => ({ version: eb('version', '+', 1), updated_at: at }))
    .where('id', '=', invoiceId)
    .returning('version')
    .executeTakeFirstOrThrow()
  return r.version
}

export async function getEvent(db: Executor, locationId: string, eventId: string): Promise<EventRow> {
  const row = await db
    .selectFrom('ledger_events')
    .selectAll()
    .where('id', '=', eventId)
    .where('location_id', '=', locationId)
    .executeTakeFirst()
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That ledger entry does not exist' })
  return row
}

export async function getEventForUpdate(tx: Tx, locationId: string, eventId: string): Promise<EventRow> {
  const row = await tx
    .selectFrom('ledger_events')
    .selectAll()
    .where('id', '=', eventId)
    .where('location_id', '=', locationId)
    .executeTakeFirst()
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That ledger entry does not exist' })
  return row
}

/** Item ids already claimed by a done or pending item refund of the invoice (double-refund guard). */
export async function refundedItemIds(db: Executor, invoiceId: string): Promise<Set<string>> {
  const r = await sql<{ id: string }>`
    select distinct unnest(item_ids)::text as id from ledger_events
    where invoice_id = ${invoiceId} and type = 'refund' and status in ('done', 'pending')`.execute(db)
  return new Set(r.rows.map((x) => x.id))
}

const BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  discover: 'Discover',
  jcb: 'JCB',
}

/** A brand-only display label ("Visa"); a card with no known brand reads "Card". Never invents digits. */
export function cardLabel(brand: string | null | undefined): { label: string; brand: string | null } {
  const key = brand?.trim().toLowerCase() ?? ''
  const name = BRANDS[key]
  return name ? { label: name, brand: key } : { label: 'Card', brand: null }
}

export const kindOfMethodLabel = (m: string | null | undefined): MethodKind => {
  const s = (m ?? '').trim()
  if (/visa|master|amex|discover|jcb|card/i.test(s)) return 'card'
  if (s === 'Apple Pay') return 'apple_pay'
  if (s === 'Cash') return 'cash'
  if (s === 'Store credit') return 'store_credit'
  return 'other'
}

/** The label of the first non-voided payment: what a card refund shows as its method ("Visa ••5521"), else "Card". */
export async function firstPayMethod(
  db: Executor,
  invoiceId: string,
): Promise<{ method: string; kind: MethodKind; brand: string | null }> {
  const row = await db
    .selectFrom('ledger_events')
    .select(['method', 'method_kind', 'brand'])
    .where('invoice_id', '=', invoiceId)
    .where('type', '=', 'pay')
    .orderBy('occurred_at')
    .orderBy('seq')
    .executeTakeFirst()
  if (!row?.method) return { method: 'Card', kind: 'card', brand: null }
  return { method: row.method, kind: row.method_kind ?? kindOfMethodLabel(row.method), brand: row.brand }
}
