// Ports the scheduling module calls out through. Invoices belong to Payments, outbound SMS to Messaging, memberships to
// the Memberships vertical: each has a narrow interface here plus an in-memory implementation that keeps the services
// testable and every effect observable. The real implementations are wired in a later wave.
import { appError } from '../../platform/errors.js'
import type { AuditActor } from '../../platform/audit.js'
import type { Executor, Tx } from '../../platform/db.js'
import { taxCents } from '../../platform/money.js'
import type { StorageProvider } from '../../integrations/ports/storage.js'
import { renderTemplate, type TemplateVars } from '../messaging/templates/render.js'
import { QUICK_REPLIES } from '../messaging/templates/registry.js'
import type { SmsClass } from '../messaging/policy/classes.js'
import type { Actor, SchedulingCtx } from './context.js'
import type { SettlementKind, SettlementView } from './cancellation.js'
import type { AppointmentRecord } from './appointments.js'
import { ensureSchedulingProblems } from './problems.js'

export type ActorRef = AuditActor

// Invoices ------------------------------------------------------------------------------------------------------------

export type InvoiceStatus =
  | 'paid'
  | 'unpaid'
  | 'partially_paid'
  | 'partially_refunded'
  | 'refunded'
  | 'canceled'
  | 'canceled_kept'
  | 'canceled_refunded'

export interface InvoiceItem {
  name: string
  priceCents: number
  kind: 'package' | 'addon'
}

/**
 * What scheduling needs to know about an appointment's invoice. `paidCents` is the money currently held against the
 * invoice (payments minus refunds); `balanceCents` is what is still due (0 on a canceled invoice).
 */
export interface InvoiceSummary {
  invoiceId: string
  invoiceNo: number
  subtotalCents: number
  taxCents: number
  tipCents: number
  totalCents: number
  paidCents: number
  balanceCents: number
  depositCents: number
  status: InvoiceStatus
  refundPending: boolean
  items: InvoiceItem[]
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
}

/**
 * Implemented by the payments module. Every method runs inside the caller's transaction. Invoices are created at booking,
 * one per appointment, numbered INV-<n> from a gap-free per-location counter that continues after 20610.
 */
export interface InvoiceGateway {
  ensureForAppointment(tx: Tx, a: EnsureInvoiceInput): Promise<InvoiceSummary>
  /** Replaces the invoice items; 409 ADDON_REMOVE_OVERPAID when a removal would leave paid above the new total. */
  syncItems(tx: Tx, appointmentId: string, items: InvoiceItem[]): Promise<InvoiceSummary>
  cancelForAppointment(
    tx: Tx,
    appointmentId: string,
    reason: 'canceled' | 'no_show',
    actor: ActorRef,
  ): Promise<InvoiceSummary | null>
  summariesFor(db: Executor, appointmentIds: string[]): Promise<Map<string, InvoiceSummary>>
  /** Freezes the invoice's business date at the service date when the job completes (payments implements it). */
  freezeDate?(tx: Tx, appointmentId: string, serviceAt: Date): Promise<void>
}

/**
 * Cash-basis revenue (events that occurred in [from, to)), supplied by the payments module. Optional: without it the KPI
 * falls back to the money held on today's appointments' invoices.
 */
export interface RevenueSource {
  revenueCents(db: Executor, locationId: string, from: Date, to: Date): Promise<number>
}

// Deposit settlement ----------------------------------------------------------------------------------------------

/** How the money held on an invoice is settled when its appointment is canceled or marked no-show (ADR 0082). */
export type SettlementMode = 'policy' | 'keep' | 'refund_card' | 'refund_credit'

export interface SettleRequest {
  appointmentId: string
  locationId: string
  kind: SettlementKind
  mode: SettlementMode
  /** mode policy: the kept share, in basis points, and where a refund goes. */
  retainBp: number
  refundTo: 'original' | 'credit'
  /** The sentence that explains the decision; stored as the refund's note. */
  rule: string
  actor: Actor
  /** One stable key per cancel / no-show, so the ledger events it writes are written once. */
  idempotencyKey: string
}

/**
 * Executes the settlement through the payments command layer, in the caller's transaction. `policy` refunds are system
 * events (limit-exempt, no pay.refund needed); `refund_card` / `refund_credit` are the actor's own refund (their right and limit,
 * so a large one waits for approval). `keep` writes nothing. Returns null when the appointment has no invoice.
 */
export interface DepositSettlement {
  settle(tx: Tx, req: SettleRequest): Promise<SettlementView | null>
  /**
   * A canceled or no-show job comes back to booked: its invoice is revived (a kept deposit counts again). Refused with 409
   * REOPEN_REFUNDED when a refund was issued, because a refund does not reopen the balance and the job would be undercharged.
   */
  reopen(tx: Tx, req: { appointmentId: string; locationId: string }): Promise<void>
}

