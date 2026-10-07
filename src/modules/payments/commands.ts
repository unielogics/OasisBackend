// The Payments commands. Each runs inside the caller's transaction (the HTTP layer wraps it in the idempotency
// transaction), starts by locking the invoice row, appends ledger events, bumps the invoice version, writes the audit row
// and publishes on the `payments` SSE channel, and returns the refreshed invoice detail. Limits and permissions come from the
// actor (RBAC engine); amounts are integer cents.
import type { AuditContext } from '../../platform/audit.js'
import * as audit from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import * as realtime from '../../platform/realtime.js'
import { getSetting } from '../../platform/settings.js'
import { addDays, bizDayBounds, toBizDate } from '../../platform/time.js'
import type { PayActor } from './actor.js'
import { adjustPreview, itemsRefundValue, type AdjustInput, type InvoiceCalc } from './calc.js'
import { creditBalance, loadCreditLots, lockCustomerCredit, recordAllocations } from './credit.js'
import { buildDetail, type InvoiceDetail, type LedgerEventDto } from './detail.js'
import { limitText, money } from './format.js'
import type { PaymentsPorts } from './ports.js'
import {
  calcOf,
  cardLabel,
  firstPayMethod,
  getEventForUpdate,
  getInvoice,
  insertEvent,
  listItems,
  lockInvoice,
  refundedItemIds,
  touchInvoice,
  type EventRow,
  type InvoiceRow,
  type NewEvent,
} from './repository.js'
import type { CreditExpiry, RefundDest } from './schema.js'
import './problems.js'

export interface CommandContext {
  locationId: string
  actor: PayActor
  audit: AuditContext
  /** The request's Idempotency-Key header, namespaced per actor into the ledger event keys. */
  idempotencyKey: string | null
  /** Ledger source of the events this command writes; `system` for effects Oasis applies on a person's behalf (membership credit). */
  source?: 'oasis' | 'system'
}

export interface CommandResult {
  invoice: InvoiceDetail
}

export interface EventResult extends CommandResult {
  event: LedgerEventDto
}

export const REFUND_REASONS = [
  'Service issue',
  'Customer canceled',
  'Duplicate charge',
  'Pricing error',
  'Goodwill',
  'Add-on not performed',
] as const
export const DISCOUNT_REASONS = ['Service recovery', 'Loyalty', 'Price match', 'Manager discretion'] as const
export const SURCHARGE_REASONS = ['Extra soil surcharge', 'Pet hair surcharge', 'Oversize vehicle'] as const
export const CREDIT_REASONS = [
  'Service recovery',
  'Referral reward',
  'Weather closure',
  'Goodwill',
  'Promotion',
] as const
export const SETTLEMENT_REASON = 'Adjustment settlement'

export interface PaymentsServiceDeps {
  clock: Clock
  newId: NewId
  ports: PaymentsPorts
}

export interface RefundInput {
  mode: 'full' | 'items' | 'custom'
  itemIds?: string[]
  amountCents?: number
  dest: RefundDest
  reason?: string
  note?: string | null
}

export interface AdjustCommand extends AdjustInput {
  reason?: string
  note?: string | null
  settle?: 'credit' | 'card'
}

export interface CollectInput {
  method: 'card' | 'cash' | 'payment_link'
  /** payment_link only: the Squarespace checkout or invoice URL (else the one already attached to the invoice). */
  url?: string
}

export interface PaymentLinkInput {
  kind: 'balance' | 'deposit'
  amountCents?: number
  url?: string
}

export interface PaymentLinkResult extends CommandResult {
  paymentLink: { id: string; url: string; expectedCents: number; purpose: 'balance' | 'deposit'; sms: string }
}

export interface AdjustResult extends EventResult {
  settlement: LedgerEventDto | null
}

export interface ReceiptResult {
  sms: string
  email: string
}

const forbid = (perm: string): AppError =>
  new AppError('FORBIDDEN', { meta: { required: [perm], mode: 'all' } })

export function assertCan(actor: PayActor, perm: string): void {
  if (!actor.has(perm)) throw forbid(perm)
}

export class PaymentsService {
  constructor(private readonly d: PaymentsServiceDeps) {}

