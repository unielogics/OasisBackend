// The Squarespace sync over the REAL Oasis ledger (src/modules/payments): LedgerReader.loadContext reads events, links and
// invoice summaries for one order, and the LedgerCommands apply a match decision. InMemoryLedger is the reference behaviour:
//   - append-only: a new pay or refund event is inserted, a confirmation only moves the processor fields the ledger guard allows
//   - idempotent: every command claims its Squarespace-derived key in sqsp_matches (and on ledger_events.idempotency_key
//     for new events) in the same transaction, so a repeat of the same arrival is a no-op that returns the first result
//   - audited and announced: the audit log and the payments SSE channel hear about every change, exactly as a staff command would
// Commands take a transaction so the manual match endpoint can run them inside the request's idempotency transaction.
import { sql } from 'kysely'
import * as audit from '../../../platform/audit.js'
import type { AuditContext } from '../../../platform/audit.js'
import type { Clock } from '../../../platform/clock.js'
import { transaction, type Db, type Executor, type Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import type { NewId } from '../../../platform/ids.js'
import * as realtime from '../../../platform/realtime.js'
import { calcOf, cardLabel, insertEvent, lockInvoice, touchInvoice } from '../../payments/repository.js'
import type { EventRow } from '../../payments/repository.js'
import type { IdentityRef } from '../identity.js'
import type {
  LedgerCommands,
  LedgerContextQuery,
  LedgerReader,
  PaymentFacts,
} from '../ledger-ports.js'
import type {
  InvoiceSummary,
  LedgerEventRef,
  ManualReason,
  MatchCandidate,
  MatchContext,
  PaymentLinkRef,
  Variance,
  Arrival,
} from '../matcher.js'
import { toJson } from './codec.js'
import type { SqspMatchKind } from './schema.js'

export interface CommandActor {
  userId?: string | null
  employeeId?: string | null
  name: string
  roles?: string | null
  audit?: AuditContext
  manual?: boolean
}

/** Who the ledger and audit rows name when the sync itself acts. Squarespace-sourced events read "Squarespace". */
export const SQSP_ACTOR: CommandActor = { name: 'Squarespace' }

export interface LedgerOpsDeps {
  locationId: string
  clock: Clock
  newId: NewId
}

export function varianceOf(
  orderTotalCents: number,
  orderTaxCents: number | undefined,
  inv: { totalCents: number; taxCents?: number },
  alertCents: number,
): Variance {
  const delta = orderTotalCents - inv.totalCents
  return {
    sqspTotalCents: orderTotalCents,
    oasisTotalCents: inv.totalCents,
    deltaCents: delta,
    sqspTaxCents: orderTaxCents,
    oasisTaxCents: inv.taxCents,
    taxDeltaCents:
      orderTaxCents !== undefined && inv.taxCents !== undefined ? orderTaxCents - inv.taxCents : undefined,
    exceedsAlert: Math.abs(delta) > alertCents,
  }
}

export class SqspLedgerOps {
  constructor(private readonly d: LedgerOpsDeps) {}

  // ---- reads ---------------------------------------------------------------------------------------------------------

  async loadContext(db: Executor, q: LedgerContextQuery): Promise<MatchContext> {
    const loc = this.d.locationId
    const lo = new Date(Math.min(...q.around.map((t) => t.getTime())) - q.awaitingWindowMs)
    const hi = new Date(Math.max(...q.around.map((t) => t.getTime())) + q.awaitingWindowMs)
    const evRows = await sql<{
      id: string
      invoice_id: string
      customer_id: string
      type: 'pay' | 'refund'
      amount_cents: number
      occurred_at: Date
      processor_state: LedgerEventRef['processorState']
      processor_ref: string | null
      sqsp_order_id: string | null
      source: LedgerEventRef['source']
      status: 'pending' | 'done' | 'denied'
      dest: string | null
    }>`
      select e.id, e.invoice_id, e.customer_id, e.type, e.amount_cents, e.occurred_at, e.processor_state, e.processor_ref,
             e.sqsp_order_id, e.source, e.status, e.dest
      from ledger_events e
      where e.location_id = ${loc} and e.type in ('pay', 'refund') and e.status <> 'denied'
        and not exists (select 1 from ledger_events v where v.voids_event_id = e.id)
        and (e.sqsp_order_id = ${q.orderId}
          or e.processor_ref = any(${q.transactionIds}::text[])
          or ((e.processor_state = 'awaiting_processor' or (e.type = 'refund' and e.status = 'pending' and e.dest = 'card'))
              and e.occurred_at >= ${lo} and e.occurred_at <= ${hi}))
      order by e.occurred_at, e.seq`.execute(db)

    const linkRows = await sql<{
      id: string
      invoice_id: string
      customer_id: string
      state: PaymentLinkRef['state']
      expected_cents: number
      created_at: Date
      sent_at: Date | null
      expires_at: Date | null
      matched_sqsp_order_id: string | null
    }>`
      select l.id, l.invoice_id, i.customer_id, l.state, l.expected_cents, l.created_at, l.sent_at, l.expires_at,
             l.matched_sqsp_order_id
      from payment_links l join invoices i on i.id = l.invoice_id
      where l.location_id = ${loc}
        and (l.matched_sqsp_order_id = ${q.orderId}
          or (l.state = 'active'
              and coalesce(l.sent_at, l.created_at) <= ${new Date(Math.max(...q.around.map((t) => t.getTime())))}
              and coalesce(l.sent_at, l.created_at) >= ${new Date(Math.min(...q.around.map((t) => t.getTime())) - q.linkWindowMs)}))
      order by l.created_at, l.id`.execute(db)

    const customerIds = [...new Set([...evRows.rows.map((r) => r.customer_id), ...linkRows.rows.map((r) => r.customer_id)])]
    const identities = await this.identities(db, customerIds)
    const invoiceIds = [...new Set([...evRows.rows.map((r) => r.invoice_id), ...linkRows.rows.map((r) => r.invoice_id)])]
    const summaries = new Map<string, InvoiceSummary>()
    for (const id of invoiceIds) summaries.set(id, await this.invoiceSummary(db, id))

    const events: LedgerEventRef[] = evRows.rows.map((r) => ({
      id: r.id,
      type: r.type,
      invoiceId: r.invoice_id,
      customer: identities.get(r.customer_id) ?? { customerId: r.customer_id, emails: [], phones: [] },
      amountCents: r.amount_cents,
      occurredAt: r.occurred_at,
      // a card refund still waiting for an Oasis approver is shown to the matcher as waiting on the processor, so a feed
      // refund for it goes to a person (refund_pending_approval) instead of being ingested as an external refund
      processorState:
        r.type === 'refund' && r.status === 'pending' && r.dest === 'card'
          ? 'awaiting_processor'
          : r.processor_state,
      processorRef: r.processor_ref ?? undefined,
      sqspOrderId: r.sqsp_order_id ?? undefined,
      source: r.source,
      status: r.status,
      invoice: summaries.get(r.invoice_id),
    }))
    const links: PaymentLinkRef[] = linkRows.rows.map((r) => ({
      id: r.id,
      invoiceId: r.invoice_id,
      state: r.state,
      expectedCents: r.expected_cents,
      createdAt: r.created_at,
      sentAt: r.sent_at ?? undefined,
      expiresAt: r.expires_at ?? undefined,
      matchedSqspOrderId: r.matched_sqsp_order_id ?? undefined,
      customer: identities.get(r.customer_id) ?? { customerId: r.customer_id, emails: [], phones: [] },
      invoice: summaries.get(r.invoice_id)!,
    }))
    const orderInvoiceId = events.find((e) => e.type === 'pay' && e.sqspOrderId === q.orderId)?.invoiceId
    return { events, links, orderInvoiceId }
  }

  private async identities(db: Executor, customerIds: string[]): Promise<Map<string, IdentityRef>> {
    const out = new Map<string, IdentityRef>()
    if (customerIds.length === 0) return out
    const cs = await db
      .selectFrom('customers')
      .select(['id', 'email', 'phone_e164'])
      .where('id', 'in', customerIds)
      .execute()
    for (const c of cs)
      out.set(c.id, {
        customerId: c.id,
        emails: c.email ? [c.email] : [],
        phones: c.phone_e164 ? [c.phone_e164] : [],
        sqspCustomerIds: [],
      })
    const links = await db
      .selectFrom('sqsp_customer_links')
      .select(['customer_id', 'sqsp_customer_id'])
      .where('location_id', '=', this.d.locationId)
      .where('customer_id', 'in', customerIds)
      .execute()
    for (const l of links) out.get(l.customer_id)?.sqspCustomerIds?.push(l.sqsp_customer_id)
    return out
  }

  async invoiceSummary(db: Executor, invoiceId: string): Promise<InvoiceSummary> {
    const calc = await calcOf(db, invoiceId)
    const inv = await db
      .selectFrom('invoices')
      .select('canceled_at')
      .where('id', '=', invoiceId)
      .executeTakeFirstOrThrow()
    const pays = await sql<{
      id: string
      amount_cents: number
      method_kind: NonNullable<InvoiceSummary['payEvents']>[number]['methodKind'] | null
      sqsp_order_id: string | null
      processor_ref: string | null
    }>`
      select e.id, e.amount_cents, e.method_kind, e.sqsp_order_id, e.processor_ref
      from ledger_events e
      where e.invoice_id = ${invoiceId} and e.type = 'pay' and e.status = 'done'
        and not exists (select 1 from ledger_events v where v.voids_event_id = e.id)
      order by e.occurred_at, e.seq`.execute(db)
    return {
      id: invoiceId,
      totalCents: calc.total,
      taxCents: calc.tax,
      balanceCents: calc.balance,
      canceled: inv.canceled_at !== null,
      payEvents: pays.rows.map((p) => ({
        id: p.id,
        amountCents: p.amount_cents,
        methodKind: p.method_kind ?? undefined,
        sqspOrderId: p.sqsp_order_id ?? undefined,
        processorRef: p.processor_ref ?? undefined,
      })),
    }
  }

  // ---- command plumbing -----------------------------------------------------------------------------------------------

  /** Claims the idempotency key. False means this exact arrival was already handled: the caller returns the earlier result. */
  private async claim(
    tx: Tx,
    key: string,
    v: {
      kind: SqspMatchKind
      orderId?: string
      txnId?: string
      invoiceId?: string
      variance?: Variance
      actor: CommandActor
      rule?: string
      confidence?: number
    },
  ): Promise<boolean> {
    const r = await tx
      .insertInto('sqsp_matches')
      .values({
        id: this.d.newId(),
        location_id: this.d.locationId,
        idempotency_key: key,
        kind: v.kind,
        sqsp_order_id: v.orderId ?? null,
        sqsp_txn_id: v.txnId ?? null,
        invoice_id: v.invoiceId ?? null,
        rule: v.rule ?? null,
        confidence: v.confidence ?? null,
        variance: v.variance ? JSON.stringify(toJson(v.variance)) : null,
        manual: v.actor.manual ?? false,
        actor_user_id: v.actor.userId ?? null,
        created_at: this.d.clock.now(),
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .returning('id')
      .executeTakeFirst()
    return r !== undefined
  }

  private async setMatchEvent(tx: Tx, key: string, eventId: string, invoiceId: string): Promise<void> {
    await tx
      .updateTable('sqsp_matches')
      .set({ event_id: eventId, invoice_id: invoiceId })
      .where('idempotency_key', '=', key)
      .execute()
  }

  private async eventOf(tx: Tx, eventId: string): Promise<EventRow> {
    const row = await tx
      .selectFrom('ledger_events')
      .selectAll()
      .where('id', '=', eventId)
      .where('location_id', '=', this.d.locationId)
      .executeTakeFirst()
    if (!row) throw new AppError('NOT_FOUND', { detail: 'That ledger entry does not exist' })
    return row
  }

  /** The common tail: version bump, audit row and the payments SSE events the Payments screen redraws from. */
  private async announce(
    tx: Tx,
    invoiceId: string,
    o: {
      action: string
      actor: CommandActor
      events: { id: string; type: string }[]
      before?: unknown
      after?: Record<string, unknown>
    },
  ): Promise<void> {
    const now = this.d.clock.now()
    const version = await touchInvoice(tx, invoiceId, now)
    const calc = await calcOf(tx, invoiceId)
    await audit.record(tx, {
      locationId: this.d.locationId,
      action: o.action,
      entityType: 'invoice',
      entityId: invoiceId,
      before: o.before,
      after: { status: calc.status, paid: calc.paid, refunded: calc.refunded, balance: calc.balance, ...o.after },
      ctx: o.actor.audit ?? { actor: { userId: o.actor.userId, employeeId: o.actor.employeeId, name: o.actor.name, roles: o.actor.roles } },
    })
    const pub = (type: string, payload: Record<string, string | number>) =>
      realtime.publish(tx, { locationId: this.d.locationId, channel: 'payments', type, payload })
    await pub('invoice.updated', { invoiceId, version })
    for (const e of o.events) await pub('ledger.event', { invoiceId, eventId: e.id, type: e.type })
  }

  private invoiceSnapshot = async (tx: Tx, invoiceId: string) => {
    const c = await calcOf(tx, invoiceId)
    return { status: c.status, total: c.total, paid: c.paid, refunded: c.refunded, balance: c.balance }
  }

  // ---- commands -------------------------------------------------------------------------------------------------------

  async confirmAwaiting(
    tx: Tx,
    i: Parameters<LedgerCommands['confirmAwaitingEvent']>[0] & { txnId?: string },
    actor: CommandActor = SQSP_ACTOR,
  ): Promise<void> {
    const probe = await this.eventOf(tx, i.eventId)
    await lockInvoice(tx, this.d.locationId, probe.invoice_id)
    if (
      !(await this.claim(tx, i.idempotencyKey, {
        kind: 'confirm_awaiting',
        orderId: i.sqspOrderId,
        txnId: i.txnId ?? i.processorRef,
        invoiceId: probe.invoice_id,
        variance: i.variance,
        actor,
        rule: 'awaiting',
      }))
    )
      return
    const ev = await this.eventOf(tx, i.eventId)
    const before = await this.invoiceSnapshot(tx, ev.invoice_id)
    const now = this.d.clock.now()
    const set =
      ev.processor_state === 'awaiting_processor'
        ? {
            processor_state: 'confirmed' as const,
            processor_confirmed_at: now,
            processor_confirmed_by: actor.name,
            processor_ref: ev.processor_ref ?? i.processorRef ?? null,
            sqsp_order_id: ev.sqsp_order_id ?? i.sqspOrderId,
          }
        : {
            // staff confirmed it by hand in the meantime: only fill in the references that are missing
            processor_ref: ev.processor_ref ?? i.processorRef ?? null,
            sqsp_order_id: ev.sqsp_order_id ?? i.sqspOrderId,
          }
    await tx.updateTable('ledger_events').set(set).where('id', '=', ev.id).execute()
    await this.setMatchEvent(tx, i.idempotencyKey, ev.id, ev.invoice_id)
    await this.announce(tx, ev.invoice_id, {
      action: 'sqsp.confirm_awaiting',
      actor,
      events: [{ id: ev.id, type: ev.type }],
      before,
      after: { eventId: ev.id, sqspOrderId: i.sqspOrderId, processorRef: i.processorRef ?? null },
    })
  }

  async attachRefs(
    tx: Tx,
    i: Parameters<LedgerCommands['attachProcessorRefs']>[0],
    actor: CommandActor = SQSP_ACTOR,
  ): Promise<void> {
    const probe = await this.eventOf(tx, i.eventId)
    await lockInvoice(tx, this.d.locationId, probe.invoice_id)
    if (
      !(await this.claim(tx, i.idempotencyKey, {
        kind: 'attach_refs',
        orderId: i.sqspOrderId,
        txnId: i.processorRef,
        invoiceId: probe.invoice_id,
        actor,
        rule: 'recorded',
      }))
    )
      return
    const ev = await this.eventOf(tx, i.eventId)
    await tx
      .updateTable('ledger_events')
      .set({
        sqsp_order_id: ev.sqsp_order_id ?? i.sqspOrderId ?? null,
        processor_ref: ev.processor_ref ?? i.processorRef ?? null,
      })
      .where('id', '=', ev.id)
      .execute()
    await this.setMatchEvent(tx, i.idempotencyKey, ev.id, ev.invoice_id)
  }

  async recordPayment(
    tx: Tx,
    i: PaymentFacts & { idempotencyKey: string; invoiceId: string; paymentLinkId?: string | null; deposit: boolean; txnId?: string },
    actor: CommandActor = SQSP_ACTOR,
  ): Promise<{ eventId: string }> {
    const inv = await lockInvoice(tx, this.d.locationId, i.invoiceId)
    const claimed = await this.claim(tx, i.idempotencyKey, {
      kind: 'record_payment',
      orderId: i.sqspOrderId,
      txnId: i.txnId ?? i.processorRef,
      invoiceId: i.invoiceId,
      variance: i.variance,
      actor,
      rule: i.paymentLinkId ? 'link' : 'manual',
    })
    if (!claimed) return { eventId: await this.existingEvent(tx, i.idempotencyKey) }
    const before = await this.invoiceSnapshot(tx, inv.id)
    const now = this.d.clock.now()
    const card = cardLabel(i.brand)
    const row = await insertEvent(tx, {
      id: this.d.newId(),
      location_id: this.d.locationId,
      invoice_id: inv.id,
      customer_id: inv.customer_id,
      type: 'pay',
      amount_cents: i.amountCents,
      status: 'done',
      method: card.label,
      method_kind: 'card',
      brand: card.brand,
      deposit: i.deposit,
      reason: null,
      note: null,
      actor_user_id: actor.userId ?? null,
      actor_employee_id: actor.employeeId ?? null,
      actor_name: actor.manual ? actor.name : 'Squarespace',
      actor_roles: actor.roles ?? null,
      occurred_at: i.occurredAt,
      source: 'squarespace',
      processor_state: 'confirmed',
      processor_ref: i.processorRef ?? null,
      sqsp_order_id: i.sqspOrderId,
      processor_confirmed_at: now,
      processor_confirmed_by: actor.manual ? actor.name : 'Squarespace',
      idempotency_key: i.idempotencyKey,
    })
    if (i.paymentLinkId) {
      await tx
        .updateTable('payment_links')
        .set({ state: 'paid', matched_sqsp_order_id: i.sqspOrderId })
        .where('id', '=', i.paymentLinkId)
        .execute()
    }
    await this.setMatchEvent(tx, i.idempotencyKey, row.id, inv.id)
    await this.announce(tx, inv.id, {
      action: 'sqsp.record_payment',
      actor,
      events: [{ id: row.id, type: 'pay' }],
      before,
      after: {
        eventId: row.id,
        amountCents: i.amountCents,
        sqspOrderId: i.sqspOrderId,
        paymentLinkId: i.paymentLinkId ?? null,
        deposit: i.deposit,
      },
    })
    return { eventId: row.id }
  }

  async confirmRefund(
    tx: Tx,
    i: Parameters<LedgerCommands['confirmRefundEvent']>[0] & { txnId?: string },
    actor: CommandActor = SQSP_ACTOR,
  ): Promise<void> {
    const probe = await this.eventOf(tx, i.eventId)
    await lockInvoice(tx, this.d.locationId, probe.invoice_id)
    if (
      !(await this.claim(tx, i.idempotencyKey, {
        kind: 'confirm_refund',
        orderId: i.sqspOrderId,
        txnId: i.txnId ?? i.processorRef,
        invoiceId: probe.invoice_id,
        actor,
        rule: 'awaiting',
      }))
    )
      return
    const ev = await this.eventOf(tx, i.eventId)
    const before = await this.invoiceSnapshot(tx, ev.invoice_id)
    const now = this.d.clock.now()
    await tx
      .updateTable('ledger_events')
      .set(
        ev.processor_state === 'awaiting_processor'
          ? {
              processor_state: 'confirmed',
              processor_confirmed_at: now,
              processor_confirmed_by: actor.name,
              processor_ref: ev.processor_ref ?? i.processorRef,
              sqsp_order_id: ev.sqsp_order_id ?? i.sqspOrderId,
            }
          : { processor_ref: ev.processor_ref ?? i.processorRef, sqsp_order_id: ev.sqsp_order_id ?? i.sqspOrderId },
      )
      .where('id', '=', ev.id)
      .execute()
    await this.setMatchEvent(tx, i.idempotencyKey, ev.id, ev.invoice_id)
    await this.announce(tx, ev.invoice_id, {
      action: 'sqsp.confirm_refund',
      actor,
      events: [{ id: ev.id, type: 'refund' }],
      before,
      after: { eventId: ev.id, sqspOrderId: i.sqspOrderId, processorRef: i.processorRef },
    })
  }

  async recordExternalRefund(
    tx: Tx,
    i: PaymentFacts & { idempotencyKey: string; invoiceId: string; txnId?: string },
    actor: CommandActor = SQSP_ACTOR,
  ): Promise<{ eventId: string }> {
    const inv = await lockInvoice(tx, this.d.locationId, i.invoiceId)
    const claimed = await this.claim(tx, i.idempotencyKey, {
      kind: 'external_refund',
      orderId: i.sqspOrderId,
      txnId: i.txnId ?? i.processorRef,
      invoiceId: i.invoiceId,
      actor,
      rule: 'feed',
    })
    if (!claimed) return { eventId: await this.existingEvent(tx, i.idempotencyKey) }
    const before = await this.invoiceSnapshot(tx, inv.id)
    const now = this.d.clock.now()
    const card = cardLabel(i.brand)
    const row = await insertEvent(tx, {
      id: this.d.newId(),
      location_id: this.d.locationId,
      invoice_id: inv.id,
      customer_id: inv.customer_id,
      type: 'refund',
      amount_cents: i.amountCents,
      status: 'done',
      dest: 'card',
      method: card.label,
      method_kind: 'card',
      brand: card.brand,
      reason: 'Refunded in Squarespace',
      note: 'Made directly in Squarespace, outside Oasis limits and approvals. Review it.',
      actor_user_id: actor.userId ?? null,
      actor_employee_id: actor.employeeId ?? null,
      actor_name: actor.manual ? actor.name : 'Squarespace',
      actor_roles: actor.roles ?? null,
      occurred_at: i.occurredAt,
      resolved_at: i.occurredAt,
      source: 'squarespace',
      processor_state: 'confirmed',
      processor_ref: i.processorRef ?? null,
      sqsp_order_id: i.sqspOrderId,
      processor_confirmed_at: now,
      processor_confirmed_by: actor.manual ? actor.name : 'Squarespace',
      needs_review: true,
      idempotency_key: i.idempotencyKey,
    })
    await this.setMatchEvent(tx, i.idempotencyKey, row.id, inv.id)
    await this.announce(tx, inv.id, {
      action: 'sqsp.external_refund',
      actor,
      events: [{ id: row.id, type: 'refund' }],
      before,
      after: { eventId: row.id, amountCents: i.amountCents, sqspOrderId: i.sqspOrderId },
    })
    return { eventId: row.id }
  }

  async enqueueManual(
    tx: Tx,
    i: {
      idempotencyKey: string
      orderId: string
      transactionId?: string
      reason: ManualReason
      candidates: MatchCandidate[]
      arrival: Arrival
      variance?: Variance
    },
  ): Promise<void> {
    await tx
      .insertInto('sqsp_manual_queue')
      .values({
        id: this.d.newId(),
        location_id: this.d.locationId,
        idempotency_key: i.idempotencyKey,
        sqsp_order_id: i.orderId,
        sqsp_txn_id: i.transactionId ?? null,
        reason: i.reason,
        candidates: JSON.stringify(toJson(i.candidates)),
        arrival: JSON.stringify(toJson(i.arrival)),
        variance: i.variance ? JSON.stringify(toJson(i.variance)) : null,
        created_at: this.d.clock.now(),
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .execute()
  }

  private async existingEvent(tx: Tx, key: string): Promise<string> {
    const ev = await tx
      .selectFrom('ledger_events')
      .select('id')
      .where('idempotency_key', '=', key)
      .executeTakeFirst()
    if (ev) return ev.id
    const m = await tx
      .selectFrom('sqsp_matches')
      .select('event_id')
      .where('idempotency_key', '=', key)
      .executeTakeFirst()
    if (!m?.event_id) throw new Error(`idempotency key ${key} is claimed but has no ledger event`)
    return m.event_id
  }
}

/** LedgerReader + LedgerCommands for the match runner: each command runs in its own transaction. */
export class PgLedger implements LedgerReader, LedgerCommands {
  readonly ops: SqspLedgerOps
  constructor(
    private readonly db: Db,
    deps: LedgerOpsDeps,
  ) {
    this.ops = new SqspLedgerOps(deps)
  }

  loadContext(q: LedgerContextQuery): Promise<MatchContext> {
    return this.ops.loadContext(this.db, q)
  }

  confirmAwaitingEvent(i: Parameters<LedgerCommands['confirmAwaitingEvent']>[0]): Promise<void> {
    return transaction(this.db, (tx) => this.ops.confirmAwaiting(tx, i))
  }

  attachProcessorRefs(i: Parameters<LedgerCommands['attachProcessorRefs']>[0]): Promise<void> {
    return transaction(this.db, (tx) => this.ops.attachRefs(tx, i))
  }

  recordProcessorPayment(
    i: Parameters<LedgerCommands['recordProcessorPayment']>[0],
  ): Promise<{ eventId: string }> {
    return transaction(this.db, (tx) => this.ops.recordPayment(tx, i))
  }

  confirmRefundEvent(i: Parameters<LedgerCommands['confirmRefundEvent']>[0]): Promise<void> {
    return transaction(this.db, (tx) => this.ops.confirmRefund(tx, i))
  }

  recordExternalRefund(i: Parameters<LedgerCommands['recordExternalRefund']>[0]): Promise<{ eventId: string }> {
    return transaction(this.db, (tx) => this.ops.recordExternalRefund(tx, i))
  }

  enqueueManual(i: Parameters<LedgerCommands['enqueueManual']>[0]): Promise<void> {
    return transaction(this.db, (tx) => this.ops.enqueueManual(tx, i))
  }
}

