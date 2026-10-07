// The manual matching queue: what staff see for orders the matcher would not decide alone, and the two resolutions
// (match to an invoice or a card payment waiting on Squarespace, or ignore). Both run inside the caller's transaction and use
// the same Squarespace-derived idempotency keys as the matcher, so a later poll recognises the money as already recorded.
import { sql } from 'kysely'
import * as audit from '../../../platform/audit.js'
import type { Clock } from '../../../platform/clock.js'
import type { Executor, Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import type { NewId } from '../../../platform/ids.js'
import { decodeCursor, keysetCondition, toPage, type Page } from '../../../platform/pagination.js'
import { calcOf } from '../../payments/repository.js'
import { arrivalsForOrder, type Arrival } from '../matcher.js'
import { raiseAlert, resolveAlerts } from './alerts.js'
import { storedOrder, storedTransaction } from './codec.js'
import { publishOrderSynced } from './repositories.js'
import { varianceOf, type CommandActor, type SqspLedgerOps } from './ledger.js'
import type { SqspMatchState } from './schema.js'
import './problems.js'

export interface ManualDeps {
  locationId: string
  clock: Clock
  newId: NewId
  ops: SqspLedgerOps
  varianceAlertCents: number
}

export interface ManualMatchInput {
  orderId: string
  invoiceId?: string
  eventId?: string
  /** Record the payment even when the invoice already shows one of the same amount. */
  force?: boolean
}

export interface ManualMatchResult {
  orderId: string
  invoiceId: string
  applied: {
    kind: Arrival['kind']
    transactionId: string | null
    eventId: string
    how: 'confirmed' | 'recorded'
  }[]
}

const keyOf = (a: Arrival): string => `sqsp:${a.orderId}:${a.kind}:${a.transactionId ?? 'order'}`

async function loadOrder(tx: Executor, locationId: string, orderId: string) {
  const row = await tx
    .selectFrom('sqsp_orders')
    .selectAll()
    .where('location_id', '=', locationId)
    .where('sqsp_order_id', '=', orderId)
    .executeTakeFirst()
  if (!row) throw new AppError('SQSP_ORDER_NOT_FOUND')
  return row
}

export async function manualMatch(
  tx: Tx,
  d: ManualDeps,
  input: ManualMatchInput,
  actor: CommandActor,
): Promise<ManualMatchResult> {
  if (!input.invoiceId && !input.eventId) throw new AppError('SQSP_MATCH_TARGET_REQUIRED')
  const orderRow = await loadOrder(tx, d.locationId, input.orderId)
  if (orderRow.match_state === 'ignored' || orderRow.match_state === 'membership')
    throw new AppError('SQSP_ORDER_NOT_MATCHABLE')
  const order = storedOrder(orderRow).order
  const all = (
    await tx
      .selectFrom('sqsp_transactions')
      .selectAll()
      .where('location_id', '=', d.locationId)
      .where('sqsp_order_id', '=', input.orderId)
      .orderBy('created_on')
      .orderBy('sqsp_txn_id')
      .execute()
  ).map(storedTransaction)
  const pending = all.filter((t) => t.state === 'new' || t.state === 'deferred' || t.state === 'manual')
  const arrivals = arrivalsForOrder(
    order,
    pending.map((t) => t.txn),
    {
      includeOrderLevel: !all.some((t) => t.txn.kind === 'payment'),
    },
  ).filter((a) => !all.some((t) => t.txn.id === a.transactionId && t.state === 'matched'))
  if (arrivals.length === 0) throw new AppError('SQSP_NOTHING_TO_MATCH')

  const actorCtx: CommandActor = { ...actor, manual: true }
  let invoiceId = input.invoiceId
  let eventRow: Awaited<ReturnType<typeof loadEvent>> | undefined
  if (input.eventId) {
    eventRow = await loadEvent(tx, d.locationId, input.eventId)
    if (input.invoiceId && input.invoiceId !== eventRow.invoice_id)
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ path: 'invoiceId', message: 'That payment belongs to a different invoice' }],
      })
    invoiceId = eventRow.invoice_id
  }
  const invoice = await tx
    .selectFrom('invoices')
    .select(['id', 'customer_id'])
    .where('id', '=', invoiceId!)
    .where('location_id', '=', d.locationId)
    .executeTakeFirst()
  if (!invoice) throw new AppError('NOT_FOUND', { detail: 'That invoice does not exist' })

  const applied: ManualMatchResult['applied'] = []
  const claimedEvents = new Set<string>()
  for (const a of arrivals) {
    const summary = await d.ops.invoiceSummary(tx, invoice.id)
    const variance = varianceOf(a.orderTotalCents, a.orderTaxCents, summary, d.varianceAlertCents)
    const key = keyOf(a)
    const alertBase = {
      orderId: a.orderId,
      transactionId: a.transactionId,
      invoiceId: invoice.id,
    }
    if (
      eventRow &&
      !claimedEvents.has(eventRow.id) &&
      eventRow.type === (a.kind === 'payment' ? 'pay' : 'refund')
    ) {
      if (
        eventRow.processor_state !== 'awaiting_processor' &&
        !(eventRow.type === 'refund' && eventRow.status === 'pending')
      )
        throw new AppError('SQSP_EVENT_NOT_AWAITING')
      const sameAmount = arrivals.filter((x) => x.kind === a.kind && x.amountCents === eventRow!.amount_cents)
      const sameKind = arrivals.filter((x) => x.kind === a.kind)
      if (sameAmount.length !== 1 && !(sameKind.length === 1)) throw new AppError('SQSP_MATCH_AMBIGUOUS')
      if (sameAmount.length === 1 && sameAmount[0] !== a) continue
      claimedEvents.add(eventRow.id)
      if (a.kind === 'payment') {
        await d.ops.confirmAwaiting(
          tx,
          {
            idempotencyKey: key,
            eventId: eventRow.id,
            sqspOrderId: a.orderId,
            processorRef: a.transactionId,
            variance,
            txnId: a.transactionId,
          },
          actorCtx,
        )
      } else {
        await d.ops.confirmRefund(
          tx,
          {
            idempotencyKey: key,
            eventId: eventRow.id,
            sqspOrderId: a.orderId,
            processorRef: a.transactionId ?? key,
            txnId: a.transactionId,
          },
          actorCtx,
        )
      }
      applied.push({
        kind: a.kind,
        transactionId: a.transactionId ?? null,
        eventId: eventRow.id,
        how: 'confirmed',
      })
      if (variance.exceedsAlert && a.kind === 'payment')
        await raiseAlert(tx, d, {
          code: 'variance_exceeds_delta',
          ...alertBase,
          message: varianceMessage(a, variance.deltaCents),
          variance,
        })
      continue
    }
    if (a.kind === 'payment') {
      if (!input.force) await assertNoDuplicate(tx, invoice.id, a, summary)
      const calc = await calcOf(tx, invoice.id)
      const { eventId } = await d.ops.recordPayment(
        tx,
        {
          idempotencyKey: key,
          invoiceId: invoice.id,
          paymentLinkId: null,
          deposit: a.amountCents < calc.balance,
          amountCents: a.amountCents,
          occurredAt: a.occurredAt,
          brand: a.brand,
          sqspOrderId: a.orderId,
          processorRef: a.transactionId,
          txnId: a.transactionId,
          variance,
        },
        actorCtx,
      )
      applied.push({ kind: 'payment', transactionId: a.transactionId ?? null, eventId, how: 'recorded' })
      if (variance.exceedsAlert)
        await raiseAlert(tx, d, {
          code: 'variance_exceeds_delta',
          ...alertBase,
          message: varianceMessage(a, variance.deltaCents),
          variance,
        })
    } else {
      const { eventId } = await d.ops.recordExternalRefund(
        tx,
        {
          idempotencyKey: key,
          invoiceId: invoice.id,
          amountCents: a.amountCents,
          occurredAt: a.occurredAt,
          brand: a.brand,
          sqspOrderId: a.orderId,
          processorRef: a.transactionId,
          txnId: a.transactionId,
        },
        actorCtx,
      )
      applied.push({ kind: 'refund', transactionId: a.transactionId ?? null, eventId, how: 'recorded' })
      await raiseAlert(tx, d, {
        code: 'external_refund',
        ...alertBase,
        message: `A refund of ${a.amountCents} cents on order ${a.orderNumber} was made in Squarespace, outside Oasis limits and approvals.`,
      })
    }
  }
  if (applied.length === 0) throw new AppError('SQSP_NOTHING_TO_MATCH')

  const now = d.clock.now()
  for (const x of applied) {
    if (x.transactionId)
      await tx
        .updateTable('sqsp_transactions')
        .set({ state: 'matched', matched_event_id: x.eventId, ignore_reason: null })
        .where('location_id', '=', d.locationId)
        .where('sqsp_txn_id', '=', x.transactionId)
        .execute()
  }
  const stillPending = await pendingCount(tx, d.locationId, input.orderId)
  await tx
    .updateTable('sqsp_orders')
    .set({
      match_state: 'manual',
      matched_invoice_id: invoice.id,
      customer_id: invoice.customer_id,
      matched_at: now,
      ignore_reason: null,
    })
    .where('location_id', '=', d.locationId)
    .where('sqsp_order_id', '=', input.orderId)
    .execute()
  await tx
    .updateTable('sqsp_manual_queue')
    .set({ state: 'resolved', resolution: 'matched', resolved_at: now, resolved_by: actor.userId ?? null })
    .where('location_id', '=', d.locationId)
    .where('sqsp_order_id', '=', input.orderId)
    .where('state', '=', 'open')
    .where((eb) => {
      const ids = applied.map((x) => x.transactionId).filter((x): x is string => x !== null)
      return eb.or([eb('sqsp_txn_id', 'is', null), ...(ids.length ? [eb('sqsp_txn_id', 'in', ids)] : [])])
    })
    .execute()
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'sqsp.manual_match',
    entityType: 'sqsp_order',
    entityId: input.orderId,
    after: { invoiceId: invoice.id, applied, unresolvedArrivals: stillPending },
    ctx: actor.audit,
  })
  await publishOrderSynced(tx, d.locationId, {
    orderId: input.orderId,
    orderNumber: orderRow.order_number,
    matchState: 'manual',
    invoiceId: invoice.id,
  })
  return { orderId: input.orderId, invoiceId: invoice.id, applied }
}