  // --- shared plumbing ----------------------------------------------------------------------------------------------

  private async tzOf(tx: Tx, locationId: string): Promise<string> {
    const loc = await tx
      .selectFrom('locations')
      .select('timezone')
      .where('id', '=', locationId)
      .executeTakeFirst()
    return loc?.timezone ?? 'America/New_York'
  }

  private ledgerKey(c: CommandContext, suffix?: string): string | null {
    if (!c.idempotencyKey) return null
    return `${c.actor.userId}:${c.idempotencyKey}${suffix ? `:${suffix}` : ''}`
  }

  private base(c: CommandContext, inv: InvoiceRow, perm: string, now: Date, suffix?: string): NewEvent {
    return {
      id: this.d.newId(),
      location_id: c.locationId,
      invoice_id: inv.id,
      customer_id: inv.customer_id,
      type: 'pay',
      amount_cents: 0,
      actor_user_id: c.actor.userId,
      actor_employee_id: c.actor.employeeId,
      actor_name: c.actor.name,
      actor_roles: c.actor.rolesFor(perm) || null,
      view_as_role_id: c.actor.viewAsRoleId,
      occurred_at: now,
      source: c.source ?? 'oasis',
      idempotency_key: this.ledgerKey(c, suffix),
    }
  }

  private async detail(tx: Tx, c: CommandContext, invoiceId: string): Promise<InvoiceDetail> {
    const inv = await getInvoice(tx, c.locationId, invoiceId)
    const tz = await this.tzOf(tx, c.locationId)
    const allowSelf = (await getSetting(tx, c.locationId, 'approvals.allow_self')).value
    return buildDetail(
      tx,
      { locationId: c.locationId, now: this.d.clock.now(), tz, actor: c.actor, rules: { allowSelf } },
      inv,
    )
  }

  /** Version bump, audit row, SSE events and the refreshed detail: the common tail of every command. */
  private async finish(
    tx: Tx,
    c: CommandContext,
    inv: InvoiceRow,
    o: {
      action: string
      before: unknown
      events: EventRow[]
      /** Extra realtime event types per ledger event id, e.g. refund.pending. */
      extra?: Array<{ type: string; eventId?: string }>
      after?: Record<string, unknown>
    },
  ): Promise<InvoiceDetail> {
    const now = this.d.clock.now()
    const version = await touchInvoice(tx, inv.id, now)
    const calc = await calcOf(tx, inv.id)
    await audit.record(tx, {
      locationId: c.locationId,
      action: o.action,
      entityType: 'invoice',
      entityId: inv.id,
      before: o.before,
      after: {
        events: o.events.map((e) => ({
          id: e.id,
          type: e.type,
          amountCents: e.amount_cents,
          status: e.status,
        })),
        status: calc.status,
        paid: calc.paid,
        refunded: calc.refunded,
        balance: calc.balance,
        ...o.after,
      },
      ctx: c.audit,
    })
    const pub = (type: string, payload: Record<string, string | number>): Promise<number> =>
      realtime.publish(tx, { locationId: c.locationId, channel: 'payments', type, payload })
    await pub('invoice.updated', { invoiceId: inv.id, version })
    for (const e of o.events) await pub('ledger.event', { invoiceId: inv.id, eventId: e.id, type: e.type })
    for (const x of o.extra ?? [])
      await pub(x.type, x.eventId ? { invoiceId: inv.id, eventId: x.eventId } : { invoiceId: inv.id })
    return this.detail(tx, c, inv.id)
  }

  private snapshot(calc: InvoiceCalc): Record<string, number | string> {
    return {
      status: calc.status,
      total: calc.total,
      paid: calc.paid,
      refunded: calc.refunded,
      balance: calc.balance,
      refundable: calc.refundable,
    }
  }

  private pick(detail: InvoiceDetail, id: string): LedgerEventDto {
    const e = detail.ledger.find((x) => x.id === id)
    if (!e) throw new Error(`event ${id} missing from the refreshed invoice`)
    return e
  }

  // --- collect, credit, links ---------------------------------------------------------------------------------------

