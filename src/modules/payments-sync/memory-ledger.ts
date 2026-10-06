import type {
  AlertSink,
  LedgerCommands,
  LedgerContextQuery,
  LedgerReader,
  PaymentFacts,
} from './ledger-ports.js'
import type { IdentityRef } from './identity.js'
import type {
  InvoiceSummary,
  LedgerEventRef,
  ManualReason,
  MatchCandidate,
  MatchContext,
  PaymentLinkRef,
  Variance,
} from './matcher.js'

export interface MemInvoice {
  id: string
  totalCents: number
  taxCents?: number
  customer: IdentityRef
  canceled?: boolean
}

export interface MemEvent extends LedgerEventRef {
  methodKind?: 'card' | 'apple_pay' | 'cash' | 'store_credit' | 'other'
  brand?: string
  deposit?: boolean
  /** Set on source=squarespace refunds that bypassed Oasis approvals. */
  needsReview?: boolean
  variance?: Variance
}

/**
 * Reference ledger for tests and the simulator end-to-end: same observable behaviour the Postgres implementation must have
 * (append-only events, only processor fields change, idempotent commands, derived invoice summaries).
 */
export class InMemoryLedger implements LedgerReader, LedgerCommands {
  readonly events: MemEvent[] = []
  readonly links: PaymentLinkRef[] = []
  readonly invoices = new Map<string, MemInvoice>()
  readonly manualQueue: {
    key: string
    orderId: string
    transactionId?: string
    reason: ManualReason
    candidates: MatchCandidate[]
    variance?: Variance
  }[] = []
  private readonly done = new Map<string, unknown>()
  private seq = 0

  addInvoice(inv: MemInvoice): void {
    this.invoices.set(inv.id, inv)
  }

  addEvent(
    e: Partial<MemEvent> & Pick<MemEvent, 'type' | 'invoiceId' | 'amountCents' | 'occurredAt'>,
  ): MemEvent {
    const inv = this.invoices.get(e.invoiceId)
    const event: MemEvent = {
      id: e.id ?? `ev-${++this.seq}`,
      customer: e.customer ?? inv?.customer ?? { emails: [], phones: [] },
      processorState: 'na',
      source: 'oasis',
      status: 'done',
      ...e,
    }
    this.events.push(event)
    return event
  }

  addLink(l: Omit<PaymentLinkRef, 'invoice' | 'customer'> & { customer?: IdentityRef }): PaymentLinkRef {
    const inv = this.invoices.get(l.invoiceId)
    if (!inv) throw new Error(`no invoice ${l.invoiceId}`)
    const link: PaymentLinkRef = { ...l, customer: l.customer ?? inv.customer, invoice: this.summary(inv) }
    this.links.push(link)
    return link
  }

  summary(inv: MemInvoice): InvoiceSummary {
    const mine = this.events.filter((e) => e.invoiceId === inv.id && e.status !== 'denied')
    const paid = mine.filter((e) => e.type === 'pay').reduce((n, e) => n + e.amountCents, 0)
    const refunded = mine
      .filter((e) => e.type === 'refund' && e.status === 'done')
      .reduce((n, e) => n + e.amountCents, 0)
    return {
      id: inv.id,
      totalCents: inv.totalCents,
      taxCents: inv.taxCents,
      balanceCents: inv.totalCents - paid + refunded,
      canceled: inv.canceled,
      payEvents: mine
        .filter((e) => e.type === 'pay')
        .map((e) => ({
          id: e.id,
          amountCents: e.amountCents,
          methodKind: e.methodKind,
          sqspOrderId: e.sqspOrderId,
          processorRef: e.processorRef,
        })),
    }
  }

  async loadContext(q: LedgerContextQuery): Promise<MatchContext> {
    const near = (e: LedgerEventRef) =>
      q.around.some((t) => Math.abs(t.getTime() - e.occurredAt.getTime()) <= q.awaitingWindowMs)
    const events = this.events
      .filter(
        (e) =>
          e.sqspOrderId === q.orderId ||
          (e.processorRef !== undefined && q.transactionIds.includes(e.processorRef)) ||
          (e.processorState === 'awaiting_processor' && near(e)),
      )
      .map((e) => ({ ...e, invoice: this.invoiceSummary(e.invoiceId) }))
    const links = this.links
      .filter((l) => l.matchedSqspOrderId === q.orderId || l.state === 'active')
      .map((l) => ({ ...l, invoice: this.invoiceSummary(l.invoiceId) ?? l.invoice }))
    const orderInvoiceId = this.events.find((e) => e.type === 'pay' && e.sqspOrderId === q.orderId)?.invoiceId
    return { events, links, orderInvoiceId }
  }