const varianceMessage = (a: Arrival, delta: number): string =>
  `Squarespace order ${a.orderNumber} total differs from the Oasis invoice by ${delta} cents.`

async function pendingCount(tx: Executor, locationId: string, orderId: string): Promise<number> {
  const r = await tx
    .selectFrom('sqsp_transactions')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('location_id', '=', locationId)
    .where('sqsp_order_id', '=', orderId)
    .where('state', 'in', ['new', 'deferred', 'manual'])
    .executeTakeFirstOrThrow()
  return r.n
}

async function loadEvent(tx: Executor, locationId: string, eventId: string) {
  const ev = await tx
    .selectFrom('ledger_events')
    .select(['id', 'invoice_id', 'type', 'status', 'amount_cents', 'processor_state'])
    .where('id', '=', eventId)
    .where('location_id', '=', locationId)
    .executeTakeFirst()
  if (!ev || (ev.type !== 'pay' && ev.type !== 'refund'))
    throw new AppError('NOT_FOUND', { detail: 'That ledger entry does not exist' })
  return ev
}

async function assertNoDuplicate(
  tx: Executor,
  invoiceId: string,
  a: Arrival,
  summary: Awaited<ReturnType<SqspLedgerOps['invoiceSummary']>>,
): Promise<void> {
  const awaiting = await sql<{ id: string }>`
    select e.id from ledger_events e
    where e.invoice_id = ${invoiceId} and e.type = 'pay' and e.processor_state = 'awaiting_processor'
      and not exists (select 1 from ledger_events v where v.voids_event_id = e.id)`.execute(tx)
  const same = (summary.payEvents ?? []).filter(
    (p) =>
      p.sqspOrderId !== a.orderId &&
      p.amountCents === a.amountCents &&
      p.methodKind !== 'cash' &&
      p.methodKind !== 'store_credit',
  )
  if (awaiting.rows.length > 0 || same.length > 0)
    throw new AppError('SQSP_MATCH_DUPLICATE', {
      meta: { eventIds: [...new Set([...awaiting.rows.map((r) => r.id), ...same.map((p) => p.id)])] },
    })
}

