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
import type { InvoiceCalcRow, InvoiceStatus, ItemKind } from './schema.js'
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
  /** Card money staff recorded that Squarespace has not confirmed yet (it counts toward the balance at once). */
  awaitingCents: number
  /** The rate snapshotted on the invoice, in basis points (700 = 7%). */
  taxBp: number
  items: { name: string; priceCents: number; kind: ItemKind }[]
  payMethodLabel: string | null
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
  addons: { name: string; priceCents: number }[]
  /** Who asked for it and the request (actor, request id, idempotency key, address), for the invoice's audit rows (SEC-15). */
  audit?: AuditContext
}

export type InvoiceItemInput = { name: string; priceCents: number; kind: ItemKind }

export interface InvoiceGateway {
  /** Idempotent per appointment: creates the invoice (and its number) once, later calls refresh labels and the date. */
  ensureForAppointment(tx: Tx, a: EnsureInvoiceInput): Promise<InvoiceSummary>
  /** Replaces the lines with the appointment's current package and add-ons. 409 ADDON_REMOVE_OVERPAID when a removal would leave the invoice overpaid. */
  syncItems(tx: Tx, appointmentId: string, items: InvoiceItemInput[]): Promise<InvoiceSummary>
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
}

export async function summariesByAppointment(
  db: Executor,
  appointmentIds: string[],
): Promise<Map<string, InvoiceSummary>> {
  const out = new Map<string, InvoiceSummary>()
  if (appointmentIds.length === 0) return out
  const r = await sql<SummaryRow>`
    select c.*, i.appointment_id, i.invoice_no, i.tax_bp
    from invoices i cross join lateral invoice_calc_of(i.id) c
    where i.appointment_id = any(${appointmentIds}::uuid[])`.execute(db)
  if (r.rows.length === 0) return out
  const ids = r.rows.map((x) => x.invoice_id)
  const items = await db
    .selectFrom('invoice_items')
    .select(['invoice_id', 'name', 'price_cents', 'kind'])
    .where('invoice_id', 'in', ids)
    .orderBy('position')
    .execute()
  const deposits = await sql<{ invoice_id: string; cents: number }>`
    select invoice_id,
           (coalesce(sum(amount_cents) filter (where type = 'pay' and deposit), 0)
            - coalesce(sum(amount_cents) filter (where type = 'void' and deposit), 0))::bigint as cents
    from ledger_events where invoice_id = any(${ids}::uuid[]) group by invoice_id`.execute(db)
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
    const flagged = deposits.rows.find((d) => d.invoice_id === row.invoice_id)?.cents ?? 0
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
        .map((i) => ({ name: i.name, priceCents: i.price_cents, kind: i.kind })),
      payMethodLabel: methods.rows.find((m) => m.invoice_id === row.invoice_id)?.method ?? null,
    })
  }
  return out
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
        })
        .execute()
      const lines: InvoiceItemInput[] = [
        { name: a.packageName, priceCents: a.packagePriceCents, kind: 'package' },
        ...a.addons.map((x) => ({ name: x.name, priceCents: x.priceCents, kind: 'addon' as const })),
      ]
      for (const [position, l] of lines.entries()) {
        await tx
          .insertInto('invoice_items')
          .values({
            id: d.newId(),
            invoice_id: id,
            position,
            kind: l.kind,
            name: l.name,
            price_cents: l.priceCents,
          })
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

    async syncItems(tx, appointmentId, items) {
      const inv = await byAppointment(tx, appointmentId)
      if (!inv) throw new AppError('NOT_FOUND', { detail: 'That appointment has no invoice' })
      const current = await tx
        .selectFrom('invoice_items')
        .selectAll()
        .where('invoice_id', '=', inv.id)
        .orderBy('position')
        .execute()
      const key = (x: { kind: string; name: string; price: number }): string =>
        `${x.kind}|${x.name}|${x.price}`
      const pool = new Map<string, string[]>()
      for (const row of current) {
        const k = key({ kind: row.kind, name: row.name, price: row.price_cents })
        pool.set(k, [...(pool.get(k) ?? []), row.id])
      }
      const plan = items.map((it) => {
        const ids = pool.get(key({ kind: it.kind, name: it.name, price: it.priceCents }))
        return { it, keep: ids?.shift() ?? null }
      })
      const keepIds = new Set(plan.flatMap((p) => (p.keep ? [p.keep] : [])))
      const removed = current.filter((row) => !keepIds.has(row.id))
      const added = plan.filter((p) => !p.keep)

      if (!inv.canceled_at && (removed.length > 0 || added.length > 0)) {
        const ev = await tx
          .selectFrom('ledger_events')
          .select(['type', 'amount_cents', 'status', 'dest'])
          .where('invoice_id', '=', inv.id)
          .execute()
        const events: CalcEvent[] = ev.map((e) => ({
          type: e.type,
          amountCents: e.amount_cents,
          status: e.status,
          dest: e.dest,
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
            .values({
              id: d.newId(),
              invoice_id: inv.id,
              position,
              kind: p.it.kind,
              name: p.it.name,
              price_cents: p.it.priceCents,
            })
            .execute()
        }
      }
      if (removed.length > 0 || added.length > 0) {
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
