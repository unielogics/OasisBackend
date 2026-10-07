// Row <-> port-type mapping for the sync tables. The mapped order or transaction is stored as JSON (dates as ISO strings)
// next to the columns the queries use, so the sync and matcher read back exactly the object the adapter produced.
import { createHash } from 'node:crypto'
import type { SqspContact, SqspOrder, SqspTransaction } from '../../../integrations/ports/squarespace.js'
import type { JsonValue } from '../../../platform/schema.js'
import type { StoredContact, StoredOrder, StoredTransaction } from '../types.js'
import type { SqspOrdersTable, SqspTransactionsTable, SqspContactsTable } from './schema.js'
import type { Selectable } from 'kysely'

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v instanceof Date) return v.toISOString()
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      )
    }
    return v
  })
}

export const payloadHash = (value: unknown): string =>
  createHash('sha256').update(stable(value)).digest('hex')

/** JSON-safe copy: dates become ISO strings, undefined keys drop out. */
export function toJson<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const dateOf = (v: unknown): Date | undefined => (typeof v === 'string' ? new Date(v) : undefined)

export type OrderRow = Selectable<SqspOrdersTable>
export type TxnRow = Selectable<SqspTransactionsTable>
export type ContactRow = Selectable<SqspContactsTable>

export function orderFromJson(json: Record<string, JsonValue>, raw: unknown): SqspOrder {
  const o = json as unknown as Omit<SqspOrder, 'createdOn' | 'modifiedOn' | 'raw'> & {
    createdOn: string
    modifiedOn: string
  }
  return { ...o, createdOn: new Date(o.createdOn), modifiedOn: new Date(o.modifiedOn), raw }
}

export function txnFromJson(json: Record<string, JsonValue>, raw: unknown): SqspTransaction {
  const t = json as unknown as Omit<SqspTransaction, 'createdOn' | 'documentModifiedOn' | 'raw'> & {
    createdOn: string
    documentModifiedOn?: string
  }
  return { ...t, createdOn: new Date(t.createdOn), documentModifiedOn: dateOf(t.documentModifiedOn), raw }
}

export const storedOrder = (r: OrderRow): StoredOrder => ({
  order: orderFromJson(r.order_json, r.raw),
  firstSeenAt: r.first_seen_at,
  syncedAt: r.synced_at,
  matchState: r.match_state,
  ignoreReason: r.ignore_reason ?? undefined,
  matchedInvoiceId: r.matched_invoice_id ?? undefined,
  customerId: r.customer_id ?? undefined,
})

export const storedTransaction = (r: TxnRow): StoredTransaction => ({
  txn: txnFromJson(r.txn_json, r.raw),
  firstSeenAt: r.first_seen_at,
  syncedAt: r.synced_at,
  state: r.state,
  ignoreReason: r.ignore_reason ?? undefined,
  matchedEventId: r.matched_event_id ?? undefined,
})

export const storedContact = (r: ContactRow, customerId?: string): StoredContact => ({
  contact: {
    id: r.sqsp_contact_id,
    email: r.email ?? undefined,
    name: r.name ?? undefined,
    phone: r.phone ?? undefined,
    createdOn: r.created_on ?? undefined,
  } satisfies SqspContact,
  syncedAt: r.synced_at,
  customerId,
})

export function orderJson(o: SqspOrder): Record<string, JsonValue> {
  const { raw: _raw, ...rest } = o
  void _raw
  return toJson(rest) as Record<string, JsonValue>
}

export function txnJson(t: SqspTransaction): Record<string, JsonValue> {
  const { raw: _raw, ...rest } = t
  void _raw
  return toJson(rest) as Record<string, JsonValue>
}

/** The hash of a transaction ignores `raw` (Squarespace re-serialises untouched documents), as the in-memory repository does. */
export const txnHash = (t: SqspTransaction): string => {
  const { raw: _raw, ...fields } = t
  void _raw
  return payloadHash(fields)
}
