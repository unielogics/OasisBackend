import type { Clock } from '../../../platform/clock.js'
import { centsToDecimal, decimalToCents } from '../money.js'
import type { WireContact, WireOrder, WireTransactionDocument } from '../wire.js'

/**
 * In-memory Squarespace: holds wire-shaped orders, transaction Documents and contacts exactly as the documented API
 * returns them, plus the query/pagination semantics (modifiedAfter+modifiedBefore together, cursor alone,
 * dynamic keyset cursors, paymentStates default). Shared by the in-process fake and the HTTP simulator.
 */
export interface SimOrderInput {
  email?: string
  /** "First Last"; written to billingAddress. */
  name?: string
  phone?: string
  lineItems: {
    productId?: string
    sku?: string
    name: string
    unitCents: number
    qty?: number
    lineItemType?: string
  }[]
  taxCents?: number
  shippingCents?: number
  discountCents?: number
  createdOn?: Date
  testMode?: boolean
  channel?: 'web' | 'pos'
  /** false: leave the order NOT_CHARGED with no payment. Otherwise a payment is recorded (default: full amount, VISA). */
  pay?:
    | false
    | { amountCents?: number; brand?: string | null; paidOn?: Date; provider?: string; giftCardId?: string }
}

export interface SimRefundInput {
  amountCents?: number
  paymentId?: string
  refundedOn?: Date
  /** Written at document level only, mirroring the sample response (the schema nests refunds under payments). */
  documentLevel?: boolean
}

export type SimEvent = { topic: 'order.create' | 'order.update'; orderId: string; update?: string }

export interface PageResult<T> {
  rows: T[]
  nextCursor?: string
}

export class SimBadRequest extends Error {
  constructor(
    message: string,
    readonly subtype = 'INVALID_ARGUMENT',
  ) {
    super(message)
  }
}

export class SimNotFound extends Error {}

const DEFAULT_PAYMENT_STATES = ['NOT_CHARGED', 'AUTHORIZED', 'PAID', 'REFUNDED']

type Money = { currency: string; value: number }

export class SquarespaceSimStore {
  private orders = new Map<string, WireOrder>()
  private documents = new Map<string, WireTransactionDocument>() // keyed by order id ('donation:*' for none)
  private contacts = new Map<string, WireContact>()
  private seq = 0
  private orderNo = 1000
  readonly events: SimEvent[] = []
  private listeners: ((e: SimEvent) => void)[] = []

  constructor(
    private readonly clock: Clock,
    readonly options: { pageSize: number; order: 'asc' | 'desc'; currency: string } = {
      pageSize: 50,
      order: 'asc',
      currency: 'USD',
    },
  ) {}

  onEvent(fn: (e: SimEvent) => void): void {
    this.listeners.push(fn)
  }

  reset(): void {
    this.orders.clear()
    this.documents.clear()
    this.contacts.clear()
    this.events.length = 0
    this.seq = 0
    this.orderNo = 1000
  }

  counts() {
    return { orders: this.orders.size, documents: this.documents.size, contacts: this.contacts.size }
  }

  // ---- mutation helpers (the control surface) ----