export async function manualIgnore(
  tx: Tx,
  d: ManualDeps,
  input: { orderId: string; reason?: string },
  actor: CommandActor,
): Promise<{ orderId: string; alreadyIgnored: boolean }> {
  const row = await loadOrder(tx, d.locationId, input.orderId)
  if (row.match_state === 'ignored') return { orderId: input.orderId, alreadyIgnored: true }
  if (row.match_state === 'membership') throw new AppError('SQSP_ORDER_NOT_MATCHABLE')
  const money = await tx
    .selectFrom('sqsp_matches')
    .select('id')
    .where('location_id', '=', d.locationId)
    .where('sqsp_order_id', '=', input.orderId)
    .where('event_id', 'is not', null)
    .limit(1)
    .executeTakeFirst()
  if (money) throw new AppError('SQSP_ORDER_ALREADY_MATCHED')
  const now = d.clock.now()
  const reason = input.reason?.trim() ? `manual: ${input.reason.trim().slice(0, 200)}` : 'manual'
  await tx
    .updateTable('sqsp_orders')
    .set({ match_state: 'ignored', ignore_reason: reason, matched_at: now })
    .where('location_id', '=', d.locationId)
    .where('sqsp_order_id', '=', input.orderId)
    .execute()
  await tx
    .updateTable('sqsp_transactions')
    .set({ state: 'ignored', ignore_reason: reason })
    .where('location_id', '=', d.locationId)
    .where('sqsp_order_id', '=', input.orderId)
    .where('state', 'in', ['new', 'deferred', 'manual'])
    .execute()
  await tx
    .updateTable('sqsp_manual_queue')
    .set({ state: 'ignored', resolution: 'ignored', resolved_at: now, resolved_by: actor.userId ?? null })
    .where('location_id', '=', d.locationId)
    .where('sqsp_order_id', '=', input.orderId)
    .where('state', '=', 'open')
    .execute()
  await tx
    .insertInto('sqsp_matches')
    .values({
      id: d.newId(),
      location_id: d.locationId,
      idempotency_key: `sqsp:${input.orderId}:ignore`,
      kind: 'manual_ignore',
      sqsp_order_id: input.orderId,
      manual: true,
      actor_user_id: actor.userId ?? null,
      created_at: now,
    })
    .onConflict((oc) => oc.column('idempotency_key').doNothing())
    .execute()
  await resolveAlerts(
    tx,
    d,
    ['variance_exceeds_delta', 'partially_unmapped_skus', 'mixed_membership_order'],
    {
      orderId: input.orderId,
      by: actor.userId,
    },
  )
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'sqsp.manual_ignore',
    entityType: 'sqsp_order',
    entityId: input.orderId,
    before: { matchState: row.match_state },
    after: { reason },
    ctx: actor.audit,
  })
  await publishOrderSynced(tx, d.locationId, {
    orderId: input.orderId,
    orderNumber: row.order_number,
    matchState: 'ignored',
  })
  return { orderId: input.orderId, alreadyIgnored: false }
}

