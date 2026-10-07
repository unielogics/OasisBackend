// Postgres implementations of the sync repository interfaces (repositories.ts one level up). Every upsert is one guarded
// statement keyed on the Squarespace id: a row is only rewritten by a payload that is not older and not identical, and the
// match fields (match_state, matched_invoice_id, customer_id, state, matched_event_id) are never touched by a re-sync.
import { sql, type Selectable } from 'kysely'
import type { SqspContact, SqspOrder, SqspTransaction } from '../../../integrations/ports/squarespace.js'
import { transaction, type Db, type Executor, type Tx } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import * as realtime from '../../../platform/realtime.js'
import type {
  ContactRepository,
  OrderRepository,
  SyncErrorRepository,
  SyncStateRepository,
  TransactionRepository,
} from '../repositories.js'
import type {
  InFlightWindow,
  MatchState,
  StoredContact,
  StoredOrder,
  StoredTransaction,
  SyncItemError,
  SyncResource,
  SyncState,
  TxnState,
  UpsertOutcome,
} from '../types.js'
import {
  orderJson,
  payloadHash,
  storedContact,
  storedOrder,
  storedTransaction,
  toJson,
  txnHash,
  txnJson,
} from './codec.js'
import type { SqspSyncStateTable } from './schema.js'

const rawColumn = (raw: unknown): string | null => (raw === undefined || raw === null ? null : JSON.stringify(raw))

export interface RepoDeps {
  db: Db
  locationId: string
  newId: NewId
  /** The clock the repository stamps match times with. */
  now: () => Date
}

/** The payments channel event the dashboard listens for: a Squarespace order was stored or its match state changed. */
export async function publishOrderSynced(
  tx: Tx,
  locationId: string,
  o: { orderId: string; orderNumber: string; matchState: string; invoiceId?: string | null },
): Promise<void> {
  await realtime.publish(tx, {
    locationId,
    channel: 'payments',
    type: 'squarespace.order_synced',
    payload: {
      orderId: o.orderId,
      orderNumber: o.orderNumber,
      matchState: o.matchState,
      ...(o.invoiceId ? { invoiceId: o.invoiceId } : {}),
    },
  })
}

export class PgOrderRepository implements OrderRepository {
  constructor(private readonly d: RepoDeps) {}