  createOrder(input: SimOrderInput): { orderId: string; paymentId?: string } {
    const now = this.clock.now()
    const createdOn = input.createdOn ?? now
    const cur = this.options.currency
    const contact = input.email
      ? this.ensureContact(input.email, input.name, input.phone, createdOn)
      : undefined
    const [firstName, ...rest] = (input.name ?? '').trim().split(/\s+/).filter(Boolean)
    const lineItems = input.lineItems.map((li) => ({
      id: this.hex24(),
      productId: li.productId ?? null,
      productName: li.name,
      sku: li.sku ?? null,
      variantId: this.uuid(),
      quantity: li.qty ?? 1,
      unitPricePaid: money(li.unitCents, cur),
      lineItemType: li.lineItemType ?? 'SERVICE',
    }))
    const subtotal = input.lineItems.reduce((a, li) => a + li.unitCents * (li.qty ?? 1), 0)
    const tax = input.taxCents ?? 0
    const shipping = input.shippingCents ?? 0
    const discount = input.discountCents ?? 0
    const id = this.hex24()
    const order: WireOrder = {
      id,
      orderNumber: String(++this.orderNo),
      createdOn: createdOn.toISOString(),
      modifiedOn: createdOn.toISOString(),
      channel: input.channel ?? 'web',
      testmode: input.testMode === true,
      customerEmail: input.email ?? null,
      customerId: contact?.id ?? null,
      paymentState: 'NOT_CHARGED',
      fulfillmentStatus: 'PENDING',
      billingAddress: {
        firstName: firstName ?? null,
        lastName: rest.join(' ') || null,
        phone: input.phone ?? null,
      },
      lineItems,
      subtotal: money(subtotal, cur),
      shippingTotal: money(shipping, cur),
      discountTotal: money(discount, cur),
      taxTotal: money(tax, cur),
      refundedTotal: money(0, cur),
      grandTotal: money(subtotal + tax + shipping - discount, cur),
      priceTaxInterpretation: 'EXCLUSIVE',
      externalOrderReference: null,
    }
    this.orders.set(id, order)
    this.documents.set(id, {
      id: this.uuid(),
      createdOn: createdOn.toISOString(),
      modifiedOn: createdOn.toISOString(),
      customerEmail: input.email ?? null,
      salesOrderId: id,
      voided: false,
      payments: [],
      refunds: [],
      paymentGatewayError: null,
    })
    let paymentId: string | undefined
    if (input.pay !== false) {
      const p = input.pay ?? {}
      paymentId = this.addPayment(id, {
        amountCents: p.amountCents ?? decimalToCents(order.grandTotal.value),
        brand: p.brand === undefined ? 'VISA' : p.brand,
        paidOn: p.paidOn ?? createdOn,
        provider: p.provider,
        giftCardId: p.giftCardId,
        silent: true,
      })
    }
    if (order.paymentState === 'PAID' || input.pay === false)
      this.emit({ topic: 'order.create', orderId: id })
    return { orderId: id, paymentId }
  }

  /** A renewal: the same customer and product pay again; the order carries the contact's current email. */
  renewSubscription(
    orderId: string,
    opts: { createdOn?: Date; paid?: boolean } = {},
  ): { orderId: string; paymentId?: string } {
    const prev = this.mustOrder(orderId)
    const contact = prev.customerId ? this.contacts.get(prev.customerId) : undefined
    return this.createOrder({
      email: contact?.primaryEmail?.email ?? prev.customerEmail ?? undefined,
      name: [prev.billingAddress?.firstName, prev.billingAddress?.lastName].filter(Boolean).join(' '),
      phone: prev.billingAddress?.phone ?? undefined,
      lineItems: (prev.lineItems ?? []).map((li) => ({
        productId: li.productId ?? undefined,
        sku: li.sku ?? undefined,
        name: li.productName ?? '',
        unitCents: li.unitPricePaid ? decimalToCents(li.unitPricePaid.value) : 0,
        qty: li.quantity ?? 1,
        lineItemType: li.lineItemType ?? undefined,
      })),
      taxCents: prev.taxTotal ? decimalToCents(prev.taxTotal.value) : 0,
      createdOn: opts.createdOn,
      testMode: prev.testmode === true,
      pay: opts.paid === false ? false : undefined,
    })
  }