/**
 * Gives the matcher another chance at everything waiting in the queue (after staff recorded the missing card payment, for
 * example): manual orders without an invoice go back to unmatched, their queued transactions to new, open queue rows are dropped
 * (the matcher writes fresh ones if it still cannot decide).
 */
export async function requeueManual(tx: Executor, d: { locationId: string }): Promise<{ orders: number }> {
  const orders = await tx
    .updateTable('sqsp_orders')
    .set({ match_state: 'unmatched' })
    .where('location_id', '=', d.locationId)
    .where('match_state', '=', 'manual')
    .where('matched_invoice_id', 'is', null)
    .returning('sqsp_order_id')
    .execute()
  const ids = orders.map((o) => o.sqsp_order_id)
  if (ids.length === 0) return { orders: 0 }
  await tx
    .updateTable('sqsp_transactions')
    .set({ state: 'new' })
    .where('location_id', '=', d.locationId)
    .where('state', '=', 'manual')
    .where('sqsp_order_id', 'in', ids)
    .execute()
  await tx
    .deleteFrom('sqsp_manual_queue')
    .where('location_id', '=', d.locationId)
    .where('state', '=', 'open')
    .where('sqsp_order_id', 'in', ids)
    .execute()
  return { orders: ids.length }
}

/**
 * The common sequence at the counter is the customer paying on the terminal (the order reaches us within minutes) and the staff
 * member recording the card payment in Oasis a little LATER. An order the matcher could not place stays in the queue, so each
 * cycle gives the ones that had no candidate (or only a weak one) another chance when a staff-recorded payment waiting on
 * Squarespace, or a new payment link, appeared after the item was queued. Once per new candidate: the fresh queue row is newer
 * than the candidate, so nothing loops.
 */
