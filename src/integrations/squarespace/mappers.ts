import type { SqspContact, SqspOrder, SqspPaymentState, SqspTransaction } from '../ports/squarespace.js'
import { SquarespaceMappingError } from './errors.js'
import { decimalToCents } from './money.js'
import {
  PAYMENT_STATES,
  wireContact,
  wireOrder,
  wireTransactionDocument,
  type WireMoney,
  type WireOrder,
  type WireTransactionDocument,
} from './wire.js'

export interface MapOptions {
  /** Product ids known to be subscription products (the API does not say; see docs/integrations/squarespace.md). */
  subscriptionProductIds?: ReadonlySet<string>
}

function date(value: string, field: string): Date {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new SquarespaceMappingError(`invalid ${field}: ${value}`)
  return d
}

function cents(m: WireMoney | null | undefined): number | undefined {
  return m ? decimalToCents(m.value) : undefined
}

function clean(v: string | null | undefined): string | undefined {
  const t = v?.trim()
  return t ? t : undefined
}

function paymentState(v: string | null | undefined): SqspPaymentState | undefined {
  if (v == null) return undefined
  return (PAYMENT_STATES as readonly string[]).includes(v) ? (v as SqspPaymentState) : 'UNKNOWN'
}

const SUBSCRIPTION_TYPE = /subscription|recurring/i

export function mapOrder(input: unknown, opts: MapOptions = {}): SqspOrder {
  const parsed = wireOrder.safeParse(input)
  if (!parsed.success)
    throw new SquarespaceMappingError(`order does not match documented shape: ${parsed.error.message}`)
  return orderFromWire(parsed.data, input, opts)
}

function orderFromWire(o: WireOrder, raw: unknown, opts: MapOptions): SqspOrder {
  const name = [o.billingAddress?.firstName, o.billingAddress?.lastName]
    .map((s) => clean(s))
    .filter(Boolean)
    .join(' ')
  const shipName = [o.shippingAddress?.firstName, o.shippingAddress?.lastName]
    .map((s) => clean(s))
    .filter(Boolean)
    .join(' ')
  const lineItems = (o.lineItems ?? []).map((li) => ({
    productId: clean(li.productId),
    sku: clean(li.sku),
    name: li.productName?.trim() || '',
    unitCents: li.unitPricePaid ? decimalToCents(li.unitPricePaid.value) : 0,
    qty: li.quantity ?? 1,
    lineItemType: clean(li.lineItemType),
    variantId: clean(li.variantId),
  }))
  const isSubscription = lineItems.some(
    (li) =>
      (li.lineItemType !== undefined && SUBSCRIPTION_TYPE.test(li.lineItemType)) ||
      (li.productId !== undefined && opts.subscriptionProductIds?.has(li.productId) === true),
  )
  const fulfillment = o.fulfillmentStatus
  const tax = o.priceTaxInterpretation
  return {
    id: o.id,
    orderNumber: String(o.orderNumber),
    createdOn: date(o.createdOn, 'createdOn'),
    modifiedOn: date(o.modifiedOn, 'modifiedOn'),
    customerEmail: clean(o.customerEmail),
    customerName: name || shipName || undefined,
    customerPhone: clean(o.billingAddress?.phone) ?? clean(o.shippingAddress?.phone),
    customerId: clean(o.customerId),
    isSubscription,
    grandTotalCents: decimalToCents(o.grandTotal.value),
    refundedTotalCents: cents(o.refundedTotal) ?? 0,
    currency: o.grandTotal.currency ?? 'USD',
    testMode: o.testmode === true,
    paymentState: paymentState(o.paymentState),
    fulfillmentStatus:
      fulfillment === 'PENDING' || fulfillment === 'FULFILLED' || fulfillment === 'CANCELED'
        ? fulfillment
        : undefined,
    channel: clean(o.channel),
    subtotalCents: cents(o.subtotal),
    discountCents: cents(o.discountTotal),
    shippingCents: cents(o.shippingTotal),
    taxCents: cents(o.taxTotal),
    priceTaxInterpretation: tax === 'EXCLUSIVE' || tax === 'INCLUSIVE' ? tax : undefined,
    externalOrderReference: clean(o.externalOrderReference),
    lineItems,
    raw,
  }
}