  addPayment(
    orderId: string,
    p: {
      amountCents: number
      brand?: string | null
      paidOn?: Date
      provider?: string
      giftCardId?: string
      silent?: boolean
    },
  ): string {
    const order = this.mustOrder(orderId)
    const doc = this.mustDocument(orderId)
    const when = p.paidOn ?? this.clock.now()
    const paymentId = this.uuid()
    const cur = order.grandTotal.currency ?? this.options.currency
    doc.payments = [
      ...(doc.payments ?? []),
      {
        id: paymentId,
        amount: money(p.amountCents, cur),
        creditCardType: p.giftCardId ? null : p.brand === undefined ? 'VISA' : p.brand,
        externalTransactionId: `ch_sim_${this.seq}`,
        giftCardId: p.giftCardId ?? null,
        paidOn: when.toISOString(),
        provider: p.provider ?? 'STRIPE',
        refundedAmount: money(0, cur),
        refunds: [],
      },
    ]
    const paid = (doc.payments ?? []).reduce((a, x) => a + decimalToCents(x.amount.value), 0)
    const grand = decimalToCents(order.grandTotal.value)
    if (decimalToCents(order.refundedTotal?.value ?? 0) === 0)
      order.paymentState = paid >= grand ? 'PAID' : 'PARTIALLY_PAID'
    if (!p.silent) {
      this.touch(order, doc)
      this.emit({ topic: 'order.update', orderId, update: 'PAYMENT' })
    }
    return paymentId
  }

  refund(orderId: string, r: SimRefundInput = {}): string {
    const order = this.mustOrder(orderId)
    const doc = this.mustDocument(orderId)
    const payments = doc.payments ?? []
    const target = r.paymentId ? payments.find((p) => p.id === r.paymentId) : payments[payments.length - 1]
    if (!target) throw new SimBadRequest('order has no payment to refund')
    const cur = order.grandTotal.currency ?? this.options.currency
    const alreadyRefunded = decimalToCents(order.refundedTotal?.value ?? 0)
    const refundable = decimalToCents(target.amount.value) - decimalToCents(target.refundedAmount?.value ?? 0)
    const amount = r.amountCents ?? refundable
    if (amount <= 0 || amount > refundable)
      throw new SimBadRequest(`refund ${amount} exceeds refundable ${refundable}`)
    const refundId = this.uuid()
    const row = {
      id: refundId,
      amount: money(amount, cur),
      externalTransactionId: `re_sim_${this.seq}`,
      refundedOn: (r.refundedOn ?? this.clock.now()).toISOString(),
    }
    if (r.documentLevel) doc.refunds = [...(doc.refunds ?? []), row]
    else target.refunds = [...(target.refunds ?? []), row]
    target.refundedAmount = money(decimalToCents(target.refundedAmount?.value ?? 0) + amount, cur)
    order.refundedTotal = money(alreadyRefunded + amount, cur)
    order.paymentState = 'REFUNDED' // docs: any refund, full or partial, sets REFUNDED
    this.touch(order, doc)
    this.emit({ topic: 'order.update', orderId, update: 'REFUNDED' })
    return refundId
  }

  setState(orderId: string, s: { paymentState?: string; fulfillmentStatus?: string }): void {
    const order = this.mustOrder(orderId)
    const doc = this.mustDocument(orderId)
    if (s.paymentState) order.paymentState = s.paymentState
    if (s.fulfillmentStatus) {
      order.fulfillmentStatus = s.fulfillmentStatus
      if (s.fulfillmentStatus === 'CANCELED') doc.voided = true
    }
    this.touch(order, doc)
    this.emit({ topic: 'order.update', orderId, update: s.fulfillmentStatus ?? 'MARKED_PENDING' })
  }

  /** Load recorded wire JSON (fixtures) verbatim. */
  loadWire(data: { orders?: unknown[]; documents?: unknown[]; contacts?: unknown[] }): void {
    for (const o of data.orders ?? []) this.orders.set((o as WireOrder).id, structuredClone(o) as WireOrder)
    for (const d of data.documents ?? []) {
      const doc = structuredClone(d) as WireTransactionDocument
      this.documents.set(doc.salesOrderId ?? `donation:${doc.id}`, doc)
    }
    for (const c of data.contacts ?? [])
      this.contacts.set((c as WireContact).id, structuredClone(c) as WireContact)
  }

  // ---- reads ----