export async function requeueWithNewCandidates(
  tx: Executor,
  d: { locationId: string },
): Promise<{ orders: number }> {
  const r = await sql<{ sqsp_order_id: string }>`
    select distinct q.sqsp_order_id
    from sqsp_manual_queue q
    join sqsp_orders o on o.location_id = q.location_id and o.sqsp_order_id = q.sqsp_order_id
    where q.location_id = ${d.locationId} and q.state = 'open' and q.reason in ('no_candidate', 'low_confidence')
      and o.match_state = 'manual' and o.matched_invoice_id is null
      and (exists (select 1 from ledger_events e
                   where e.location_id = q.location_id and e.processor_state = 'awaiting_processor' and e.created_at > q.created_at
                     and not exists (select 1 from ledger_events v where v.voids_event_id = e.id))
        or exists (select 1 from payment_links l
                   where l.location_id = q.location_id and l.state = 'active' and l.created_at > q.created_at))`.execute(
    tx,
  )
  const ids = r.rows.map((x) => x.sqsp_order_id)
  if (ids.length === 0) return { orders: 0 }
  await tx
    .updateTable('sqsp_orders')
    .set({ match_state: 'unmatched' })
    .where('location_id', '=', d.locationId)
    .where('sqsp_order_id', 'in', ids)
    .execute()
  await tx
    .updateTable('sqsp_transactions')
    .set({ state: 'new' })
    .where('location_id', '=', d.locationId)
    .where('state', '=', 'manual')
    .where('sqsp_order_id', 'in', ids)
    .execute()
  await tx
    .deleteFrom('sqsp_manual_queue')
    .where('location_id', '=', d.locationId)
    .where('state', '=', 'open')
    .where('sqsp_order_id', 'in', ids)
    .execute()
  return { orders: ids.length }
}

/** Orders ignored only because no product was mapped become unmatched again when the map changes. */
export async function reopenUnmapped(tx: Executor, d: { locationId: string }): Promise<{ orders: number }> {
  const orders = await tx
    .updateTable('sqsp_orders')
    .set({ match_state: 'unmatched', ignore_reason: null })
    .where('location_id', '=', d.locationId)
    .where('match_state', '=', 'ignored')
    .where('ignore_reason', '=', 'unmapped_sku')
    .returning('sqsp_order_id')
    .execute()
  const ids = orders.map((o) => o.sqsp_order_id)
  if (ids.length > 0)
    await tx
      .updateTable('sqsp_transactions')
      .set({ state: 'new', ignore_reason: null })
      .where('location_id', '=', d.locationId)
      .where('state', '=', 'ignored')
      .where('ignore_reason', '=', 'unmapped_sku')
      .where('sqsp_order_id', 'in', ids)
      .execute()
  return { orders: ids.length }
}

// ---- reads -------------------------------------------------------------------------------------------------------------

export interface OrderListItem {
  sqspOrderId: string
  orderNumber: string
  createdOn: string
  modifiedOn: string
  customerEmail: string | null
  customerName: string | null
  customerPhone: string | null
  paymentState: string | null
  totalCents: number
  refundedCents: number
  currency: string
  matchState: SqspMatchState
  ignoreReason: string | null
  matchedInvoiceId: string | null
  lineItems: { name: string; sku: string | null; productId: string | null; qty: number; unitCents: number }[]
  transactions: {
    id: string
    kind: 'payment' | 'refund'
    amountCents: number
    state: string
    createdOn: string
    brand: string | null
  }[]
  queue: {
    id: string
    reason: string
    transactionId: string | null
    candidates: unknown
    variance: unknown
    createdAt: string
  }[]
  /** What was applied to the ledger for this order, with the Squarespace-versus-Oasis variance of each. */
  matches: {
    kind: string
    transactionId: string | null
    eventId: string | null
    invoiceId: string | null
    rule: string | null
    confidence: number | null
    manual: boolean
    variance: unknown
    at: string
  }[]
}

export type OrderListState = 'unmatched' | SqspMatchState | 'all'