  /**
   * Collects the full balance. Cash is a confirmed `pay`. Card is recorded as a `pay` that counts immediately and carries
   * processor_state awaiting_processor (staff take the card in Squarespace; the feed or staff confirm it later); its label
   * is the card brand only, never invented digits. A payment link creates a payment_links row and an SMS, no ledger event.
   */
  async collect(
    tx: Tx,
    c: CommandContext,
    invoiceId: string,
    input: CollectInput,
  ): Promise<EventResult | PaymentLinkResult> {
    assertCan(c.actor, 'pay.collect')
    const inv = await lockInvoice(tx, c.locationId, invoiceId)
    const calc = await calcOf(tx, inv.id)
    if (calc.balance <= 0) throw new AppError('PAY_NOTHING_TO_COLLECT')
    if (input.method === 'payment_link') {
      return this.createLink(tx, c, inv, calc, { kind: 'balance', url: input.url })
    }
    const now = this.d.clock.now()
    const e = this.base(c, inv, 'pay.collect', now)
    e.type = 'pay'
    e.amount_cents = calc.balance
    if (input.method === 'cash') {
      Object.assign(e, { method: 'Cash', method_kind: 'cash', processor_state: 'na' })
    } else {
      const hint = await this.d.ports.cardHints.hintFor(tx, inv.customer_id)
      const card = cardLabel(hint?.brand)
      Object.assign(e, {
        method: card.label,
        method_kind: 'card',
        brand: card.brand,
        processor_state: 'awaiting_processor',
      })
    }
    const row = await insertEvent(tx, e)
    const invoice = await this.finish(tx, c, inv, {
      action: 'payments.collect',
      before: this.snapshot(calc),
      events: [row],
      after: { method: input.method },
    })
    return { event: this.pick(invoice, row.id), invoice }
  }

  async applyCredit(tx: Tx, c: CommandContext, invoiceId: string): Promise<EventResult> {
    assertCan(c.actor, 'pay.collect')
    const inv = await lockInvoice(tx, c.locationId, invoiceId)
    await lockCustomerCredit(tx, inv.customer_id)
    const now = this.d.clock.now()
    const calc = await calcOf(tx, inv.id)
    const lots = await loadCreditLots(tx, inv.customer_id)
    const use = Math.min(creditBalance(lots, now), calc.balance)
    if (use <= 0) throw new AppError('PAY_NOTHING_TO_APPLY')
    const e = this.base(c, inv, 'pay.collect', now)
    Object.assign(e, {
      type: 'credit_apply',
      amount_cents: use,
      method: 'Store credit',
      method_kind: 'store_credit',
    })
    const row = await insertEvent(tx, e)
    await recordAllocations(tx, {
      applyEventId: row.id,
      customerId: inv.customer_id,
      cents: use,
      at: now,
      newId: this.d.newId,
      lots,
    })
    const invoice = await this.finish(tx, c, inv, {
      action: 'payments.credit_apply',
      before: this.snapshot(calc),
      events: [row],
    })
    return { event: this.pick(invoice, row.id), invoice }
  }