  async upsert(
    order: SqspOrder,
    ctx: { now: Date; initial: { matchState: MatchState; ignoreReason?: string } },
  ): Promise<UpsertOutcome> {
    const hash = payloadHash(order)
    const values = {
      location_id: this.d.locationId,
      sqsp_order_id: order.id,
      order_number: order.orderNumber,
      created_on: order.createdOn,
      modified_on: order.modifiedOn,
      customer_email: order.customerEmail ?? null,
      customer_name: order.customerName ?? null,
      customer_phone: order.customerPhone ?? null,
      sqsp_customer_id: order.customerId ?? null,
      channel: order.channel ?? null,
      fulfillment_status: order.fulfillmentStatus ?? null,
      payment_state: order.paymentState ?? null,
      is_subscription: order.isSubscription,
      grand_total_cents: order.grandTotalCents,
      refunded_total_cents: order.refundedTotalCents,
      subtotal_cents: order.subtotalCents ?? null,
      tax_cents: order.taxCents ?? null,
      currency: order.currency,
      test_mode: order.testMode,
      line_items: JSON.stringify(toJson(order.lineItems)),
      order_json: JSON.stringify(orderJson(order)),
      raw: rawColumn(order.raw),
      payload_hash: hash,
      synced_at: ctx.now,
    }
    return transaction(this.d.db, async (tx) => {
      const { synced_at, ...rest } = values
      void synced_at
      const row = await tx
        .insertInto('sqsp_orders')
        .values({
          id: this.d.newId(),
          ...values,
          match_state: ctx.initial.matchState,
          ignore_reason: ctx.initial.ignoreReason ?? null,
          first_seen_at: ctx.now,
        })
        .onConflict((oc) =>
          oc
            .columns(['location_id', 'sqsp_order_id'])
            .doUpdateSet((eb) => ({
              ...Object.fromEntries(
                Object.keys(rest)
                  .filter((k) => k !== 'location_id' && k !== 'sqsp_order_id')
                  .map((k) => [k, eb.ref(`excluded.${k}` as never)]),
              ),
              synced_at: ctx.now,
            }))
            .where((eb) =>
              eb.and([
                eb('sqsp_orders.modified_on', '<=', order.modifiedOn),
                eb('sqsp_orders.payload_hash', '<>', hash),
              ]),
            ),
        )
        .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
        .executeTakeFirst()
      if (row) {
        const state = await tx
          .selectFrom('sqsp_orders')
          .select(['match_state', 'matched_invoice_id'])
          .where('location_id', '=', this.d.locationId)
          .where('sqsp_order_id', '=', order.id)
          .executeTakeFirstOrThrow()
        await publishOrderSynced(tx, this.d.locationId, {
          orderId: order.id,
          orderNumber: order.orderNumber,
          matchState: state.match_state,
          invoiceId: state.matched_invoice_id,
        })
        return row.inserted ? 'inserted' : 'updated'
      }
      const cur = await tx
        .selectFrom('sqsp_orders')
        .select(['modified_on', 'payload_hash'])
        .where('location_id', '=', this.d.locationId)
        .where('sqsp_order_id', '=', order.id)
        .executeTakeFirstOrThrow()
      return cur.modified_on.getTime() > order.modifiedOn.getTime() ? 'stale' : 'unchanged'
    })
  }

  async get(id: string): Promise<StoredOrder | undefined> {
    const r = await this.d.db
      .selectFrom('sqsp_orders')
      .selectAll()
      .where('location_id', '=', this.d.locationId)
      .where('sqsp_order_id', '=', id)
      .executeTakeFirst()
    return r ? storedOrder(r) : undefined
  }

  async listByMatchState(state: MatchState, limit: number): Promise<StoredOrder[]> {
    const rows = await this.d.db
      .selectFrom('sqsp_orders')
      .selectAll()
      .where('location_id', '=', this.d.locationId)
      .where('match_state', '=', state)
      .orderBy('created_on')
      .orderBy('sqsp_order_id')
      .limit(limit)
      .execute()
    return rows.map(storedOrder)
  }

  async listModifiedBetween(from: Date, to: Date): Promise<StoredOrder[]> {
    const rows = await this.d.db
      .selectFrom('sqsp_orders')
      .selectAll()
      .where('location_id', '=', this.d.locationId)
      .where('modified_on', '>', from)
      .where('modified_on', '<', to)
      .execute()
    return rows.map(storedOrder)
  }

  async setMatch(
    id: string,
    patch: { matchState: MatchState; matchedInvoiceId?: string; customerId?: string; ignoreReason?: string },
  ): Promise<void> {
    await transaction(this.d.db, async (tx) => {
      const row = await tx
        .updateTable('sqsp_orders')
        .set((eb) => ({
          match_state: patch.matchState,
          matched_invoice_id: patch.matchedInvoiceId ?? eb.ref('matched_invoice_id'),
          customer_id: patch.customerId ?? eb.ref('customer_id'),
          ignore_reason: patch.ignoreReason ?? null,
          matched_at: this.d.now(),
        }))
        .where('location_id', '=', this.d.locationId)
        .where('sqsp_order_id', '=', id)
        .returning(['order_number', 'match_state', 'matched_invoice_id'])
        .executeTakeFirst()
      if (!row) throw new Error(`order ${id} not stored`)
      await publishOrderSynced(tx, this.d.locationId, {
        orderId: id,
        orderNumber: row.order_number,
        matchState: row.match_state,
        invoiceId: row.matched_invoice_id,
      })
    })
  }
}