/** The waitlist (standing module): told when a canceled job freed a slot so it can be offered. Optional; off unless the feature is on. */
export interface WaitlistPort {
  slotFreed(tx: Tx, c: SchedulingCtx, appointment: AppointmentRecord): Promise<void>
}

export const TAX_RATE_BP = 700
export const FIRST_INVOICE_NO = 20611

interface MemInvoice {
  invoiceId: string
  invoiceNo: number
  appointmentId: string
  locationId: string
  items: InvoiceItem[]
  tipCents: number
  paidCents: number
  refundedCents: number
  depositCents: number
  canceled: boolean
  canceledReason: 'canceled' | 'no_show' | null
  refundPending: boolean
  payMethodLabel: string | null
  occurredAt: Date
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0)

/** In-memory InvoiceGateway for tests and local wiring: 7% tax half-up, gap-free numbering from 20611. */
export class InMemoryInvoiceGateway implements InvoiceGateway {
  private readonly byAppointment = new Map<string, MemInvoice>()
  private readonly counters = new Map<string, number>()
  readonly calls: { method: string; appointmentId: string }[] = []
  readonly taxBp: number

  constructor(o: { taxBp?: number } = {}) {
    this.taxBp = o.taxBp ?? TAX_RATE_BP
  }

  private nextNo(locationId: string): number {
    const n = this.counters.get(locationId) ?? FIRST_INVOICE_NO
    this.counters.set(locationId, n + 1)
    return n
  }

  private summarize(inv: MemInvoice): InvoiceSummary {
    const subtotal = sum(inv.items.map((i) => i.priceCents))
    const tax = taxCents(subtotal, this.taxBp)
    const total = subtotal + tax + inv.tipCents
    const held = inv.paidCents - inv.refundedCents
    let status: InvoiceStatus
    if (inv.canceled) {
      status = inv.refundedCents > 0 ? 'canceled_refunded' : inv.paidCents > 0 ? 'canceled_kept' : 'canceled'
    } else if (inv.refundedCents > 0) {
      status = held <= 0 ? 'refunded' : 'partially_refunded'
    } else if (inv.paidCents >= total && total > 0) status = 'paid'
    else if (inv.paidCents > 0) status = 'partially_paid'
    else status = 'unpaid'
    return {
      invoiceId: inv.invoiceId,
      invoiceNo: inv.invoiceNo,
      subtotalCents: subtotal,
      taxCents: tax,
      tipCents: inv.tipCents,
      totalCents: total,
      paidCents: held,
      balanceCents: inv.canceled ? 0 : Math.max(0, total - held),
      depositCents: inv.depositCents,
      status,
      refundPending: inv.refundPending,
      items: inv.items.map((i) => ({ ...i })),
      payMethodLabel: inv.payMethodLabel,
    }
  }

  async ensureForAppointment(_tx: Tx, a: EnsureInvoiceInput): Promise<InvoiceSummary> {
    this.calls.push({ method: 'ensureForAppointment', appointmentId: a.appointmentId })
    const existing = this.byAppointment.get(a.appointmentId)
    if (existing) {
      existing.occurredAt = a.occurredAt
      if (existing.canceled) {
        existing.canceled = false
        existing.canceledReason = null
      }
      return this.summarize(existing)
    }
    const inv: MemInvoice = {
      invoiceId: `inv-${a.appointmentId}`,
      invoiceNo: this.nextNo(a.locationId),
      appointmentId: a.appointmentId,
      locationId: a.locationId,
      items: [
        { name: a.packageName, priceCents: a.packagePriceCents, kind: 'package' },
        ...a.addons.map((x) => ({ name: x.name, priceCents: x.priceCents, kind: 'addon' as const })),
      ],
      tipCents: 0,
      paidCents: 0,
      refundedCents: 0,
      depositCents: 0,
      canceled: false,
      canceledReason: null,
      refundPending: false,
      payMethodLabel: null,
      occurredAt: a.occurredAt,
    }
    this.byAppointment.set(a.appointmentId, inv)
    return this.summarize(inv)
  }

  async syncItems(_tx: Tx, appointmentId: string, items: InvoiceItem[]): Promise<InvoiceSummary> {
    this.calls.push({ method: 'syncItems', appointmentId })
    const inv = this.byAppointment.get(appointmentId)
    if (!inv) throw appError('NOT_FOUND', { detail: 'That invoice does not exist' })
    const next = { ...inv, items: items.map((i) => ({ ...i })) }
    const after = this.summarize(next)
    if (inv.paidCents - inv.refundedCents > after.totalCents) {
      ensureSchedulingProblems()
      throw appError('ADDON_REMOVE_OVERPAID')
    }
    inv.items = next.items
    return this.summarize(inv)
  }