export async function listOrders(
  db: Executor,
  locationId: string,
  q: { state: OrderListState; limit: number; cursor?: string },
): Promise<Page<OrderListItem>> {
  let query = db.selectFrom('sqsp_orders as o').selectAll('o').where('o.location_id', '=', locationId)
  if (q.state === 'unmatched') {
    query = query.where((eb) =>
      eb.or([
        eb('o.match_state', '=', 'unmatched'),
        eb.exists(
          eb
            .selectFrom('sqsp_manual_queue as m')
            .select('m.id')
            .whereRef('m.sqsp_order_id', '=', 'o.sqsp_order_id')
            .whereRef('m.location_id', '=', 'o.location_id')
            .where('m.state', '=', 'open'),
        ),
      ]),
    )
  } else if (q.state !== 'all') query = query.where('o.match_state', '=', q.state)
  if (q.cursor) {
    const [at, id] = decodeCursor(q.cursor, 2)
    query = query.where(
      keysetCondition(['o.created_on', 'o.sqsp_order_id'], [at as string, id as string], 'asc'),
    )
  }
  const rows = await query
    .orderBy('o.created_on')
    .orderBy('o.sqsp_order_id')
    .limit(q.limit + 1)
    .execute()
  const page = toPage(rows, q.limit, (r) => [r.created_on.toISOString(), r.sqsp_order_id])
  const ids = page.items.map((r) => r.sqsp_order_id)
  const txns = ids.length
    ? await db
        .selectFrom('sqsp_transactions')
        .selectAll()
        .where('location_id', '=', locationId)
        .where('sqsp_order_id', 'in', ids)
        .orderBy('created_on')
        .execute()
    : []
  const queue = ids.length
    ? await db
        .selectFrom('sqsp_manual_queue')
        .selectAll()
        .where('location_id', '=', locationId)
        .where('sqsp_order_id', 'in', ids)
        .where('state', '=', 'open')
        .orderBy('created_at')
        .execute()
    : []
  const matches = ids.length
    ? await db
        .selectFrom('sqsp_matches')
        .selectAll()
        .where('location_id', '=', locationId)
        .where('sqsp_order_id', 'in', ids)
        .orderBy('created_at')
        .orderBy('id')
        .execute()
    : []
  return {
    nextCursor: page.nextCursor,
    items: page.items.map((r) => ({
      sqspOrderId: r.sqsp_order_id,
      orderNumber: r.order_number,
      createdOn: r.created_on.toISOString(),
      modifiedOn: r.modified_on.toISOString(),
      customerEmail: r.customer_email,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      paymentState: r.payment_state,
      totalCents: r.grand_total_cents,
      refundedCents: r.refunded_total_cents,
      currency: r.currency,
      matchState: r.match_state,
      ignoreReason: r.ignore_reason,
      matchedInvoiceId: r.matched_invoice_id,
      lineItems: (
        r.line_items as {
          name?: string
          sku?: string
          productId?: string
          qty?: number
          unitCents?: number
        }[]
      ).map((li) => ({
        name: li.name ?? '',
        sku: li.sku ?? null,
        productId: li.productId ?? null,
        qty: li.qty ?? 1,
        unitCents: li.unitCents ?? 0,
      })),
      transactions: txns
        .filter((t) => t.sqsp_order_id === r.sqsp_order_id)
        .map((t) => ({
          id: t.sqsp_txn_id,
          kind: t.kind,
          amountCents: t.amount_cents,
          state: t.state,
          createdOn: t.created_on.toISOString(),
          brand: t.brand,
        })),
      matches: matches
        .filter((m) => m.sqsp_order_id === r.sqsp_order_id)
        .map((m) => ({
          kind: m.kind,
          transactionId: m.sqsp_txn_id,
          eventId: m.event_id,
          invoiceId: m.invoice_id,
          rule: m.rule,
          confidence: m.confidence === null ? null : Number(m.confidence),
          manual: m.manual,
          variance: m.variance,
          at: m.created_at.toISOString(),
        })),
      queue: queue
        .filter((m) => m.sqsp_order_id === r.sqsp_order_id)
        .map((m) => ({
          id: m.id,
          reason: m.reason,
          transactionId: m.sqsp_txn_id,
          candidates: m.candidates,
          variance: m.variance,
          createdAt: m.created_at.toISOString(),
        })),
    })),
  }
}
