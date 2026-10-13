// InvoiceGateway: the seam the scheduling module calls (src/modules/scheduling/ports.ts declares the same interface).
// Invoices are created at booking, one per appointment, numbered INV-<n> from a gap-free per-location counter that is
// incremented in the caller's transaction (a rolled-back booking leaves no gap). Prices are snapshots; the invoice becomes
// immutable except through ledger events and the item sync below.
import { sql } from 'kysely'
import * as audit from '../../platform/audit.js'
import type { AuditActor, AuditContext } from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import * as realtime from '../../platform/realtime.js'
import { getSetting } from '../../platform/settings.js'
import { toBizDate } from '../../platform/time.js'
import { calcInvoice, type CalcEvent, type InvoiceCalc } from './calc.js'
import { invoiceLabel } from './format.js'
import { calcFromRow, touchInvoice, type InvoiceRow } from './repository.js'
import type { PriceBasis } from '../customers/schema.js'
import type { InvoiceCalcRow, InvoiceStatus, ItemKind } from './schema.js'
import { depositRowFacts, depositViewOf, type DepositView } from './deposit-view.js'
import { balanceCardsFor, processingOf, type InvoiceProcessing } from '../square/tenders.js'
import { squareEnv } from '../square/runtime.js'
import './problems.js'

export type ActorRef = AuditActor

export interface InvoiceSummary {
  invoiceId: string
  invoiceNo: number
  subtotalCents: number
  taxCents: number
  tipCents: number
  totalCents: number
  /** Payments less voided ones, plus store credit applied; refunds are not subtracted (calc.ts `paid`). */
  paidCents: number
  balanceCents: number
  depositCents: number
  status: InvoiceStatus
  refundPending: boolean
  /** Card money staff recorded that its processor has not confirmed yet (it counts toward the balance at once). */
  awaitingCents: number
  /** The rate snapshotted on the invoice, in basis points (700 = 7%). */
  taxBp: number
  items: SummaryItem[]
  payMethodLabel: string | null
  /** The size the visit is priced at ("Large SUV"; ADR 0170); null when unknown or priced before sizes. */
  vehicleClassLabel: string | null
  /** What the membership covered, one entry per covered line (the redeem events of the invoice's adjusts). */
  coverage: CoverageLine[]
  /** Refunds done (a refund its processor reported failed is not counted; one waiting for approval neither). */
  refundedCents: number
  /** Who takes card money and which Square tenders staff may offer (wave Q3 dashapi): the same for every role. */
  processing: InvoiceProcessing
  /** The visit's deposit: asked for by link, paid, kept, refunded or a refund waiting for approval; null without one. */
  deposit: DepositView | null
}

/** An invoice line as the summaries show it: the charge, and from wave Q2 the regular price, the member % off and the size. */
export interface SummaryItem {
  name: string
  priceCents: number
  kind: ItemKind
  /** The regular price at the size; null on a line priced before sizes. */
  listCents: number | null
  discountBp: number | null
  basis: PriceBasis
  /** list - price: the member % off in cents (0 without one). */
  memberDiscountCents: number
  /** The size the line is priced at, when its price is the size's own (or the starting price for a size without one). */
  classLabel: string | null
}

/** A line the membership covered: "Signature Hand Wash · covers $40 of $60, $20 size difference due". */
export interface CoverageLine {
  /** The ledger adjust that carries the coverage. */
  eventId: string
  serviceName: string
  coveredCents: number
  lineCents: number
  differenceCents: number
  planClassLabel: string | null
}

export interface EnsureInvoiceInput {
  appointmentId: string
  locationId: string
  customerId: string
  clientName: string
  vehicleLabel: string
  staffLabel: string
  occurredAt: Date
  packageName: string
  packagePriceCents: number
  packageListCents?: number | null
  packageDiscountBp?: number | null
  packageBasis?: PriceBasis
  addons: { name: string; priceCents: number; listCents?: number | null; discountBp?: number | null; basis?: PriceBasis }[]
  /** The size label the invoice header keeps ("Large SUV"; ADR 0170). */
  vehicleClassLabel?: string | null
  /** Who asked for it and the request (actor, request id, idempotency key, address), for the invoice's audit rows (SEC-15). */
  audit?: AuditContext
}