  async cancelForAppointment(
    _tx: Tx,
    appointmentId: string,
    reason: 'canceled' | 'no_show',
    _actor: ActorRef,
  ): Promise<InvoiceSummary | null> {
    this.calls.push({ method: 'cancelForAppointment', appointmentId })
    const inv = this.byAppointment.get(appointmentId)
    if (!inv) return null
    inv.canceled = true
    inv.canceledReason = reason
    return this.summarize(inv)
  }

  async summariesFor(_db: Executor, appointmentIds: string[]): Promise<Map<string, InvoiceSummary>> {
    const out = new Map<string, InvoiceSummary>()
    for (const id of appointmentIds) {
      const inv = this.byAppointment.get(id)
      if (inv) out.set(id, this.summarize(inv))
    }
    return out
  }

  // Test helpers ---------------------------------------------------------------------------------------------------

  /** Records money collected against the invoice (a deposit when `deposit` is true). */
  recordPayment(appointmentId: string, cents: number, o: { deposit?: boolean; method?: string } = {}): void {
    const inv = this.require(appointmentId)
    inv.paidCents += cents
    if (o.deposit) inv.depositCents += cents
    if (o.method) inv.payMethodLabel = o.method
  }

  /** Pays the full current total (tip included). */
  payInFull(appointmentId: string, method = 'Visa ••4421'): void {
    const s = this.summaryOf(appointmentId)
    this.recordPayment(appointmentId, s.balanceCents, { method })
  }

  recordRefund(appointmentId: string, cents: number): void {
    this.require(appointmentId).refundedCents += cents
  }

  setTip(appointmentId: string, cents: number): void {
    this.require(appointmentId).tipCents = cents
  }

  summaryOf(appointmentId: string): InvoiceSummary {
    return this.summarize(this.require(appointmentId))
  }

  occurredAtOf(appointmentId: string): Date {
    return this.require(appointmentId).occurredAt
  }

  /** Forgets every invoice and restarts the numbering (tests reuse one gateway across cases). */
  reset(): void {
    this.byAppointment.clear()
    this.counters.clear()
    this.calls.length = 0
  }

  has(appointmentId: string): boolean {
    return this.byAppointment.has(appointmentId)
  }

  private require(appointmentId: string): MemInvoice {
    const inv = this.byAppointment.get(appointmentId)
    if (!inv) throw new Error(`No invoice for appointment ${appointmentId}`)
    return inv
  }
}

// Outbound messages ---------------------------------------------------------------------------------------------------

export interface OutboundMessage {
  customerId: string
  appointmentId: string | null
  /** A key of the messaging template registry (src/modules/messaging/templates). */
  templateKey?: string
  /** Free text, for the few notices that have no template (cancellation). */
  text?: string
  /** The SMS class of free text; defaults to staff_message. */
  klass?: SmsClass
  vars?: TemplateVars
  /** Why the message exists, for the activity log and the outbox ("confirm", "arrive", ...). */
  purpose: string
  /** A second enqueue with the same key returns the first message instead of queuing another. */
  dedupeKey?: string
}

export interface QueuedResult {
  queued: boolean
  messageId: string | null
  /** Why nothing was queued (opt-out, no number, ...). */
  skipped?: string
}

/** Queues a message in the caller's transaction; nothing is sent inline. The real outbox arrives with Messaging. */
export interface MessageQueue {
  enqueue(tx: Tx, msg: OutboundMessage): Promise<QueuedResult>
}

export interface RecordedMessage extends OutboundMessage {
  id: string
  /** The rendered body. */
  body: string
}

export class InMemoryMessageQueue implements MessageQueue {
  readonly messages: RecordedMessage[] = []
  /** Return a skip reason to simulate the SMS policy refusing a recipient. */
  skipWhen: ((msg: OutboundMessage) => string | null) | null = null
  private n = 0

  async enqueue(_tx: Tx, msg: OutboundMessage): Promise<QueuedResult> {
    const skipped = this.skipWhen?.(msg) ?? null
    if (skipped) return { queued: false, messageId: null, skipped }
    const body = msg.templateKey
      ? renderTemplate(msg.templateKey, msg.vars ?? {}).text
      : (msg.text ?? QUICK_REPLIES[0]!.text)
    const id = `mem-msg-${++this.n}`
    this.messages.push({ ...msg, id, body })
    return { queued: true, messageId: id }
  }

  clear(): void {
    this.messages.length = 0
  }