export class PgTransactionRepository implements TransactionRepository {
  constructor(private readonly d: RepoDeps) {}

  async upsert(
    txn: SqspTransaction,
    ctx: { now: Date; initial: { state: TxnState; ignoreReason?: string } },
  ): Promise<UpsertOutcome> {
    const hash = txnHash(txn)
    const effective = txn.documentModifiedOn ?? txn.createdOn
    const values = {
      location_id: this.d.locationId,
      sqsp_txn_id: txn.id,
      sqsp_order_id: txn.orderId ?? null,
      kind: txn.kind,
      created_on: txn.createdOn,
      amount_cents: txn.amountCents,
      currency: txn.currency,
      brand: txn.brand ?? null,
      provider: txn.provider ?? null,
      document_id: txn.documentId ?? null,
      payment_id: txn.paymentId ?? null,
      external_transaction_id: txn.externalTransactionId ?? null,
      voided: txn.voided ?? false,
      document_modified_on: txn.documentModifiedOn ?? null,
      effective_modified_on: effective,
      customer_email: txn.customerEmail ?? null,
      txn_json: JSON.stringify(txnJson(txn)),
      raw: rawColumn(txn.raw),
      payload_hash: hash,
    }
    const { location_id, sqsp_txn_id, ...updatable } = values
    void location_id
    void sqsp_txn_id
    return transaction(this.d.db, async (tx) => {
      const row = await tx
        .insertInto('sqsp_transactions')
        .values({
          id: this.d.newId(),
          ...values,
          state: ctx.initial.state,
          ignore_reason: ctx.initial.ignoreReason ?? null,
          first_seen_at: ctx.now,
          synced_at: ctx.now,
        })
        .onConflict((oc) =>
          oc
            .columns(['location_id', 'sqsp_txn_id'])
            .doUpdateSet((eb) => ({
              ...Object.fromEntries(
                Object.keys(updatable).map((k) => [k, eb.ref(`excluded.${k}` as never)]),
              ),
              synced_at: ctx.now,
            }))
            .where((eb) =>
              eb.and([
                eb('sqsp_transactions.effective_modified_on', '<=', effective),
                eb('sqsp_transactions.payload_hash', '<>', hash),
              ]),
            ),
        )
        .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
        .executeTakeFirst()
      if (row) return row.inserted ? 'inserted' : 'updated'
      const cur = await tx
        .selectFrom('sqsp_transactions')
        .select('effective_modified_on')
        .where('location_id', '=', this.d.locationId)
        .where('sqsp_txn_id', '=', txn.id)
        .executeTakeFirstOrThrow()
      return cur.effective_modified_on.getTime() > effective.getTime() ? 'stale' : 'unchanged'
    })
  }

  async get(id: string): Promise<StoredTransaction | undefined> {
    const r = await this.d.db
      .selectFrom('sqsp_transactions')
      .selectAll()
      .where('location_id', '=', this.d.locationId)
      .where('sqsp_txn_id', '=', id)
      .executeTakeFirst()
    return r ? storedTransaction(r) : undefined
  }

  async listByOrder(orderId: string): Promise<StoredTransaction[]> {
    const rows = await this.d.db
      .selectFrom('sqsp_transactions')
      .selectAll()
      .where('location_id', '=', this.d.locationId)
      .where('sqsp_order_id', '=', orderId)
      .orderBy('created_on')
      .orderBy('sqsp_txn_id')
      .execute()
    return rows.map(storedTransaction)
  }

  async listByState(states: TxnState[], limit: number): Promise<StoredTransaction[]> {
    if (states.length === 0) return []
    const rows = await this.d.db
      .selectFrom('sqsp_transactions')
      .selectAll()
      .where('location_id', '=', this.d.locationId)
      .where('state', 'in', states)
      .orderBy('created_on')
      .orderBy('sqsp_txn_id')
      .limit(limit)
      .execute()
    return rows.map(storedTransaction)
  }