export type InvoiceItemInput = {
  name: string
  priceCents: number
  kind: ItemKind
  /** The regular price at the size, the member % off and how the price was found (ADR 0170); absent = priced before sizes. */
  listCents?: number | null
  discountBp?: number | null
  basis?: PriceBasis
}

export interface InvoiceGateway {
  /** Idempotent per appointment: creates the invoice (and its number) once, later calls refresh labels and the date. */
  ensureForAppointment(tx: Tx, a: EnsureInvoiceInput): Promise<InvoiceSummary>
  /**
   * Replaces the lines with the appointment's current package and add-ons (a repriced line is a removed line plus an added one).
   * 409 ADDON_REMOVE_OVERPAID when the change would leave the invoice overpaid. `meta.vehicleClassLabel` refreshes the size label.
   */
  syncItems(tx: Tx, appointmentId: string, items: InvoiceItemInput[], meta?: { vehicleClassLabel?: string | null }): Promise<InvoiceSummary>
  /** Cancels the invoice of a canceled or no-show appointment; null when the appointment has no invoice. */
  cancelForAppointment(
    tx: Tx,
    appointmentId: string,
    reason: 'canceled' | 'no_show',
    actor: ActorRef,
  ): Promise<InvoiceSummary | null>
  summariesFor(db: Executor, appointmentIds: string[]): Promise<Map<string, InvoiceSummary>>
}

export interface PaymentsGateway extends InvoiceGateway {
  /** Freezes biz_date at the service date (call on completion); later ensureForAppointment calls leave the date alone. */
  freezeDate(tx: Tx, appointmentId: string, serviceAt: Date): Promise<void>
}

/** The counter starts at 20611 (20610 is the highest design id) and is incremented under a row lock. */
export async function nextInvoiceNo(tx: Tx, locationId: string): Promise<number> {
  await tx
    .insertInto('invoice_counters')
    .values({ location_id: locationId })
    .onConflict((oc) => oc.doNothing())
    .execute()
  const r = await sql<{ no: number }>`
    update invoice_counters set next_no = next_no + 1 where location_id = ${locationId} returning next_no - 1 as no`.execute(
    tx,
  )
  return r.rows[0]!.no
}

interface SummaryRow extends InvoiceCalcRow {
  appointment_id: string | null
  invoice_no: number
  tax_bp: number
  vehicle_class_label: string | null
  customer_id: string
  canceled_at: Date | null
}

/** The size label of a line: the invoice's, for a line priced at the size's own price or its starting price. */
export const lineClassLabel = (basis: PriceBasis, invoiceLabel: string | null): string | null =>
  basis === 'class' || basis === 'estimated' ? invoiceLabel : null