/**
 * A transaction Document (one per order or donation) is flattened to one SqspTransaction per payment and per refund.
 * Refunds are nested under their payment in the schema, but the sample response also shows document-level
 * refunds, so both are read and de-duplicated by refund id.
 */
export function mapTransactionDocument(input: unknown): SqspTransaction[] {
  const parsed = wireTransactionDocument.safeParse(input)
  if (!parsed.success) {
    throw new SquarespaceMappingError(
      `transaction document does not match documented shape: ${parsed.error.message}`,
    )
  }
  return documentToTransactions(parsed.data, input)
}

function documentToTransactions(d: WireTransactionDocument, raw: unknown): SqspTransaction[] {
  const out: SqspTransaction[] = []
  const documentModifiedOn = date(d.modifiedOn, 'modifiedOn')
  const base = {
    orderId: clean(d.salesOrderId),
    documentId: d.id,
    documentModifiedOn,
    customerEmail: clean(d.customerEmail),
    voided: d.voided === true,
    raw,
  }
  const seenRefunds = new Set<string>()
  const payments = d.payments ?? []
  for (const p of payments) {
    out.push({
      ...base,
      id: p.id,
      kind: 'payment',
      createdOn: date(p.paidOn ?? d.createdOn, 'paidOn'),
      amountCents: decimalToCents(p.amount.value),
      currency: p.amount.currency ?? 'USD',
      brand: clean(p.creditCardType),
      provider: clean(p.provider) ?? clean(d.provider),
      externalTransactionId: clean(p.externalTransactionId),
    })
    for (const r of p.refunds ?? []) {
      seenRefunds.add(r.id)
      out.push(refundRow(base, r, d, p.id, clean(p.creditCardType), clean(p.provider)))
    }
  }
  const onlyPayment = payments.length === 1 ? payments[0] : undefined
  for (const r of d.refunds ?? []) {
    if (seenRefunds.has(r.id)) continue
    seenRefunds.add(r.id)
    out.push(
      refundRow(
        base,
        r,
        d,
        onlyPayment?.id,
        clean(onlyPayment?.creditCardType),
        clean(onlyPayment?.provider),
      ),
    )
  }
  return out
}

function refundRow(
  base: Pick<
    SqspTransaction,
    'orderId' | 'documentId' | 'documentModifiedOn' | 'customerEmail' | 'voided' | 'raw'
  >,
  r: NonNullable<WireTransactionDocument['refunds']>[number],
  d: WireTransactionDocument,
  paymentId: string | undefined,
  brand: string | undefined,
  provider: string | undefined,
): SqspTransaction {
  return {
    ...base,
    id: r.id,
    kind: 'refund',
    paymentId,
    createdOn: date(r.refundedOn ?? d.modifiedOn, 'refundedOn'),
    amountCents: decimalToCents(r.amount.value),
    currency: r.amount.currency ?? 'USD',
    brand,
    provider: provider ?? clean(d.provider),
    externalTransactionId: clean(r.externalTransactionId),
  }
}

export function mapContact(input: unknown): SqspContact {
  const parsed = wireContact.safeParse(input)
  if (!parsed.success)
    throw new SquarespaceMappingError(`contact does not match documented shape: ${parsed.error.message}`)
  const c = parsed.data
  const name = [c.firstName, c.lastName]
    .map((s) => clean(s))
    .filter(Boolean)
    .join(' ')
  return {
    id: c.id,
    email: clean(c.primaryEmail?.email),
    name: name || undefined,
    phone: clean(c.defaultShippingAddress?.address?.phoneNumber),
    createdOn: c.createdOn ? date(c.createdOn, 'createdOn') : undefined,
  }
}