  getOrder(id: string): WireOrder {
    return this.mustOrder(id)
  }

  getDocuments(ids: string[]): WireTransactionDocument[] {
    const byId = [...this.documents.values()]
    return ids.map((id) => {
      const d = byId.find((x) => x.id === id)
      if (!d) throw new SimNotFound(`transaction document ${id} not found`)
      return d
    })
  }

  queryOrders(q: {
    modifiedAfter?: string
    modifiedBefore?: string
    cursor?: string
    paymentStates?: string
    customerId?: string
    fulfillmentStatus?: string
  }): PageResult<WireOrder> {
    const r = this.resolveFilter(q, [
      'modifiedAfter',
      'modifiedBefore',
      'paymentStates',
      'customerId',
      'fulfillmentStatus',
    ])
    const f = r.values
    const states = new Set((f.paymentStates ?? DEFAULT_PAYMENT_STATES.join(',')).split(','))
    return this.keyset(
      [...this.orders.values()],
      (o) => o.modifiedOn,
      r,
      (o) =>
        states.has(o.paymentState ?? 'NOT_CHARGED') &&
        (!f.customerId || o.customerId === f.customerId) &&
        (!f.fulfillmentStatus || o.fulfillmentStatus === f.fulfillmentStatus),
    )
  }

  queryDocuments(q: {
    modifiedAfter?: string
    modifiedBefore?: string
    cursor?: string
    orderId?: string
  }): PageResult<WireTransactionDocument> {
    const r = this.resolveFilter(q, ['modifiedAfter', 'modifiedBefore', 'orderId'])
    return this.keyset(
      [...this.documents.values()],
      (d) => d.modifiedOn,
      r,
      (d) => !r.values.orderId || d.salesOrderId === r.values.orderId,
    )
  }

  queryContacts(q: { pageSize?: number; cursor?: string }): PageResult<WireContact> {
    const size = q.pageSize ?? 50
    if (!Number.isInteger(size) || size < 1 || size > 1000)
      throw new SimBadRequest('pageSize must be 1..1000')
    const all = [...this.contacts.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
    let from = 0
    if (q.cursor) {
      const c = decodeCursor(q.cursor)
      const last = c.k?.[1]
      from = all.findIndex((x) => x.id > String(last))
      if (from < 0) from = all.length
    }
    const rows = all.slice(from, from + size)
    const more = from + size < all.length
    const lastRow = rows[rows.length - 1]
    return { rows, nextCursor: more && lastRow ? encodeCursor({ k: ['', lastRow.id] }) : undefined }
  }

  // ---- internals ----

  private resolveFilter(q: Record<string, string | undefined>, allowed: string[]): Resolved {
    if (q.cursor) {
      const others = Object.keys(q).filter((k) => k !== 'cursor' && q[k] !== undefined)
      if (others.length)
        throw new SimBadRequest(
          `cursor cannot be combined with ${others.join(', ')}`,
          'CONFLICTING_ARGUMENTS',
        )
      const c = decodeCursor(q.cursor)
      return { values: c.f ?? {}, key: c.k }
    }
    const f: FilterValues = {}
    for (const k of allowed) if (q[k] !== undefined && q[k] !== '') f[k] = q[k]
    if (Boolean(f.modifiedAfter) !== Boolean(f.modifiedBefore)) {
      throw new SimBadRequest(
        'modifiedAfter and modifiedBefore must be provided together',
        'MISSING_ARGUMENT',
      )
    }
    for (const k of ['modifiedAfter', 'modifiedBefore']) {
      const v = f[k]
      if (v !== undefined && (Number.isNaN(Date.parse(v)) || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v))) {
        throw new SimBadRequest(`${k} must be an ISO 8601 UTC string`, 'INVALID_ARGUMENT')
      }
    }
    return { values: f }
  }