/** The covered lines of these invoices: each membership redeem with the adjust it wrote, unless a change of the visit gave it back (ADR 0170). */
export async function coverageOf(db: Executor, invoiceIds: readonly string[]): Promise<Map<string, CoverageLine[]>> {
  const out = new Map<string, CoverageLine[]>()
  if (invoiceIds.length === 0) return out
  const r = await sql<{
    invoice_id: string
    event_id: string
    service_name: string | null
    covered_cents: number | null
    line_cents: number | null
    amount_cents: number
    plan_class_label: string | null
  }>`
    select e.invoice_id, e.id as event_id, s.name as service_name, ce.covered_cents, ce.line_cents, e.amount_cents::int as amount_cents,
      vc.label as plan_class_label
    from membership_credit_events ce
    join ledger_events e on e.id = ce.ledger_event_id
    left join services s on s.id = ce.service_id
    left join vehicle_classes vc on vc.location_id = e.location_id and vc.key = ce.plan_class
    where ce.kind = 'redeem' and e.invoice_id = any(${invoiceIds as string[]}::uuid[])
      -- a redeem given back because the visit changed (its restore carries the reversing adjust) covers nothing any more
      and not exists (select 1 from membership_credit_events x
                      where x.idempotency_key = 'restore:' || ce.id::text and x.ledger_event_id is not null)
    order by e.seq`.execute(db)
  for (const row of r.rows) {
    const covered = row.covered_cents ?? -row.amount_cents
    const line = row.line_cents ?? covered
    const list = out.get(row.invoice_id) ?? []
    list.push({
      eventId: row.event_id,
      serviceName: row.service_name ?? 'Membership credit',
      coveredCents: covered,
      lineCents: line,
      differenceCents: Math.max(0, line - covered),
      planClassLabel: row.plan_class_label,
    })
    out.set(row.invoice_id, list)
  }
  return out
}

export async function summariesByAppointment(
  db: Executor,
  appointmentIds: string[],
): Promise<Map<string, InvoiceSummary>> {
  const out = new Map<string, InvoiceSummary>()
  if (appointmentIds.length === 0) return out
  const r = await sql<SummaryRow>`
    select c.*, i.appointment_id, i.invoice_no, i.tax_bp, i.vehicle_class_label, i.customer_id, i.canceled_at
    from invoices i cross join lateral invoice_calc_of(i.id) c
    where i.appointment_id = any(${appointmentIds}::uuid[])`.execute(db)
  if (r.rows.length === 0) return out
  const ids = r.rows.map((x) => x.invoice_id)
  const items = await db
    .selectFrom('invoice_items')
    .select(['invoice_id', 'name', 'price_cents', 'kind', 'list_cents', 'discount_bp', 'price_basis'])
    .where('invoice_id', 'in', ids)
    .orderBy('position')
    .execute()
  const coverage = await coverageOf(db, ids)
  const deposits = await depositRowFacts(db, ids)
  const env = squareEnv()
  const cards = await balanceCardsFor(db, env, {
    customerIds: r.rows.filter((x) => x.canceled_at === null).map((x) => x.customer_id),
  })
  const awaiting = await sql<{ invoice_id: string; cents: number }>`
    select e.invoice_id, sum(e.amount_cents)::bigint as cents
    from ledger_events e
    where e.invoice_id = any(${ids}::uuid[]) and e.type = 'pay' and e.processor_state = 'awaiting_processor'
      and not exists (select 1 from ledger_events v where v.voids_event_id = e.id)
    group by e.invoice_id`.execute(db)
  const methods = await sql<{ invoice_id: string; method: string | null }>`
    select distinct on (e.invoice_id) e.invoice_id, e.method
    from ledger_events e
    where e.invoice_id = any(${ids}::uuid[]) and e.type in ('pay', 'credit_apply')
      and not exists (select 1 from ledger_events v where v.voids_event_id = e.id)
    order by e.invoice_id, e.occurred_at desc, e.seq desc`.execute(db)
  for (const row of r.rows) {
    const calc = calcFromRow(row)
    const flagged = deposits.depositPaidCents.get(row.invoice_id) ?? 0
    const refunds = deposits.refunds.get(row.invoice_id)
    out.set(row.appointment_id!, {
      invoiceId: row.invoice_id,
      invoiceNo: row.invoice_no,
      subtotalCents: calc.sub,
      taxCents: calc.tax,
      tipCents: calc.tip,
      totalCents: calc.total,
      paidCents: calc.paid,
      balanceCents: calc.balance,
      // a part payment (paid > 0 with a balance left) is the deposit; otherwise only payments flagged as deposits count
      depositCents: calc.balance > 0 && calc.paid > 0 ? calc.paid : flagged,
      status: calc.status,
      refundPending: calc.pendingN > 0,
      awaitingCents: Number(awaiting.rows.find((a) => a.invoice_id === row.invoice_id)?.cents ?? 0),
      taxBp: row.tax_bp,
      items: items
        .filter((i) => i.invoice_id === row.invoice_id)
        .map((i) => ({
          name: i.name,
          priceCents: i.price_cents,
          kind: i.kind,
          listCents: i.list_cents,
          discountBp: i.discount_bp,
          basis: i.price_basis,
          memberDiscountCents: i.list_cents === null ? 0 : i.list_cents - i.price_cents,
          classLabel: lineClassLabel(i.price_basis, row.vehicle_class_label),
        })),
      payMethodLabel: methods.rows.find((m) => m.invoice_id === row.invoice_id)?.method ?? null,
      vehicleClassLabel: row.vehicle_class_label,
      coverage: coverage.get(row.invoice_id) ?? [],
      refundedCents: calc.refunded,
      processing: processingOf(env, { card: cards.get(row.customer_id) ?? null, canceled: row.canceled_at !== null }),
      deposit: depositViewOf({
        canceled: row.canceled_at !== null,
        paidCents: calc.paid,
        refundedCents: calc.refunded,
        pendingRefundCents: calc.pendingAmt,
        pendingRefunds: calc.pendingN,
        depositPaidCents: Number(flagged),
        refundFailed: refunds?.failed ?? false,
        refundSending: refunds?.sending ?? false,
        link: deposits.links.get(row.invoice_id) ?? null,
      }),
    })
  }
  return out
}

