import type { Clock } from '../../platform/clock.js'
import type { AlertSink, LedgerCommands, LedgerReader } from './ledger-ports.js'
import {
  DEFAULT_MATCHER_CONFIG,
  matchArrivals,
  planOrder,
  type MatchDecision,
  type MatcherConfig,
} from './matcher.js'
import type { ProductMap } from './product-map.js'
import type { OrderRepository, TransactionRepository } from './repositories.js'
import type { StoredTransaction } from './types.js'

export interface MatchRunReport {
  ordersProcessed: number
  ignored: number
  membership: number
  awaitingPayment: number
  alreadyRecorded: number
  confirmedAwaiting: number
  paymentsRecorded: number
  refundsConfirmed: number
  externalRefunds: number
  manual: number
  deferred: number
  alerts: number
  errors: { orderId: string; message: string }[]
}

export interface MatchRunnerDeps {
  orders: OrderRepository
  transactions: TransactionRepository
  ledger: LedgerReader & LedgerCommands
  alerts: AlertSink
  clock: Clock
  productMap: ProductMap
  config?: Partial<MatcherConfig>
}

/**
 * Applies the pure matcher: finds orders and transactions not yet resolved, loads ledger context, decides, runs the
 * ledger commands and records the outcome on the synced rows. Safe to re-run: every command is keyed by Squarespace
 * ids, and a half-applied decision is recognised by the matcher as "already recorded" on the next pass.
 */
export class MatchRunner {
  private readonly cfg: MatcherConfig

  constructor(private readonly d: MatchRunnerDeps) {
    this.cfg = { ...DEFAULT_MATCHER_CONFIG, ...d.config }
  }

  async run(limit = 200): Promise<MatchRunReport> {
    const report: MatchRunReport = {
      ordersProcessed: 0,
      ignored: 0,
      membership: 0,
      awaitingPayment: 0,
      alreadyRecorded: 0,
      confirmedAwaiting: 0,
      paymentsRecorded: 0,
      refundsConfirmed: 0,
      externalRefunds: 0,
      manual: 0,
      deferred: 0,
      alerts: 0,
      errors: [],
    }
    const ids = new Set<string>()
    for (const o of await this.d.orders.listByMatchState('unmatched', limit)) ids.add(o.order.id)
    for (const t of await this.d.transactions.listByState(['new', 'deferred'], limit * 5)) {
      if (t.txn.orderId) ids.add(t.txn.orderId)
    }
    if (ids.size > 0 && this.cfg.requireMappedSkus && this.d.productMap.size === 0) {
      await this.alert(report, {
        code: 'product_map_empty',
        message: 'No Squarespace products are mapped (SQSP_PRODUCT_MAP): every order will be ignored.',
      })
    }
    for (const id of ids) {
      try {
        await this.processOrder(id, report)
        report.ordersProcessed++
      } catch (e) {
        report.errors.push({ orderId: id, message: e instanceof Error ? e.message : String(e) })
      }
    }
    return report
  }

  private async processOrder(orderId: string, report: MatchRunReport): Promise<void> {
    const stored = await this.d.orders.get(orderId)
    if (!stored) return // transactions arrived before their order: stay `new` until the order is synced
    const all = await this.d.transactions.listByOrder(orderId)
    const pending = all.filter((t) => t.state === 'new' || t.state === 'deferred')

    if (
      stored.matchState === 'ignored' &&
      stored.ignoreReason === 'payment_failed' &&
      stored.order.paymentState !== 'FAILED'
    ) {
      // the customer retried and the card went through: the order is a live payment again
      await this.d.orders.setMatch(orderId, { matchState: 'unmatched' })
      stored.matchState = 'unmatched'
      for (const t of all) {
        if (t.state === 'ignored' && t.ignoreReason === 'payment_failed') {
          await this.d.transactions.setState(t.txn.id, { state: 'new' })
          t.state = 'new'
          pending.push(t)
        }
      }
    }
    if (stored.matchState === 'ignored') {
      await this.setAll(pending, { state: 'ignored', ignoreReason: stored.ignoreReason ?? 'order_ignored' })
      return
    }
    if (stored.matchState === 'membership') {
      await this.setAll(pending, { state: 'membership' })
      return
    }

    const includeOrderLevel = stored.matchState === 'unmatched' && !all.some((t) => t.txn.kind === 'payment')
    const plan = planOrder(
      stored.order,
      pending.map((t) => t.txn),
      this.d.productMap,
      this.cfg,
      { includeOrderLevel },
    )
    switch (plan.kind) {
      case 'ignore':
        await this.d.orders.setMatch(orderId, { matchState: 'ignored', ignoreReason: plan.reason })
        await this.setAll(pending, { state: 'ignored', ignoreReason: plan.reason })
        report.ignored++
        // every product unmapped: say so once for this order (with nothing mapped at all, product_map_empty already did)
        if (plan.reason === 'unmapped_sku' && this.d.productMap.size > 0) {
          const skus = stored.order.lineItems.map((li) => li.sku || li.name || li.productId || '?')
          await this.alert(report, {
            code: 'order_ignored_unmapped',
            orderId,
            message: `Squarespace order ${stored.order.orderNumber || orderId} was ignored: none of its products (${skus.join(', ')}) is mapped to a service or a membership.`,
          })
        }
        return
      case 'membership':
        await this.d.orders.setMatch(orderId, { matchState: 'membership' })
        await this.setAll(pending, { state: 'membership' })
        report.membership++
        for (const code of plan.alerts) {
          await this.alert(report, {
            code,
            orderId,
            message: 'Membership order also contains non-membership products.',
          })
        }
        return
      case 'no_payment_yet':
        report.awaitingPayment++
        return
      case 'payments':
        break
    }

    const ctx = await this.d.ledger.loadContext({
      orderId,
      transactionIds: all.map((t) => t.txn.id),
      email: stored.order.customerEmail,
      phone: stored.order.customerPhone,
      sqspCustomerId: stored.order.customerId,
      around: plan.arrivals.map((a) => a.occurredAt),
      awaitingWindowMs: this.cfg.awaitingWindowMs,
      linkWindowMs: this.cfg.linkWindowMs,
    })
    const decisions = matchArrivals(plan, ctx, this.cfg)
    let invoiceId: string | undefined
    let paymentOutcome: 'auto' | 'manual' | undefined
    for (const d of decisions) {
      const applied = await this.apply(d, report)
      if (d.arrival.kind === 'payment' && d.kind !== 'defer') {
        paymentOutcome =
          d.kind === 'manual_queue' ? 'manual' : paymentOutcome === 'manual' ? 'manual' : 'auto'
        invoiceId ??= applied.invoiceId
      }
    }
    if (paymentOutcome) {
      await this.d.orders.setMatch(orderId, { matchState: paymentOutcome, matchedInvoiceId: invoiceId })
    }
  }

