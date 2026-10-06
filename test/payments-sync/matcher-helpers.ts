import {
  DEFAULT_MATCHER_CONFIG,
  type Arrival,
  type InvoiceSummary,
  type LedgerEventRef,
  type MatchContext,
  type MatcherConfig,
  type PaymentLinkRef,
} from '../../src/modules/payments-sync/matcher.js'
import type { IdentityRef } from '../../src/modules/payments-sync/identity.js'

export const T0 = new Date('2026-10-05T15:00:00.000Z')
export const H = 3600_000

export const maria: IdentityRef = {
  customerId: 'cust-maria',
  emails: ['Maria.Alvarez@example.com'],
  phones: ['(555) 712-0188'],
  sqspCustomerIds: ['64e0c0000000000000000001'],
}
export const liam: IdentityRef = {
  customerId: 'cust-liam',
  emails: ['liam.chen@example.com'],
  phones: ['555-301-4420'],
}
export const nobody: IdentityRef = { emails: [], phones: [] }

export function arrival(over: Partial<Arrival> = {}): Arrival {
  return {
    kind: 'payment',
    orderId: 'ord-1',
    orderNumber: '20530',
    transactionId: 'txn-1',
    occurredAt: T0,
    amountCents: 20223,
    currency: 'USD',
    brand: 'VISA',
    email: 'maria.alvarez@example.com',
    phone: '5557120188',
    orderTotalCents: 20223,
    orderTaxCents: 1323,
    source: 'transaction',
    ...over,
  }
}

export function invoice(over: Partial<InvoiceSummary> = {}): InvoiceSummary {
  return { id: 'inv-1', totalCents: 20223, taxCents: 1323, balanceCents: 20223, payEvents: [], ...over }
}

export function event(over: Partial<LedgerEventRef> = {}): LedgerEventRef {
  return {
    id: 'ev-1',
    type: 'pay',
    invoiceId: 'inv-1',
    customer: maria,
    amountCents: 20223,
    occurredAt: new Date(T0.getTime() - 3 * H),
    processorState: 'awaiting_processor',
    source: 'oasis',
    status: 'done',
    invoice: invoice(),
    ...over,
  }
}

export function link(over: Partial<PaymentLinkRef> = {}): PaymentLinkRef {
  return {
    id: 'link-1',
    invoiceId: 'inv-1',
    state: 'active',
    expectedCents: 20223,
    sentAt: new Date(T0.getTime() - 2 * 86400_000),
    customer: maria,
    invoice: invoice(),
    ...over,
  }
}

export function ctx(over: Partial<MatchContext> = {}): MatchContext {
  return { events: [], links: [], ...over }
}

export const cfg = (over: Partial<MatcherConfig> = {}): MatcherConfig => ({
  ...DEFAULT_MATCHER_CONFIG,
  ...over,
})