  keys(): (string | undefined)[] {
    return this.messages.map((m) => m.templateKey)
  }
}

// Memberships and extra alert sources ------------------------------------------------------------------------------

export interface MembershipInfo {
  /** The label shown on the card and in the file ("Premium Care"). */
  plan: string
  /** Credits left this cycle; null = unlimited. */
  creditsLeft: number | null
  /** An unused eligible credit exists for this appointment. */
  creditAvailable: boolean
  /** Additive display data from the Memberships vertical for the Membership tab; the in-memory port leaves them out. */
  planKey?: 'essential' | 'premium' | 'executive' | 'exotic'
  /** Renewal instant (ISO) and its label in the business timezone ("Jul 12, 2026"). */
  renewsAt?: string | null
  renewLabel?: string | null
  creditsUsed?: number
  perks?: string[]
  color?: string
  bgColor?: string
  tint?: string
  memberMonths?: number
  retention?: { label: string; desc: string; tone: 'green' | 'red' }
}

export interface MembershipRef {
  appointmentId: string
  customerId: string
  membershipId: string | null
}

/** What completing a visit did about the member's credit: nothing is thrown, a skip only says why. */
export type AutoCreditOutcome =
  | { applied: true; ruleLabel: string; creditsLeft: number | null; discountCents: number }
  | { applied: false; skipped: string }

/** A credit handed back because the shop's closure cost the member the visit that held it. */
export interface ReleasedCredit {
  ruleLabel: string
}

/** Whether a client who is not a member is worth an upgrade offer, from their real completed visits. */
export interface UpgradeCandidacy {
  candidate: boolean
  /** Completed visits in the last 60 days. */
  visits60: number
  /** "Maria Delgado is a strong upgrade candidate — 4 visits in 60 days. Offer Essential at check-out."; null when not a candidate. */
  copy: string | null
}

/** Implemented by the Memberships vertical. Returns an entry only for appointments whose client is an active member. */
export interface MembershipPort {
  forAppointments(db: Executor, refs: MembershipRef[]): Promise<Map<string, MembershipInfo>>
  /**
   * Called when a visit is completed, in the completing transaction: redeems the member's credit when the rule (or the member)
   * is set to apply itself. Never throws for a business reason; a failure inside it leaves the completion intact.
   */
  autoApplyCredit?(tx: Tx, c: SchedulingCtx, actor: Actor, appointmentId: string): Promise<AutoCreditOutcome>
  /**
   * Called when a job is canceled or marked no-show: gives back the credit it held if an emergency closure (with "protect
   * credits" on) is why the visit did not happen. null when nothing was held or the closure was not the cause.
   */
  releaseCredit?(tx: Tx, c: SchedulingCtx, appointmentId: string): Promise<ReleasedCredit | null>
  /** For appointments of clients without a live membership: the upgrade candidacy (appointment file, Membership tab). */
  upgradeCandidates?(
    db: Executor,
    c: { locationId: string; now: Date },
    refs: MembershipRef[],
  ): Promise<Map<string, UpgradeCandidacy>>
}

export const noMemberships: MembershipPort = { forAppointments: async () => new Map() }

export class InMemoryMemberships implements MembershipPort {
  /** customer id -> membership */
  readonly byCustomer = new Map<string, MembershipInfo>()
  async forAppointments(_db: Executor, refs: MembershipRef[]): Promise<Map<string, MembershipInfo>> {
    const out = new Map<string, MembershipInfo>()
    for (const r of refs) {
      const m = this.byCustomer.get(r.customerId)
      if (m) out.set(r.appointmentId, m)
    }
    return out
  }
}

export type AlertTone = 'red' | 'amber' | 'blue' | 'green' | 'violet'

export interface ExternalAlert {
  key: string
  kind: 'new_reply' | 'sms_device_down' | 'awaiting_processor' | 'unmatched_order'
  tone: AlertTone
  title: string
  desc: string
  actionLabel: string
  appointmentId: string | null
  priority: number
}

/** Alerts 10-12 (new reply, SMS device down, card awaiting Squarespace) come from the messaging and payments modules. */
export interface ExternalAlertSource {
  list(db: Executor, ctx: { locationId: string; now: Date; manager: boolean }): Promise<ExternalAlert[]>
}

export const noExternalAlerts: ExternalAlertSource = { list: async () => [] }

export interface SchedulingPorts {
  invoices: InvoiceGateway
  messages: MessageQueue
  memberships: MembershipPort
  externalAlerts: ExternalAlertSource
  revenue?: RevenueSource
  storage: StorageProvider
  /** Without it a cancel or no-show only records the policy (the in-memory default); production wires the ledger. */
  deposits?: DepositSettlement
  waitlist?: WaitlistPort
}