  private async apply(d: MatchDecision, report: MatchRunReport): Promise<{ invoiceId?: string }> {
    const a = d.arrival
    const key = `sqsp:${a.orderId}:${a.kind}:${a.transactionId ?? 'order'}`
    const txn = a.transactionId
    const mark = async (
      state: StoredTransaction['state'],
      matchedEventId?: string,
      ignoreReason?: string,
    ) => {
      if (txn) await this.d.transactions.setState(txn, { state, matchedEventId, ignoreReason })
    }
    let invoiceId: string | undefined

    switch (d.kind) {
      case 'already_recorded':
        if (d.attachProcessorRef || d.attachSqspOrderId) {
          await this.d.ledger.attachProcessorRefs({
            idempotencyKey: key,
            eventId: d.eventId,
            sqspOrderId: d.attachSqspOrderId ? a.orderId : undefined,
            processorRef: d.attachProcessorRef ? a.transactionId : undefined,
          })
        }
        await mark('matched', d.eventId)
        report.alreadyRecorded++
        break
      case 'confirm_awaiting':
        await this.d.ledger.confirmAwaitingEvent({
          idempotencyKey: key,
          eventId: d.eventId,
          sqspOrderId: a.orderId,
          processorRef: a.transactionId,
          variance: d.variance,
        })
        await mark('matched', d.eventId)
        invoiceId = d.invoiceId
        report.confirmedAwaiting++
        break
      case 'create_payment': {
        const { eventId } = await this.d.ledger.recordProcessorPayment({
          idempotencyKey: key,
          invoiceId: d.invoiceId,
          paymentLinkId: d.paymentLinkId,
          deposit: d.deposit,
          amountCents: a.amountCents,
          occurredAt: a.occurredAt,
          brand: a.brand,
          sqspOrderId: a.orderId,
          processorRef: a.transactionId,
          variance: d.variance,
        })
        await mark('matched', eventId)
        invoiceId = d.invoiceId
        report.paymentsRecorded++
        break
      }
      case 'confirm_refund':
        await this.d.ledger.confirmRefundEvent({
          idempotencyKey: key,
          eventId: d.eventId,
          sqspOrderId: a.orderId,
          processorRef: a.transactionId ?? key,
        })
        await mark('matched', d.eventId)
        invoiceId = d.invoiceId
        report.refundsConfirmed++
        break
      case 'record_external_refund': {
        const { eventId } = await this.d.ledger.recordExternalRefund({
          idempotencyKey: key,
          invoiceId: d.invoiceId,
          amountCents: a.amountCents,
          occurredAt: a.occurredAt,
          brand: a.brand,
          sqspOrderId: a.orderId,
          processorRef: a.transactionId,
        })
        await mark('matched', eventId)
        invoiceId = d.invoiceId
        report.externalRefunds++
        break
      }
      case 'manual_queue':
        await this.d.ledger.enqueueManual({
          idempotencyKey: key,
          orderId: a.orderId,
          transactionId: a.transactionId,
          reason: d.reason,
          candidates: d.candidates,
          arrival: a,
          variance: d.variance,
        })
        await mark('manual')
        report.manual++
        break
      case 'defer':
        await mark('deferred')
        report.deferred++
        break
    }
    for (const code of d.alerts) {
      await this.alert(report, {
        code,
        orderId: a.orderId,
        transactionId: a.transactionId,
        invoiceId,
        message: alertMessage(code, d),
        variance: d.variance,
      })
    }
    return { invoiceId }
  }

  private async setAll(
    rows: StoredTransaction[],
    patch: { state: StoredTransaction['state']; ignoreReason?: string },
  ): Promise<void> {
    for (const t of rows) await this.d.transactions.setState(t.txn.id, patch)
  }

  private async alert(report: MatchRunReport, a: Parameters<AlertSink['raise']>[0]): Promise<void> {
    await this.d.alerts.raise(a)
    report.alerts++
  }
}

function alertMessage(code: string, d: MatchDecision): string {
  const a = d.arrival
  switch (code) {
    case 'variance_exceeds_delta':
      return `Squarespace order ${a.orderNumber} total differs from the Oasis invoice by ${d.variance?.deltaCents ?? '?'} cents.`
    case 'external_refund':
      return `A refund of ${a.amountCents} cents on order ${a.orderNumber} was made in Squarespace, outside Oasis limits and approvals.`
    case 'partially_unmapped_skus':
      return `Order ${a.orderNumber} contains products that are not mapped to Oasis.`
    case 'refund_exceeds_payment':
      return `Refund on order ${a.orderNumber} exceeds the payments recorded on the invoice.`
    default:
      return code
  }
}