/** The columns of one invoice line (a line priced before sizes keeps the 'legacy' basis and no list price). */
function itemColumns(l: InvoiceItemInput): {
  kind: ItemKind
  name: string
  price_cents: number
  list_cents: number | null
  discount_bp: number | null
  price_basis: PriceBasis
} {
  return {
    kind: l.kind,
    name: l.name,
    price_cents: l.priceCents,
    list_cents: l.listCents ?? null,
    discount_bp: l.discountBp ?? null,
    price_basis: l.basis ?? 'legacy',
  }
}

export interface GatewayDeps {
  clock: Clock
  newId: NewId
}

export function createInvoiceGateway(d: GatewayDeps): PaymentsGateway {
  const tzOf = async (tx: Executor, locationId: string): Promise<string> =>
    (await tx.selectFrom('locations').select('timezone').where('id', '=', locationId).executeTakeFirst())
      ?.timezone ?? 'America/New_York'

  const summaryOf = async (tx: Executor, appointmentId: string): Promise<InvoiceSummary> => {
    const s = (await summariesByAppointment(tx, [appointmentId])).get(appointmentId)
    if (!s) throw new AppError('NOT_FOUND', { detail: 'That appointment has no invoice' })
    return s
  }

  const byAppointment = async (tx: Tx, appointmentId: string): Promise<InvoiceRow | undefined> =>
    tx
      .selectFrom('invoices')
      .selectAll()
      .where('appointment_id', '=', appointmentId)
      .forUpdate()
      .executeTakeFirst()

  const publish = (tx: Tx, locationId: string, invoiceId: string, version: number): Promise<number> =>
    realtime.publish(tx, {
      locationId,
      channel: 'payments',
      type: 'invoice.updated',
      payload: { invoiceId, version },
    })

  return {
    async ensureForAppointment(tx, a) {
      const existing = await byAppointment(tx, a.appointmentId)
      const tz = await tzOf(tx, a.locationId)
      if (existing) {
        await tx
          .updateTable('invoices')
          .set({
            client_name: a.clientName,
            vehicle_label: a.vehicleLabel,
            staff_label: a.staffLabel,
            ...(a.vehicleClassLabel !== undefined ? { vehicle_class_label: a.vehicleClassLabel } : {}),
            ...(existing.date_frozen_at
              ? {}
              : { occurred_at: a.occurredAt, biz_date: toBizDate(a.occurredAt, tz) }),
            // a canceled or no-show appointment that is booked again (reopen) gets its invoice back, deposit and all
            ...(existing.canceled_at
              ? { canceled_at: null, canceled_by: null, canceled_by_name: null, cancel_reason: null }
              : {}),
          })
          .where('id', '=', existing.id)
          .execute()
        if (existing.canceled_at) {
          await audit.record(tx, {
            locationId: a.locationId,
            action: 'payments.invoice_reopened',
            entityType: 'invoice',
            entityId: existing.id,
            after: { appointmentId: a.appointmentId },
            ctx: a.audit,
          })
        }
        await touchInvoice(tx, existing.id, d.clock.now())
        return summaryOf(tx, a.appointmentId)
      }
      const taxBp = (await getSetting(tx, a.locationId, 'tax.rate_bp')).value
      const invoiceNo = await nextInvoiceNo(tx, a.locationId)
      const id = d.newId()
      await tx
        .insertInto('invoices')
        .values({
          id,
          location_id: a.locationId,
          invoice_no: invoiceNo,
          appointment_id: a.appointmentId,
          customer_id: a.customerId,
          client_name: a.clientName,
          vehicle_label: a.vehicleLabel,
          staff_label: a.staffLabel,
          occurred_at: a.occurredAt,
          biz_date: toBizDate(a.occurredAt, tz),
          tax_bp: taxBp,
          vehicle_class_label: a.vehicleClassLabel ?? null,
        })
        .execute()
      const lines: InvoiceItemInput[] = [
        {
          name: a.packageName,
          priceCents: a.packagePriceCents,
          kind: 'package',
          listCents: a.packageListCents,
          discountBp: a.packageDiscountBp,
          basis: a.packageBasis,
        },
        ...a.addons.map((x) => ({ ...x, kind: 'addon' as const })),
      ]
      for (const [position, l] of lines.entries()) {
        await tx
          .insertInto('invoice_items')
          .values({ id: d.newId(), invoice_id: id, position, ...itemColumns(l) })
          .execute()
      }
      await audit.record(tx, {
        locationId: a.locationId,
        action: 'payments.invoice_created',
        entityType: 'invoice',
        entityId: id,
        after: {
          invoiceNo,
          label: invoiceLabel(invoiceNo),
          appointmentId: a.appointmentId,
          lines: lines.length,
        },
        ctx: a.audit,
      })
      await publish(tx, a.locationId, id, 1)
      return summaryOf(tx, a.appointmentId)
    },

    async syncItems(tx, appointmentId, items, meta = {}) {
      const inv = await byAppointment(tx, appointmentId)
      if (!inv) throw new AppError('NOT_FOUND', { detail: 'That appointment has no invoice' })
      const current = await tx
        .selectFrom('invoice_items')
        .selectAll()
        .where('invoice_id', '=', inv.id)
        .orderBy('position')
        .execute()
      // a line is kept when everything about its price is the same (a repriced line is removed and added again)
      const key = (x: { kind: string; name: string; price: number; list: number | null; bp: number | null; basis: string }): string =>
        `${x.kind}|${x.name}|${x.price}|${x.list ?? ''}|${x.bp ?? ''}|${x.basis}`
      const pool = new Map<string, string[]>()
      for (const row of current) {
        const k = key({ kind: row.kind, name: row.name, price: row.price_cents, list: row.list_cents, bp: row.discount_bp, basis: row.price_basis })
        pool.set(k, [...(pool.get(k) ?? []), row.id])
      }
      const plan = items.map((it) => {
        const c = itemColumns(it)
        const ids = pool.get(key({ kind: c.kind, name: c.name, price: c.price_cents, list: c.list_cents, bp: c.discount_bp, basis: c.price_basis }))
        return { it, keep: ids?.shift() ?? null }
      })
      const keepIds = new Set(plan.flatMap((p) => (p.keep ? [p.keep] : [])))
      const removed = current.filter((row) => !keepIds.has(row.id))
      const added = plan.filter((p) => !p.keep)

      if (!inv.canceled_at && (removed.length > 0 || added.length > 0)) {
        const ev = await tx
          .selectFrom('ledger_events')
          .select(['type', 'amount_cents', 'status', 'dest', 'processor_state'])
          .where('invoice_id', '=', inv.id)
          .execute()
        const events: CalcEvent[] = ev.map((e) => ({
          type: e.type,
          amountCents: e.amount_cents,
          status: e.status,
          dest: e.dest,
          processorState: e.processor_state,
        }))
        const next: InvoiceCalc = calcInvoice({
          itemPrices: items.map((i) => i.priceCents),
          events,
          taxBp: inv.tax_bp,
          tipCents: inv.tip_cents,
          canceled: false,
        })
        if (removed.length > 0 && next.overpaid > 0) throw new AppError('ADDON_REMOVE_OVERPAID')
      }

      if (removed.length > 0) {
        await tx
          .deleteFrom('invoice_items')
          .where(
            'id',
            'in',
            removed.map((r) => r.id),
          )
          .execute()
      }
      for (const [position, p] of plan.entries()) {
        if (p.keep) {
          await tx.updateTable('invoice_items').set({ position }).where('id', '=', p.keep).execute()
        } else {
          await tx
            .insertInto('invoice_items')
            .values({ id: d.newId(), invoice_id: inv.id, position, ...itemColumns(p.it) })
            .execute()
        }
      }
      const relabel = meta.vehicleClassLabel !== undefined && meta.vehicleClassLabel !== inv.vehicle_class_label
      if (relabel)
        await tx.updateTable('invoices').set({ vehicle_class_label: meta.vehicleClassLabel ?? null }).where('id', '=', inv.id).execute()
      if (removed.length > 0 || added.length > 0 || relabel) {
        const version = await touchInvoice(tx, inv.id, d.clock.now())
        await audit.record(tx, {
          locationId: inv.location_id,
          action: 'payments.items_synced',
          entityType: 'invoice',
          entityId: inv.id,
          before: { items: current.map((r) => ({ name: r.name, priceCents: r.price_cents })) },
          after: { items: items.map((i) => ({ name: i.name, priceCents: i.priceCents })) },
        })
        await publish(tx, inv.location_id, inv.id, version)
      }
      return summaryOf(tx, appointmentId)
    },

    async cancelForAppointment(tx, appointmentId, reason, actor) {
      const inv = await byAppointment(tx, appointmentId)
      if (!inv) return null
      if (!inv.canceled_at) {
        const now = d.clock.now()
        await tx
          .updateTable('invoices')
          .set({
            canceled_at: now,
            canceled_by: actor.userId ?? null,
            canceled_by_name: actor.name ?? null,
            cancel_reason: reason,
          })
          .where('id', '=', inv.id)
          .execute()
        const version = await touchInvoice(tx, inv.id, now)
        await audit.record(tx, {
          locationId: inv.location_id,
          action: reason === 'no_show' ? 'payments.invoice_no_show' : 'payments.invoice_canceled',
          entityType: 'invoice',
          entityId: inv.id,
          after: { reason },
          ctx: { actor },
        })
        await publish(tx, inv.location_id, inv.id, version)
      }
      return summaryOf(tx, appointmentId)
    },

    summariesFor: (db, ids) => summariesByAppointment(db, ids),

    async freezeDate(tx, appointmentId, serviceAt) {
      const inv = await byAppointment(tx, appointmentId)
      if (!inv) return
      const tz = await tzOf(tx, inv.location_id)
      await tx
        .updateTable('invoices')
        .set({ occurred_at: serviceAt, biz_date: toBizDate(serviceAt, tz), date_frozen_at: d.clock.now() })
        .where('id', '=', inv.id)
        .execute()
      const version = await touchInvoice(tx, inv.id, d.clock.now())
      await publish(tx, inv.location_id, inv.id, version)
    },
  }
}