  private keyset<T extends { id: string }>(
    rows: T[],
    when: (r: T) => string,
    resolved: Resolved,
    keep: (r: T) => boolean,
  ): PageResult<T> {
    const f = resolved.values
    const after = f.modifiedAfter ? Date.parse(f.modifiedAfter) : undefined
    const before = f.modifiedBefore ? Date.parse(f.modifiedBefore) : undefined
    const dir = this.options.order === 'asc' ? 1 : -1
    const filtered = rows
      .filter((r) => {
        const t = Date.parse(when(r))
        return (after === undefined || t > after) && (before === undefined || t < before) && keep(r)
      })
      .sort((a, b) => dir * (Date.parse(when(a)) - Date.parse(when(b)) || (a.id < b.id ? -1 : 1)))
    let start = 0
    if (resolved.key) {
      const [t, id] = resolved.key
      start = filtered.findIndex(
        (r) =>
          dir * (Date.parse(when(r)) - Number(t) || (r.id < String(id) ? -1 : r.id > String(id) ? 1 : 0)) > 0,
      )
      if (start < 0) start = filtered.length
    }
    const page = filtered.slice(start, start + this.options.pageSize)
    const more = start + this.options.pageSize < filtered.length
    const last = page[page.length - 1]
    return {
      rows: page,
      nextCursor: more && last ? encodeCursor({ f, k: [Date.parse(when(last)), last.id] }) : undefined,
    }
  }

  private ensureContact(
    email: string,
    name: string | undefined,
    phone: string | undefined,
    createdOn: Date,
  ): WireContact {
    const key = email.trim().toLowerCase()
    for (const c of this.contacts.values()) if (c.primaryEmail?.email?.toLowerCase() === key) return c
    const [firstName, ...rest] = (name ?? '').trim().split(/\s+/).filter(Boolean)
    const contact: WireContact = {
      id: this.hex24(),
      createdOn: createdOn.toISOString(),
      firstName: firstName ?? null,
      lastName: rest.join(' ') || null,
      primaryEmail: { email },
      defaultShippingAddress: phone ? { address: { phoneNumber: phone } } : null,
    }
    this.contacts.set(contact.id, contact)
    return contact
  }

  private touch(order: WireOrder, doc: WireTransactionDocument): void {
    const t = this.clock.now().toISOString()
    // modifiedOn must never move backwards, even when a test back-dates createdOn.
    order.modifiedOn = t > order.modifiedOn ? t : bump(order.modifiedOn)
    doc.modifiedOn = t > doc.modifiedOn ? t : bump(doc.modifiedOn)
  }

  private emit(e: SimEvent): void {
    this.events.push(e)
    for (const l of this.listeners) l(e)
  }

  private mustOrder(id: string): WireOrder {
    const o = this.orders.get(id)
    if (!o) throw new SimNotFound(`order ${id} not found`)
    return o
  }

  private mustDocument(orderId: string): WireTransactionDocument {
    const d = this.documents.get(orderId)
    if (!d) throw new SimNotFound(`no transaction document for order ${orderId}`)
    return d
  }

  private hex24(): string {
    return (++this.seq).toString(16).padStart(24, '0')
  }

  private uuid(): string {
    return `00000000-0000-4000-8000-${(++this.seq).toString(16).padStart(12, '0')}`
  }
}

type FilterValues = Record<string, string | undefined>
interface Resolved {
  values: FilterValues
  key?: (string | number)[]
}

function money(cents: number, currency: string): Money {
  return { currency, value: centsToDecimal(cents) }
}

function bump(iso: string): string {
  return new Date(Date.parse(iso) + 1).toISOString()
}

function encodeCursor(c: { f?: Record<string, string | undefined>; k?: (string | number)[] }): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url')
}

function decodeCursor(s: string): { f?: Record<string, string | undefined>; k?: (string | number)[] } {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
    if (v && typeof v === 'object') return v as { f?: Record<string, string>; k?: (string | number)[] }
  } catch {
    /* fallthrough */
  }
  throw new SimBadRequest('invalid cursor', 'INVALID_ARGUMENT')
}