  private invoiceSummary(id: string): InvoiceSummary | undefined {
    const inv = this.invoices.get(id)
    return inv ? this.summary(inv) : undefined
  }

  private once<T>(key: string, fn: () => T): T {
    if (this.done.has(key)) return this.done.get(key) as T
    const out = fn()
    this.done.set(key, out)
    return out
  }

  private mustEvent(id: string): MemEvent {
    const e = this.events.find((x) => x.id === id)
    if (!e) throw new Error(`no event ${id}`)
    return e
  }

  async confirmAwaitingEvent(i: {
    idempotencyKey: string
    eventId: string
    sqspOrderId: string
    processorRef?: string
    variance?: Variance
  }): Promise<void> {
    this.once(i.idempotencyKey, () => {
      const e = this.mustEvent(i.eventId)
      e.processorState = 'confirmed'
      e.sqspOrderId = i.sqspOrderId
      e.processorRef = i.processorRef ?? e.processorRef
      e.variance = i.variance
    })
  }

  async attachProcessorRefs(i: {
    idempotencyKey: string
    eventId: string
    sqspOrderId?: string
    processorRef?: string
  }): Promise<void> {
    this.once(i.idempotencyKey, () => {
      const e = this.mustEvent(i.eventId)
      e.sqspOrderId = i.sqspOrderId ?? e.sqspOrderId
      e.processorRef = i.processorRef ?? e.processorRef
    })
  }

  async recordProcessorPayment(
    i: PaymentFacts & { idempotencyKey: string; invoiceId: string; paymentLinkId: string; deposit: boolean },
  ): Promise<{ eventId: string }> {
    return this.once(i.idempotencyKey, () => {
      const e = this.addEvent({
        type: 'pay',
        invoiceId: i.invoiceId,
        amountCents: i.amountCents,
        occurredAt: i.occurredAt,
        processorState: 'confirmed',
        source: 'squarespace',
        sqspOrderId: i.sqspOrderId,
        processorRef: i.processorRef,
        methodKind: 'card',
        brand: i.brand,
        deposit: i.deposit,
        variance: i.variance,
      })
      const link = this.links.find((l) => l.id === i.paymentLinkId)
      if (link) {
        link.state = 'paid'
        link.matchedSqspOrderId = i.sqspOrderId
      }
      return { eventId: e.id }
    })
  }

  async confirmRefundEvent(i: {
    idempotencyKey: string
    eventId: string
    sqspOrderId: string
    processorRef: string
  }): Promise<void> {
    this.once(i.idempotencyKey, () => {
      const e = this.mustEvent(i.eventId)
      e.processorState = 'confirmed'
      e.sqspOrderId = i.sqspOrderId
      e.processorRef = i.processorRef
    })
  }

  async recordExternalRefund(
    i: PaymentFacts & { idempotencyKey: string; invoiceId: string },
  ): Promise<{ eventId: string }> {
    return this.once(i.idempotencyKey, () => {
      const e = this.addEvent({
        type: 'refund',
        invoiceId: i.invoiceId,
        amountCents: i.amountCents,
        occurredAt: i.occurredAt,
        processorState: 'confirmed',
        source: 'squarespace',
        sqspOrderId: i.sqspOrderId,
        processorRef: i.processorRef,
        brand: i.brand,
        needsReview: true,
      })
      return { eventId: e.id }
    })
  }

  async enqueueManual(i: {
    idempotencyKey: string
    orderId: string
    transactionId?: string
    reason: ManualReason
    candidates: MatchCandidate[]
    variance?: Variance
  }): Promise<void> {
    this.once(i.idempotencyKey, () => {
      this.manualQueue.push({
        key: i.idempotencyKey,
        orderId: i.orderId,
        transactionId: i.transactionId,
        reason: i.reason,
        candidates: i.candidates,
        variance: i.variance,
      })
    })
  }
}

export class InMemoryAlertSink implements AlertSink {
  readonly alerts: Parameters<AlertSink['raise']>[0][] = []
  async raise(a: Parameters<AlertSink['raise']>[0]): Promise<void> {
    this.alerts.push(a)
  }
  codes(): string[] {
    return this.alerts.map((a) => a.code)
  }
}