  async setState(
    id: string,
    patch: { state: TxnState; matchedEventId?: string; ignoreReason?: string },
  ): Promise<void> {
    const r = await this.d.db
      .updateTable('sqsp_transactions')
      .set((eb) => ({
        state: patch.state,
        matched_event_id: patch.matchedEventId ?? eb.ref('matched_event_id'),
        ignore_reason: patch.ignoreReason ?? null,
      }))
      .where('location_id', '=', this.d.locationId)
      .where('sqsp_txn_id', '=', id)
      .executeTakeFirst()
    if (Number(r.numUpdatedRows) === 0) throw new Error(`transaction ${id} not stored`)
  }
}

export class PgContactRepository implements ContactRepository {
  constructor(private readonly d: RepoDeps) {}

  async upsert(contact: SqspContact, ctx: { now: Date }): Promise<UpsertOutcome> {
    const hash = payloadHash(contact)
    const values = {
      location_id: this.d.locationId,
      sqsp_contact_id: contact.id,
      email: contact.email ?? null,
      name: contact.name ?? null,
      phone: contact.phone ?? null,
      created_on: contact.createdOn ?? null,
      payload_hash: hash,
      synced_at: ctx.now,
    }
    const row = await this.d.db
      .insertInto('sqsp_contacts')
      .values({ id: this.d.newId(), ...values })
      .onConflict((oc) =>
        oc
          .columns(['location_id', 'sqsp_contact_id'])
          .doUpdateSet((eb) => ({
            email: eb.ref('excluded.email'),
            name: eb.ref('excluded.name'),
            phone: eb.ref('excluded.phone'),
            created_on: eb.ref('excluded.created_on'),
            payload_hash: eb.ref('excluded.payload_hash'),
            synced_at: ctx.now,
          }))
          .where('sqsp_contacts.payload_hash', '<>', hash),
      )
      .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
      .executeTakeFirst()
    if (!row) return 'unchanged'
    return row.inserted ? 'inserted' : 'updated'
  }

  async list(): Promise<StoredContact[]> {
    const rows = await this.d.db
      .selectFrom('sqsp_contacts as c')
      .leftJoin('sqsp_customer_links as l', (j) =>
        j
          .onRef('l.sqsp_customer_id', '=', 'c.sqsp_contact_id')
          .onRef('l.location_id', '=', 'c.location_id'),
      )
      .selectAll('c')
      .select('l.customer_id as linked_customer_id')
      .where('c.location_id', '=', this.d.locationId)
      .orderBy('c.sqsp_contact_id')
      .execute()
    return rows.map((r) => storedContact(r, r.linked_customer_id ?? undefined))
  }
}

type StateRow = Selectable<SqspSyncStateTable>

const windowOf = (v: unknown): InFlightWindow | undefined => {
  if (!v || typeof v !== 'object') return undefined
  const w = v as { from: string; to: string; cursor?: string }
  return { from: new Date(w.from), to: new Date(w.to), ...(w.cursor ? { cursor: w.cursor } : {}) }
}

const stateOf = (r: StateRow): SyncState => ({
  resource: r.resource,
  watermark: r.watermark ?? undefined,
  inFlight: windowOf(r.in_flight),
  phase: r.phase ?? undefined,
  windowStart: r.window_start ?? undefined,
  lastRunAt: r.last_run_at ?? undefined,
  lastSuccessAt: r.last_success_at ?? undefined,
  status: r.status,
  lastError: r.last_error ?? undefined,
  consecutiveFailures: r.consecutive_failures,
})

export class PgSyncStateRepository implements SyncStateRepository {
  constructor(
    private readonly db: Executor,
    private readonly locationId: string,
    private readonly now: () => Date,
  ) {}