  private checkLinkUrl(url: string): void {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new AppError('PAYMENT_LINK_HOST', { params: { hosts: this.d.ports.linkHosts.join(', ') } })
    }
    const host = u.hostname.toLowerCase()
    const ok =
      u.protocol === 'https:' && this.d.ports.linkHosts.some((h) => host === h || host.endsWith(`.${h}`))
    if (!ok) throw new AppError('PAYMENT_LINK_HOST', { params: { hosts: this.d.ports.linkHosts.join(', ') } })
  }

  private async createLink(
    tx: Tx,
    c: CommandContext,
    inv: InvoiceRow,
    calc: InvoiceCalc,
    o: { kind: 'balance' | 'deposit'; amountCents?: number; url?: string },
  ): Promise<PaymentLinkResult> {
    const url = o.url ?? inv.payment_link_url
    if (!url) throw new AppError('PAYMENT_LINK_REQUIRED')
    this.checkLinkUrl(url)
    const expected = o.amountCents ?? calc.balance
    if (expected <= 0) throw new AppError('PAY_AMOUNT_INVALID')
    const now = this.d.clock.now()
    const id = this.d.newId()
    await tx
      .insertInto('payment_links')
      .values({
        id,
        location_id: c.locationId,
        invoice_id: inv.id,
        kind: 'checkout',
        purpose: o.kind,
        url,
        expected_cents: expected,
        created_by: c.actor.userId,
      })
      .execute()
    const sent = await this.d.ports.messenger.sendPaymentLink(tx, {
      invoiceId: inv.id,
      invoiceNo: inv.invoice_no,
      customerId: inv.customer_id,
      url,
      dedupeKey: `payment_link:${id}`,
    })
    await tx
      .updateTable('payment_links')
      .set({ sent_message_id: sent.messageId, sent_at: sent.state === 'queued' ? now : null })
      .where('id', '=', id)
      .execute()
    await tx
      .updateTable('invoices')
      .set({
        payment_link_url: url,
        payment_link_sent_at: sent.state === 'queued' ? now : inv.payment_link_sent_at,
      })
      .where('id', '=', inv.id)
      .execute()
    const invoice = await this.finish(tx, c, inv, {
      action: 'payments.payment_link',
      before: this.snapshot(calc),
      events: [],
      after: { paymentLinkId: id, purpose: o.kind, expectedCents: expected, sms: sent.state },
    })
    return { invoice, paymentLink: { id, url, expectedCents: expected, purpose: o.kind, sms: sent.state } }
  }

  async attachPaymentLink(
    tx: Tx,
    c: CommandContext,
    invoiceId: string,
    input: PaymentLinkInput,
  ): Promise<PaymentLinkResult> {
    assertCan(c.actor, 'pay.collect')
    const inv = await lockInvoice(tx, c.locationId, invoiceId)
    const calc = await calcOf(tx, inv.id)
    if (input.kind === 'deposit' && !input.amountCents) throw new AppError('PAY_AMOUNT_INVALID')
    if (input.kind === 'balance' && calc.balance <= 0) throw new AppError('PAY_NOTHING_TO_COLLECT')
    return this.createLink(tx, c, inv, calc, input)
  }

  // --- refunds ------------------------------------------------------------------------------------------------------

  async refund(tx: Tx, c: CommandContext, invoiceId: string, input: RefundInput): Promise<EventResult> {
    assertCan(c.actor, 'pay.refund')
    const inv = await lockInvoice(tx, c.locationId, invoiceId)
    const calc = await calcOf(tx, inv.id)
    const now = this.d.clock.now()
    let itemIds: string[] = []
    let val: number
    if (input.mode === 'full') val = calc.refundable
    else if (input.mode === 'items') {
      const wanted = [...new Set(input.itemIds ?? [])]
      const items = await listItems(tx, inv.id)
      const chosen = items.filter((i) => wanted.includes(i.id))
      if (wanted.length === 0 || chosen.length !== wanted.length) {
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Pick the items to refund',
          errors: [{ path: 'itemIds', message: 'Pick one or more items on this invoice' }],
        })
      }
      const claimed = await refundedItemIds(tx, inv.id)
      if (chosen.some((i) => claimed.has(i.id))) throw new AppError('ITEM_ALREADY_REFUNDED')
      itemIds = chosen.map((i) => i.id)
      val = itemsRefundValue(
        chosen.map((i) => i.price_cents),
        inv.tax_bp,
        calc.refundable,
      )
    } else val = input.amountCents ?? 0

    if (val <= 0) {
      throw new AppError('PAY_AMOUNT_INVALID', {
        detail: input.mode === 'full' ? 'Nothing left to refund' : undefined,
      })
    }
    // The design's order: the card cap is reported before the refundable cap.
    if (input.dest === 'card' && val > calc.toOrigMax) {
      throw new AppError('REFUND_EXCEEDS_CARD', { params: { max: money(calc.toOrigMax) } })
    }
    if (val > calc.refundable) throw new AppError('REFUND_EXCEEDS_REFUNDABLE')

    const limit = c.actor.limit('refund')
    const pending = limit !== null && val > limit
    const row = await insertEvent(
      tx,
      this.refundRow(c, inv, now, await this.refundMethod(tx, inv, input.dest), {
        amount: val,
        dest: input.dest,
        reason: input.reason ?? REFUND_REASONS[0],
        note: input.note ?? null,
        pending,
        itemIds,
      }),
    )
    const invoice = await this.finish(tx, c, inv, {
      action: pending ? 'payments.refund_requested' : 'payments.refund',
      before: this.snapshot(calc),
      events: [row],
      extra: pending ? [{ type: 'refund.pending', eventId: row.id }] : [],
      after: { dest: input.dest, mode: input.mode, pending },
    })
    return { event: this.pick(invoice, row.id), invoice }
  }

  private async refundMethod(
    tx: Tx,
    inv: InvoiceRow,
    dest: RefundDest,
  ): Promise<{ method: string; kind: NonNullable<NewEvent['method_kind']>; brand: string | null }> {
    if (dest === 'credit') return { method: 'Store credit', kind: 'store_credit', brand: null }
    if (dest === 'cash') return { method: 'Cash', kind: 'cash', brand: null }
    return firstPayMethod(tx, inv.id)
  }

  private refundRow(
    c: CommandContext,
    inv: InvoiceRow,
    now: Date,
    m: { method: string; kind: NonNullable<NewEvent['method_kind']>; brand: string | null },
    o: {
      amount: number
      dest: RefundDest
      reason: string
      note: string | null
      pending: boolean
      itemIds: string[]
      parent?: string
      suffix?: string
    },
  ): NewEvent {
    const e = this.base(c, inv, 'pay.refund', now, o.suffix)
    return {
      ...e,
      type: 'refund',
      amount_cents: o.amount,
      status: o.pending ? 'pending' : 'done',
      dest: o.dest,
      method: m.method,
      method_kind: m.kind,
      brand: m.brand,
      reason: o.reason,
      note: o.note,
      item_ids: o.itemIds,
      parent_event_id: o.parent ?? null,
      resolved_at: o.pending ? null : now,
      processor_state: !o.pending && o.dest === 'card' ? 'awaiting_processor' : 'na',
    }
  }

  async approveRefund(tx: Tx, c: CommandContext, invoiceId: string, eventId: string): Promise<EventResult> {
    assertCan(c.actor, 'pay.refund')
    const inv = await lockInvoice(tx, c.locationId, invoiceId)
    const ev = await this.pendingRefund(tx, c, inv, eventId)
    const limit = c.actor.limit('refund')
    if (limit !== null && limit < ev.amount_cents) {
      throw new AppError('CANT_APPROVE', { params: { amount: money(ev.amount_cents) } })
    }
    const allowSelf = (await getSetting(tx, c.locationId, 'approvals.allow_self')).value
    if (ev.actor_user_id === c.actor.userId && limit !== null && !allowSelf)
      throw new AppError('SELF_APPROVAL')
    const calc = await calcOf(tx, inv.id)
    // Re-validate without this request's own reservation: other refunds may have been resolved since it was requested.
    const refundableWithout = Math.max(0, calc.paid - calc.refunded - (calc.pendingAmt - ev.amount_cents))
    if (ev.dest === 'card' && ev.amount_cents > calc.toOrigMax) {
      throw new AppError('REFUND_EXCEEDS_CARD', { params: { max: money(calc.toOrigMax) } })
    }
    if (ev.amount_cents > refundableWithout) throw new AppError('REFUND_EXCEEDS_REFUNDABLE')
    const now = this.d.clock.now()
    const row = await tx
      .updateTable('ledger_events')
      .set({
        status: 'done',
        approved_by_user_id: c.actor.userId,
        approved_by_employee_id: c.actor.employeeId,
        approved_by_name: c.actor.name,
        approved_by_roles: c.actor.rolesFor('pay.refund') || null,
        approved_at: now,
        resolved_at: now,
        processor_state: ev.dest === 'card' ? 'awaiting_processor' : 'na',
      })
      .where('id', '=', ev.id)
      .returningAll()
      .executeTakeFirstOrThrow()
    const invoice = await this.finish(tx, c, inv, {
      action: 'payments.refund_approved',
      before: this.snapshot(calc),
      events: [],
      extra: [{ type: 'refund.resolved', eventId: row.id }],
      after: { eventId: row.id, amountCents: row.amount_cents, dest: row.dest },
    })
    return { event: this.pick(invoice, row.id), invoice }
  }

  async denyRefund(
    tx: Tx,
    c: CommandContext,
    invoiceId: string,
    eventId: string,
    input: { note?: string | null } = {},
  ): Promise<EventResult> {
    assertCan(c.actor, 'pay.refund')
    const inv = await lockInvoice(tx, c.locationId, invoiceId)
    const ev = await this.pendingRefund(tx, c, inv, eventId)
    const calc = await calcOf(tx, inv.id)
    const now = this.d.clock.now()
    const row = await tx
      .updateTable('ledger_events')
      .set({
        status: 'denied',
        denied_by_user_id: c.actor.userId,
        denied_by_employee_id: c.actor.employeeId,
        denied_by_name: c.actor.name,
        denied_by_roles: c.actor.rolesFor('pay.refund') || null,
        denied_at: now,
        denied_note: input.note ?? null,
        resolved_at: now,
      })
      .where('id', '=', ev.id)
      .returningAll()
      .executeTakeFirstOrThrow()
    const invoice = await this.finish(tx, c, inv, {
      action: 'payments.refund_denied',
      before: this.snapshot(calc),
      events: [],
      extra: [{ type: 'refund.resolved', eventId: row.id }],
      after: { eventId: row.id, amountCents: row.amount_cents },
    })
    return { event: this.pick(invoice, row.id), invoice }
  }

  private async pendingRefund(
    tx: Tx,
    c: CommandContext,
    inv: InvoiceRow,
    eventId: string,
  ): Promise<EventRow> {
    const ev = await getEventForUpdate(tx, c.locationId, eventId)
    if (ev.invoice_id !== inv.id || ev.type !== 'refund') {
      throw new AppError('NOT_FOUND', { detail: 'That refund request does not exist' })
    }
    if (ev.status !== 'pending') throw new AppError('REFUND_NOT_PENDING')
    return ev
  }

  // --- adjust, credit, void, tip ------------------------------------------------------------------------------------

  /**
   * Discount or surcharge, applied before tax. Over the actor's adjust limit it is blocked (no approval path, as designed).
   * When a discount leaves a paid invoice overpaid, the settlement is a NORMAL refund event: to store credit or back to
   * card, pending when it exceeds the actor's refund limit, a card refund awaits Squarespace like any other.
   */
  async adjust(tx: Tx, c: CommandContext, invoiceId: string, input: AdjustCommand): Promise<AdjustResult> {
    assertCan(c.actor, 'pay.adjust')
    const inv = await lockInvoice(tx, c.locationId, invoiceId)
    if (inv.canceled_at)
      throw new AppError('INVOICE_CANCELED', { detail: 'A canceled invoice can’t be adjusted' })
    const calc = await calcOf(tx, inv.id)
    const p = adjustPreview(calc, inv.tax_bp, input)
    if (p.pre <= 0) throw new AppError('PAY_AMOUNT_INVALID')
    const limit = c.actor.limit('adjust')
    if (limit !== null && p.pre > limit) {
      throw new AppError('OVER_LIMIT', {
        detail: `Over your ${limitText(limit)} as ${c.actor.limitRole('adjust')}. Ask Management or a Super Admin.`,
      })
    }
    if (p.newSub < 0) throw new AppError('ADJUST_EXCEEDS_INVOICE')

    const now = this.d.clock.now()
    const reasons = input.kind === 'discount' ? DISCOUNT_REASONS : SURCHARGE_REASONS
    const adjustRow = await insertEvent(tx, {
      ...this.base(c, inv, 'pay.adjust', now),
      type: 'adjust',
      amount_cents: p.signed,
      reason: input.reason ?? reasons[0],
      note: input.note ?? null,
    })

    let settlement: EventRow | null = null
    const refundableNow = calc.refundable
    const settleVal = Math.min(p.diff, refundableNow)
    if (p.diff > 0 && calc.paid > 0 && settleVal > 0) {
      const dest: RefundDest = input.settle === 'card' ? 'card' : 'credit'
      if (dest === 'card' && settleVal > calc.toOrigMax) {
        throw new AppError('REFUND_EXCEEDS_CARD', { params: { max: money(calc.toOrigMax) } })
      }
      const refundLimit = c.actor.limit('refund')
      const pending = refundLimit !== null && settleVal > refundLimit
      settlement = await insertEvent(
        tx,
        this.refundRow(c, inv, now, await this.refundMethod(tx, inv, dest), {
          amount: settleVal,
          dest,
          reason: SETTLEMENT_REASON,
          note: null,
          pending,
          itemIds: [],
          parent: adjustRow.id,
          suffix: 'settle',
        }),
      )
    }
    const invoice = await this.finish(tx, c, inv, {
      action: 'payments.adjust',
      before: this.snapshot(calc),
      events: settlement ? [adjustRow, settlement] : [adjustRow],
      extra: settlement?.status === 'pending' ? [{ type: 'refund.pending', eventId: settlement.id }] : [],
      after: { kind: input.kind, unit: input.unit, value: input.value, newTotal: p.newTotal },
    })
    return {
      event: this.pick(invoice, adjustRow.id),
      settlement: settlement ? this.pick(invoice, settlement.id) : null,
      invoice,
    }
  }

  async issueCredit(
    tx: Tx,
    c: CommandContext,
    invoiceId: string,
    input: { amountCents: number; reason?: string; note?: string | null; expiry: CreditExpiry },
  ): Promise<EventResult> {
    assertCan(c.actor, 'pay.credit')
    const inv = await lockInvoice(tx, c.locationId, invoiceId)
    if (input.amountCents <= 0) throw new AppError('PAY_AMOUNT_INVALID')
    const limit = c.actor.limit('credit')
    if (limit !== null && input.amountCents > limit) {
      throw new AppError('OVER_LIMIT', {
        params: { limit: limitText(limit), role: c.actor.limitRole('credit') },
      })
    }
    const now = this.d.clock.now()
    const tz = await this.tzOf(tx, c.locationId)
    const days = input.expiry === 'd30' ? 30 : input.expiry === 'd90' ? 90 : 0
    // The clock starts at issue: valid through the end of the business day N days from today.
    const expiresAt = days ? bizDayBounds(addDays(toBizDate(now, tz), days), tz).end : null
    const calc = await calcOf(tx, inv.id)
    const row = await insertEvent(tx, {
      ...this.base(c, inv, 'pay.credit', now),
      type: 'credit_issue',
      amount_cents: input.amountCents,
      reason: input.reason ?? CREDIT_REASONS[0],
      note: input.note ?? null,
      expiry: input.expiry,
      expires_at: expiresAt,
    })
    const invoice = await this.finish(tx, c, inv, {
      action: 'payments.credit_issue',
      before: this.snapshot(calc),
      events: [row],
      after: { expiry: input.expiry },
    })
    return { event: this.pick(invoice, row.id), invoice }
  }

  /** Reverses a cash payment or a card payment still waiting on Squarespace. Confirmed card money is refunded instead. */
  async voidPayment(
    tx: Tx,
    c: CommandContext,
    invoiceId: string,
    input: { eventId: string; note?: string | null },
  ): Promise<EventResult> {
    assertCan(c.actor, 'pay.void')
    const inv = await lockInvoice(tx, c.locationId, invoiceId)
    const pay = await getEventForUpdate(tx, c.locationId, input.eventId)
    if (pay.invoice_id !== inv.id || pay.type !== 'pay') {
      throw new AppError('NOT_FOUND', { detail: 'That payment does not exist' })
    }
    const already = await tx
      .selectFrom('ledger_events')
      .select('id')
      .where('voids_event_id', '=', pay.id)
      .executeTakeFirst()
    if (already) throw new AppError('PAYMENT_ALREADY_VOIDED')
    if (pay.method_kind !== 'cash' && pay.processor_state !== 'awaiting_processor') {
      throw new AppError('VOID_NOT_ALLOWED')
    }
    const calc = await calcOf(tx, inv.id)
    if (calc.paid - pay.amount_cents - calc.refunded - calc.pendingAmt < 0) {
      throw new AppError('VOID_NOT_ALLOWED', {
        detail: 'Refunds were issued against this payment, so it can no longer be voided',
      })
    }
    const now = this.d.clock.now()
    const row = await insertEvent(tx, {
      ...this.base(c, inv, 'pay.void', now),
      type: 'void',
      amount_cents: pay.amount_cents,
      method: pay.method,
      method_kind: pay.method_kind,
      brand: pay.brand,
      deposit: pay.deposit,
      voids_event_id: pay.id,
      reason: 'Voided',
      note: input.note ?? null,
    })
    const invoice = await this.finish(tx, c, inv, {
      action: 'payments.void',
      before: this.snapshot(calc),
      events: [row],
      after: { voidedEventId: pay.id },
    })
    return { event: this.pick(invoice, row.id), invoice }
  }

  async setTip(tx: Tx, c: CommandContext, invoiceId: string, tipCents: number): Promise<CommandResult> {
    assertCan(c.actor, 'pay.collect')
    const inv = await lockInvoice(tx, c.locationId, invoiceId)
    if (inv.canceled_at)
      throw new AppError('INVOICE_CANCELED', { detail: 'A canceled invoice can’t take a tip' })
    const calc = await calcOf(tx, inv.id)
    await tx.updateTable('invoices').set({ tip_cents: tipCents }).where('id', '=', inv.id).execute()
    const invoice = await this.finish(tx, c, inv, {
      action: 'payments.tip',
      before: { ...this.snapshot(calc), tipCents: inv.tip_cents },
      events: [],
      after: { tipCents },
    })
    return { invoice }
  }

  /** Queues the receipt by SMS and email (SMS only when the client is opted in). Not a ledger event; audited. */
  async sendReceipt(tx: Tx, c: CommandContext, invoiceId: string): Promise<ReceiptResult & CommandResult> {
    const inv = await getInvoice(tx, c.locationId, invoiceId)
    const calc = await calcOf(tx, inv.id)
    const sent = await this.d.ports.messenger.sendReceipt(tx, {
      invoiceId: inv.id,
      invoiceNo: inv.invoice_no,
      customerId: inv.customer_id,
      clientName: inv.client_name,
      totalCents: calc.total,
      paidCents: calc.paid,
      refundedCents: calc.refunded,
      dedupeKey: `receipt:${inv.id}:${c.idempotencyKey ?? this.d.newId()}`,
    })
    await audit.record(tx, {
      locationId: c.locationId,
      action: 'payments.receipt',
      entityType: 'invoice',
      entityId: inv.id,
      after: { sms: sent.sms, email: sent.email },
      ctx: c.audit,
    })
    return { ...sent, invoice: await this.detail(tx, c, inv.id) }
  }

  /** Staff confirm that the card payment or refund was completed in Squarespace. */
  async confirmProcessor(
    tx: Tx,
    c: CommandContext,
    eventId: string,
    input: { processorRef?: string | null; sqspOrderId?: string | null } = {},
  ): Promise<EventResult> {
    const probe = await getEventForUpdate(tx, c.locationId, eventId)
    assertCan(c.actor, probe.type === 'refund' ? 'pay.refund' : 'pay.collect')
    const inv = await lockInvoice(tx, c.locationId, probe.invoice_id)
    const ev = await getEventForUpdate(tx, c.locationId, eventId)
    if (ev.processor_state !== 'awaiting_processor') throw new AppError('EVENT_NOT_AWAITING')
    const now = this.d.clock.now()
    const calc = await calcOf(tx, inv.id)
    const row = await tx
      .updateTable('ledger_events')
      .set({
        processor_state: 'confirmed',
        processor_confirmed_at: now,
        processor_confirmed_by: c.actor.name,
        processor_ref: input.processorRef ?? ev.processor_ref,
        sqsp_order_id: input.sqspOrderId ?? ev.sqsp_order_id,
      })
      .where('id', '=', ev.id)
      .returningAll()
      .executeTakeFirstOrThrow()
    const invoice = await this.finish(tx, c, inv, {
      action: 'payments.confirm_processor',
      before: this.snapshot(calc),
      events: [],
      extra: [{ type: 'ledger.event', eventId: row.id }],
      after: { eventId: row.id, processorRef: row.processor_ref },
    })
    return { event: this.pick(invoice, row.id), invoice }
  }
}