  async get(resource: SyncResource): Promise<SyncState | undefined> {
    const r = await this.db
      .selectFrom('sqsp_sync_state')
      .selectAll()
      .where('location_id', '=', this.locationId)
      .where('resource', '=', resource)
      .executeTakeFirst()
    return r ? stateOf(r) : undefined
  }

  async save(s: SyncState): Promise<void> {
    const v = {
      watermark: s.watermark ?? null,
      in_flight: s.inFlight ? JSON.stringify(toJson(s.inFlight)) : null,
      phase: s.phase ?? null,
      window_start: s.windowStart ?? null,
      last_run_at: s.lastRunAt ?? null,
      last_success_at: s.lastSuccessAt ?? null,
      status: s.status,
      last_error: s.lastError ?? null,
      consecutive_failures: s.consecutiveFailures,
      updated_at: this.now(),
    }
    await this.db
      .insertInto('sqsp_sync_state')
      .values({ location_id: this.locationId, resource: s.resource, ...v })
      .onConflict((oc) => oc.columns(['location_id', 'resource']).doUpdateSet(v))
      .execute()
  }
}

export class PgSyncErrorRepository implements SyncErrorRepository {
  constructor(
    private readonly db: Executor,
    private readonly locationId: string,
    private readonly newId: NewId,
    private readonly now: () => Date,
    /** Failures of one key after which it is dead-lettered (the sync stops holding the watermark for it). */
    private readonly deadLetterAfter = 5,
  ) {}

  async record(e: SyncItemError): Promise<{ attempts: number }> {
    const raw = e.raw === undefined ? null : JSON.stringify(toJson(e.raw))
    const r = await sql<{ attempts: number }>`
      insert into sqsp_sync_errors (id, location_id, resource, key, kind, message, raw, attempts, first_at, last_at)
      values (${this.newId()}, ${this.locationId}, ${e.resource}, ${e.key}, ${e.kind}, ${e.message}, ${raw}::jsonb, 1, ${e.at}, ${e.at})
      on conflict (location_id, resource, key) do update set
        attempts = case when sqsp_sync_errors.resolved_at is not null then 1 else sqsp_sync_errors.attempts + 1 end,
        first_at = case when sqsp_sync_errors.resolved_at is not null then excluded.first_at else sqsp_sync_errors.first_at end,
        dead_lettered_at = case when sqsp_sync_errors.resolved_at is not null then null else sqsp_sync_errors.dead_lettered_at end,
        kind = excluded.kind,
        message = excluded.message,
        raw = excluded.raw,
        last_at = excluded.last_at,
        resolved_at = null
      returning attempts`.execute(this.db)
    const attempts = r.rows[0]!.attempts
    if (attempts >= this.deadLetterAfter) {
      await sql`update sqsp_sync_errors set dead_lettered_at = coalesce(dead_lettered_at, ${e.at})
        where location_id = ${this.locationId} and resource = ${e.resource} and key = ${e.key}`.execute(this.db)
    }
    return { attempts }
  }

  async clear(resource: SyncResource, key: string): Promise<void> {
    await sql`update sqsp_sync_errors set resolved_at = ${this.now()}
      where location_id = ${this.locationId} and resource = ${resource} and key = ${key} and resolved_at is null`.execute(
      this.db,
    )
  }

  async list(resource?: SyncResource): Promise<(SyncItemError & { attempts: number })[]> {
    let q = this.db
      .selectFrom('sqsp_sync_errors')
      .selectAll()
      .where('location_id', '=', this.locationId)
      .where('resolved_at', 'is', null)
    if (resource) q = q.where('resource', '=', resource)
    const rows = await q.orderBy('first_at').orderBy('key').execute()
    return rows.map((r) => ({
      resource: r.resource,
      key: r.key,
      kind: r.kind,
      message: r.message,
      raw: r.raw ?? undefined,
      at: r.last_at,
      attempts: r.attempts,
    }))
  }
}
