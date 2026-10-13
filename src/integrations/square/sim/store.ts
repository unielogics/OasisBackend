// The Square simulator's state (ADR 0171): an in-memory merchant with one location that answers every call Oasis makes the way the
// sandbox did on 2026-10-12 (docs/integrations/square.md section 8; the scrubbed answers in test/fixtures/square/). Objects are kept
// in Square's own wire shape. Time comes from the injected clock plus an offset the controls can move, and moves the clock-driven
// parts: refunds go PENDING -> COMPLETED, subscriptions bill their periods, scheduled actions (pause, cancel, swap) take effect.
// Every change is an event in the log SearchEvents reads and the webhook deliverer sends.
import { randomBytes, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import type { Clock } from '../../../platform/clock.js'
import { SIM_LOCATION_ID, SIM_MERCHANT_ID } from '../config.js'

type Obj = Record<string, unknown>
type Money = { amount: number; currency: string }

export class SimError extends Error {
  constructor(
    readonly status: number,
    readonly category: string,
    readonly code: string,
    readonly detail: string,
    readonly extra: Obj = {},
  ) {
    super(detail)
  }
}

export interface SimStoreOptions {
  locationId?: string
  merchantId?: string
  timezone?: string
  /** Host of payment link URLs: the sandbox answers sandbox.square.link, production square.link. */
  linkHost?: string
  /** A refund stays PENDING this long (the sandbox took about 4.5 s). */
  refundDelayMs?: number
  /** A new subscription bills its first period this long after creation (the sandbox took about 10 s; 0 = at the next request). */
  firstInvoiceDelayMs?: number
}

export interface SimEventRecord {
  merchant_id: string
  location_id?: string
  type: string
  event_id: string
  created_at: string
  data: { type: string; id?: string; object: Obj }
}

const NONCE_CARDS: Record<string, { brand: string; last4: string; decline?: string }> = {
  'cnon:card-nonce-ok': { brand: 'VISA', last4: '5858' },
  'cnon:card-nonce-declined': { brand: 'VISA', last4: '0002', decline: 'GENERIC_DECLINE' },
  'cnon:card-nonce-rejected-cvv': { brand: 'VISA', last4: '0010', decline: 'CVV_FAILURE' },
  'cnon:card-nonce-rejected-postalcode': { brand: 'VISA', last4: '0036', decline: 'ADDRESS_VERIFICATION_FAILURE' },
  'cnon:card-nonce-rejected-expiration': { brand: 'VISA', last4: '0069', decline: 'INVALID_EXPIRATION' },
  'cnon:card-nonce-insufficient-funds': { brand: 'VISA', last4: '0051', decline: 'INSUFFICIENT_FUNDS' },
}

/** Email domains Square cannot deliver to: a subscription for such a customer is DEACTIVATED within seconds (sandbox 2026-10-12). */
const UNDELIVERABLE = /@(example\.(com|org|net)|[^@]+\.(test|invalid|example|localhost))$/i

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function rid(n: number): string {
  const b = randomBytes(n)
  let s = ''
  for (let i = 0; i < n; i++) s += B32[b[i]! % 32]
  return s
}

const usd = (amount: number): Money => ({ amount, currency: 'USD' })
const clone = <T>(v: T): T => structuredClone(v)

export class SquareSimStore {
  readonly locationId: string
  readonly merchantId: string
  readonly timezone: string
  readonly linkHost: string
  refundDelayMs: number
  firstInvoiceDelayMs: number
  offsetMs = 0
  eventsEnabled = false

  readonly customers = new Map<string, Obj>()
  readonly cards = new Map<string, Obj>()
  readonly payments = new Map<string, Obj>()
  readonly refunds = new Map<string, Obj>()
  readonly orders = new Map<string, Obj>()
  readonly links = new Map<string, Obj>()
  readonly catalog = new Map<string, Obj>()
  readonly subscriptions = new Map<string, Obj>()
  readonly invoices = new Map<string, Obj>()
  readonly webhookSubscriptions = new Map<string, Obj>()
  /** subscription id -> its scheduled actions, and the internal billing bookkeeping. */
  private readonly actions = new Map<string, Obj[]>()
  private readonly billing = new Map<string, { nextBillAt: number; deactivateAt?: number }>()
  /**
   * Square's swap lock (sandbox 2026-10-12, square.md section 8; review Q4 SQ-SEM-2): after a scheduled SWAP_PLAN to X is deleted, a
   * SwapPlan to X in the same billing period answers 500 "locked and is not billable", and from then on every DeleteSubscriptionAction
   * of that subscription answers 409 until the next billing. subscription id -> the period (its next billing date) and what it locks.
   */
  private readonly swapLocks = new Map<string, { period: string; undone: Set<string>; locked: boolean }>()
  /** order id -> what owns it ('invoice' orders refuse CreatePayment like the sandbox's "owned by another application"). */
  private readonly orderOwner = new Map<string, 'link' | 'invoice' | 'payment' | 'pos'>()
  readonly events: SimEventRecord[] = []
  private listeners: Array<(e: SimEventRecord) => void> = []

  constructor(
    private readonly clock: Clock,
    o: SimStoreOptions = {},
  ) {
    this.locationId = o.locationId ?? SIM_LOCATION_ID
    this.merchantId = o.merchantId ?? SIM_MERCHANT_ID
    this.timezone = o.timezone ?? 'America/New_York'
    this.linkHost = o.linkHost ?? 'sandbox.square.link'
    this.refundDelayMs = o.refundDelayMs ?? 3000
    this.firstInvoiceDelayMs = o.firstInvoiceDelayMs ?? 0
  }

  now(): Date {
    return new Date(this.clock.now().getTime() + this.offsetMs)
  }

  private iso(): string {
    return this.now().toISOString()
  }

  private today(): string {
    return DateTime.fromJSDate(this.now()).setZone(this.timezone).toFormat('yyyy-MM-dd')
  }

  private dateMs(date: string): number {
    return DateTime.fromISO(date, { zone: this.timezone }).startOf('day').toMillis()
  }

  onEvent(fn: (e: SimEventRecord) => void): () => void {
    this.listeners.push(fn)
    return () => {
      this.listeners = this.listeners.filter((x) => x !== fn)
    }
  }

  private emit(type: string, dataType: string, id: string | undefined, object: Obj, location = true): void {
    const e: SimEventRecord = {
      merchant_id: this.merchantId,
      ...(location ? { location_id: this.locationId } : {}),
      type,
      event_id: randomUUID(),
      created_at: this.iso(),
      data: { type: dataType, ...(id ? { id } : {}), object: clone(object) },
    }
    this.events.push(e)
    for (const l of this.listeners) l(e)
  }

  // ---- locations ---------------------------------------------------------------------------------------------------------------

  location(): Obj {
    return {
      id: this.locationId,
      name: 'Oasis Auto Spa (simulator)',
      address: { address_line_1: '1 Simulator Way', locality: 'Garfield', administrative_district_level_1: 'NJ', postal_code: '07026', country: 'US' },
      timezone: this.timezone,
      capabilities: ['CREDIT_CARD_PROCESSING', 'AUTOMATIC_TRANSFERS'],
      status: 'ACTIVE',
      created_at: '2026-01-01T00:00:00Z',
      merchant_id: this.merchantId,
      country: 'US',
      language_code: 'en-US',
      currency: 'USD',
      business_name: 'Oasis Auto Spa (simulator)',
      type: 'PHYSICAL',
    }
  }

  private assertLocation(id: unknown): void {
    if (id !== this.locationId) throw new SimError(404, 'INVALID_REQUEST_ERROR', 'NOT_FOUND', `Location \`${String(id)}\` not found.`)
  }

  private get<T extends Obj>(map: Map<string, T>, id: string, what: string): T {
    const v = map.get(id)
    if (!v) throw new SimError(404, 'INVALID_REQUEST_ERROR', 'NOT_FOUND', `${what} \`${id}\` not found.`)
    return v
  }

  // ---- customers ---------------------------------------------------------------------------------------------------------------

  createCustomer(input: Obj): Obj {
    const id = rid(26)
    const c: Obj = {
      id,
      created_at: this.iso(),
      updated_at: this.iso(),
      ...pick(input, ['given_name', 'family_name', 'email_address', 'phone_number', 'reference_id', 'note', 'company_name']),
      preferences: { email_unsubscribed: false },
      creation_source: 'THIRD_PARTY',
      version: 0,
    }
    this.customers.set(id, c)
    this.emit('customer.created', 'customer', id, { customer: c }, false)
    return clone(c)
  }

  updateCustomer(id: string, input: Obj): Obj {
    const c = this.get(this.customers, id, 'Customer')
    Object.assign(c, pick(input, ['given_name', 'family_name', 'email_address', 'phone_number', 'reference_id', 'note']), {
      updated_at: this.iso(),
      version: Number(c.version ?? 0) + 1,
    })
    this.emit('customer.updated', 'customer', id, { customer: c }, false)
    return clone(c)
  }

  retrieveCustomer(id: string): Obj {
    return clone(this.get(this.customers, id, 'Customer'))
  }

  deleteCustomer(id: string): void {
    const c = this.get(this.customers, id, 'Customer')
    this.customers.delete(id)
    this.emit('customer.deleted', 'customer', id, { customer: c }, false)
  }

  searchCustomers(filter: Obj): Obj[] {
    const exact = (k: string) => (filter[k] as { exact?: string } | undefined)?.exact
    return [...this.customers.values()]
      .filter((c) => (!exact('reference_id') || c.reference_id === exact('reference_id')))
      .filter((c) => (!exact('email_address') || c.email_address === exact('email_address')))
      .filter((c) => (!exact('phone_number') || c.phone_number === exact('phone_number')))
      .map(clone)
  }

  // ---- cards ---------------------------------------------------------------------------------------------------------------------

  createCard(input: Obj): Obj {
    const src = String(input.source_id ?? '')
    const card = (input.card ?? {}) as Obj
    const customerId = String(card.customer_id ?? '')
    this.get(this.customers, customerId, 'Customer')
    const n = NONCE_CARDS[src]
    // the sandbox answered every declined nonce with INVALID_CARD_DATA on CreateCard (the decline codes come from CreatePayment)
    if (!n || n.decline) throw new SimError(400, 'INVALID_REQUEST_ERROR', 'INVALID_CARD_DATA', 'Invalid card data.')
    const id = `ccof:${rid(16)}`
    const c: Obj = {
      id,
      card_brand: n.brand,
      last_4: n.last4,
      exp_month: 10,
      exp_year: Number(this.today().slice(0, 4)) + 2,
      cardholder_name: card.cardholder_name,
      billing_address: card.billing_address,
      fingerprint: `sq-1-${rid(40)}`,
      customer_id: customerId,
      merchant_id: this.merchantId,
      reference_id: card.reference_id,
      enabled: true,
      card_type: 'CREDIT',
      prepaid_type: 'NOT_PREPAID',
      bin: '453275',
      created_at: this.iso(),
      version: 1,
    }
    this.cards.set(id, c)
    this.emit('card.created', 'card', id, { card: c }, false)
    return clone(c)
  }

  retrieveCard(id: string): Obj {
    return clone(this.get(this.cards, id, 'Card'))
  }

  listCards(q: { customer_id?: string; include_disabled?: boolean; reference_id?: string }): Obj[] {
    return [...this.cards.values()]
      .filter((c) => !q.customer_id || c.customer_id === q.customer_id)
      .filter((c) => !q.reference_id || c.reference_id === q.reference_id)
      .filter((c) => q.include_disabled || c.enabled)
      .map(clone)
  }

  disableCard(id: string, why: 'disabled' | 'forgotten' = 'disabled'): Obj {
    const c = this.get(this.cards, id, 'Card')
    if (c.enabled) {
      c.enabled = false
      c.version = Number(c.version ?? 1) + 1
      this.emit(why === 'forgotten' ? 'card.forgotten' : 'card.disabled', 'card', id, { card: c }, false)
    }
    return clone(c)
  }

  /** The issuer's automatic update (new expiry, sometimes a new last 4). */
  autoUpdateCard(id: string, o: { last4?: string; expYear?: number } = {}): Obj {
    const c = this.get(this.cards, id, 'Card')
    c.exp_year = o.expYear ?? Number(c.exp_year) + 3
    if (o.last4) c.last_4 = o.last4
    c.version = Number(c.version ?? 1) + 1
    this.emit('card.automatically_updated', 'card', id, { card: c }, false)
    return clone(c)
  }

  // ---- orders ----------------------------------------------------------------------------------------------------------------

  private newOrder(o: { lines: Obj[]; reference_id?: unknown; customer_id?: unknown; state: string; owner: 'link' | 'invoice' | 'payment' | 'pos'; fulfillment?: boolean }): Obj {
    const id = rid(27)
    const lines = o.lines.map((l) => {
      const qty = Number(l.quantity ?? '1')
      const base = Number((l.base_price_money as Money | undefined)?.amount ?? 0)
      return {
        uid: rid(22),
        name: l.name,
        quantity: String(l.quantity ?? '1'),
        item_type: 'ITEM',
        base_price_money: usd(base),
        variation_total_price_money: usd(base * qty),
        gross_sales_money: usd(base * qty),
        total_tax_money: usd(0),
        total_discount_money: usd(0),
        total_money: usd(base * qty),
      }
    })
    const total = lines.reduce((s, l) => s + l.total_money.amount, 0)
    const order: Obj = {
      id,
      location_id: this.locationId,
      ...(o.reference_id ? { reference_id: o.reference_id } : {}),
      ...(o.customer_id ? { customer_id: o.customer_id } : {}),
      line_items: lines,
      ...(o.fulfillment ? { fulfillments: [{ uid: rid(22), type: 'DIGITAL', state: 'PROPOSED' }] } : {}),
      created_at: this.iso(),
      updated_at: this.iso(),
      state: o.state,
      version: 1,
      total_money: usd(total),
      total_tax_money: usd(0),
      total_discount_money: usd(0),
      total_tip_money: usd(0),
      total_service_charge_money: usd(0),
      net_amount_due_money: usd(total),
    }
    this.orders.set(id, order)
    this.orderOwner.set(id, o.owner)
    this.emit('order.created', 'order_created', id, { order_created: { order_id: id, version: 1, location_id: this.locationId, state: o.state, created_at: order.created_at } })
    return order
  }

  private touchOrder(order: Obj): void {
    order.version = Number(order.version ?? 1) + 1
    order.updated_at = this.iso()
    this.emit('order.updated', 'order_updated', String(order.id), {
      order_updated: { order_id: order.id, version: order.version, location_id: this.locationId, state: order.state, updated_at: order.updated_at },
    })
  }

  retrieveOrder(id: string): Obj {
    return clone(this.get(this.orders, id, 'Order'))
  }

  /** UpdateOrder: the simulator supports what the hosted checkout does, moving a link's DRAFT order to OPEN (version checked). */
  updateOrder(id: string, input: Obj): Obj {
    const order = this.get(this.orders, id, 'Order')
    const patch = (input.order ?? {}) as Obj
    if (patch.version !== undefined && patch.version !== order.version)
      throw new SimError(400, 'INVALID_REQUEST_ERROR', 'VERSION_MISMATCH', 'Order version does not match.')
    if (patch.state === 'OPEN' && order.state === 'DRAFT') {
      order.state = 'OPEN'
      this.touchOrder(order)
    } else if (patch.state && patch.state !== order.state)
      throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', `The simulator cannot move an order from ${String(order.state)} to ${String(patch.state)}.`)
    return clone(order)
  }

  // ---- payments --------------------------------------------------------------------------------------------------------------

  createPayment(input: Obj, o: { product?: string; note?: string } = {}): Obj {
    this.assertLocation(input.location_id ?? this.locationId)
    const amount = moneyIn(input.amount_money, 'amount_money')
    const tip = input.tip_money ? moneyIn(input.tip_money, 'tip_money') : 0
    const src = String(input.source_id ?? '')
    let order: Obj | undefined
    if (input.order_id) {
      order = this.get(this.orders, String(input.order_id), 'Order')
      if (this.orderOwner.get(String(order.id)) === 'invoice')
        throw new SimError(403, 'AUTHENTICATION_ERROR', 'FORBIDDEN', `The order \`${String(order.id)}\` is owned by another application.`)
      if (order.state !== 'OPEN') throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', 'The order must be OPEN to be paid.')
      const due = (order.net_amount_due_money as Money).amount
      if (amount !== due)
        throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', `Payment amount ${amount} does not match the amount due on the order (${due}).`)
    }
    let source: Obj
    let card: { brand: string; last4: string; decline?: string } | undefined
    let entry = 'KEYED'
    if (src === 'CASH') source = { source_type: 'CASH', cash_details: { buyer_supplied_money: usd(amount + tip), change_back_money: usd(0) } }
    else if (src.startsWith('ccof:')) {
      const c = this.get(this.cards, src, 'Card')
      if (!c.enabled) throw new SimError(400, 'INVALID_REQUEST_ERROR', 'CARD_DECLINED', 'The card is disabled.')
      if (input.customer_id !== c.customer_id)
        throw new SimError(400, 'INVALID_REQUEST_ERROR', 'INVALID_VALUE', 'customer_id must be the customer of the card on file.')
      card = { brand: String(c.card_brand), last4: String(c.last_4) }
      entry = 'ON_FILE'
      source = { source_type: 'CARD' }
    } else if (NONCE_CARDS[src] || src.startsWith('pos:')) {
      card = NONCE_CARDS[src] ?? { brand: 'VISA', last4: '1111' }
      if (src.startsWith('pos:')) entry = 'EMV'
      source = { source_type: 'CARD' }
    } else throw new SimError(400, 'INVALID_REQUEST_ERROR', 'INVALID_CARD_DATA', 'Invalid card data.')
    const id = rid(29)
    const total = amount + tip
    const p: Obj = {
      id,
      created_at: this.iso(),
      updated_at: this.iso(),
      amount_money: usd(amount),
      ...(tip ? { tip_money: usd(tip) } : {}),
      total_money: usd(total),
      approved_money: usd(total),
      status: input.autocomplete === false ? 'APPROVED' : 'COMPLETED',
      ...source,
      ...(card
        ? {
            card_details: {
              status: input.autocomplete === false ? 'AUTHORIZED' : 'CAPTURED',
              card: { card_brand: card.brand, last_4: card.last4, exp_month: 10, exp_year: 2028, card_type: 'CREDIT', prepaid_type: 'NOT_PREPAID' },
              entry_method: entry,
            },
          }
        : {}),
      location_id: this.locationId,
      ...(input.customer_id ? { customer_id: input.customer_id } : {}),
      ...(input.reference_id ? { reference_id: input.reference_id } : {}),
      ...((input.note ?? o.note) ? { note: input.note ?? o.note } : {}),
      receipt_number: id.slice(0, 4),
      receipt_url: `https://squareupsandbox.com/receipt/preview/${id}`,
      application_details: { square_product: o.product ?? 'ECOMMERCE_API', application_id: 'sandbox-sq0idb-simulator' },
      version_token: rid(20),
    }
    if (card?.decline) {
      Object.assign(p, { status: 'FAILED', approved_money: usd(0) })
      ;(p.card_details as Obj).status = 'FAILED'
      this.payments.set(id, p)
      this.emit('payment.created', 'payment', id, { payment: p })
      throw new SimError(400, 'PAYMENT_METHOD_ERROR', card.decline, `Authorization error: '${card.decline}'`, { payment: clone(p) })
    }
    if (!order) order = this.newOrder({ lines: [{ name: 'Custom amount', quantity: '1', base_price_money: usd(amount) }], state: 'OPEN', owner: o.product === 'SQUARE_POS' ? 'pos' : 'payment', reference_id: input.reference_id, customer_id: input.customer_id })
    p.order_id = order.id
    this.payments.set(id, p)
    if (p.status === 'COMPLETED') this.tender(order, p)
    this.emit('payment.created', 'payment', id, { payment: p })
    if (p.status === 'COMPLETED') this.emit('payment.updated', 'payment', id, { payment: p })
    return clone(p)
  }

  private tender(order: Obj, p: Obj): void {
    const tenders = (order.tenders as Obj[] | undefined) ?? []
    tenders.push({ id: p.id, type: p.source_type === 'CASH' ? 'CASH' : 'CARD', payment_id: p.id, amount_money: p.amount_money, tip_money: p.tip_money })
    order.tenders = tenders
    const due = (order.net_amount_due_money as Money).amount - (p.amount_money as Money).amount
    order.net_amount_due_money = usd(Math.max(0, due))
    if (p.tip_money) order.total_tip_money = usd((order.total_tip_money as Money).amount + (p.tip_money as Money).amount)
    // a link's order keeps its DIGITAL fulfillment PROPOSED, so it stays OPEN (sandbox); a plain payment's order completes
    if (due <= 0 && !order.fulfillments) order.state = 'COMPLETED'
    this.touchOrder(order)
  }

  getPayment(id: string): Obj {
    return clone(this.get(this.payments, id, 'Payment'))
  }

  listPayments(q: { begin_time?: string; end_time?: string; sort_order?: string; location_id?: string }): Obj[] {
    return this.listByTime([...this.payments.values()], q)
  }

  private listByTime(rows: Obj[], q: { begin_time?: string; end_time?: string; sort_order?: string; location_id?: string }): Obj[] {
    const begin = q.begin_time ? Date.parse(q.begin_time) : this.now().getTime() - 365 * 86_400_000
    const end = q.end_time ? Date.parse(q.end_time) : Infinity
    const out = rows
      .filter((r) => !q.location_id || r.location_id === q.location_id)
      .filter((r) => {
        const t = Date.parse(String(r.created_at))
        return t >= begin && t < end
      })
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    if (q.sort_order !== 'ASC') out.reverse()
    return out.map(clone)
  }

  cancelPayment(id: string): Obj {
    const p = this.get(this.payments, id, 'Payment')
    if (p.status === 'CANCELED') return clone(p)
    if (p.status !== 'APPROVED') throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', `Payment ${id} is ${String(p.status)} and cannot be canceled.`)
    p.status = 'CANCELED'
    p.updated_at = this.iso()
    this.emit('payment.updated', 'payment', id, { payment: p })
    return clone(p)
  }

  // ---- refunds ---------------------------------------------------------------------------------------------------------------

  refundPayment(input: Obj): Obj {
    const p = this.get(this.payments, String(input.payment_id ?? ''), 'Payment')
    if (p.status !== 'COMPLETED') throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', 'Only a COMPLETED payment can be refunded.')
    const amount = moneyIn(input.amount_money, 'amount_money')
    const refunded = (p.refunded_money as Money | undefined)?.amount ?? 0
    const pending = [...this.refunds.values()]
      .filter((r) => r.payment_id === p.id && r.status === 'PENDING')
      .reduce((s, r) => s + (r.amount_money as Money).amount, 0)
    if (amount <= 0 || amount + refunded + pending > (p.total_money as Money).amount)
      throw new SimError(400, 'REFUND_ERROR', 'REFUND_AMOUNT_INVALID', 'The requested refund amount exceeds the amount available to refund.')
    const id = `${String(p.id)}_${rid(22)}`
    const r: Obj = {
      id,
      status: 'PENDING',
      amount_money: usd(amount),
      payment_id: p.id,
      order_id: p.order_id,
      location_id: this.locationId,
      ...(input.reason ? { reason: input.reason } : {}),
      created_at: this.iso(),
      updated_at: this.iso(),
    }
    this.refunds.set(id, r)
    p.refund_ids = [...((p.refund_ids as string[] | undefined) ?? []), id]
    this.emit('refund.created', 'refund', id, { refund: r })
    return clone(r)
  }

  getRefund(id: string): Obj {
    return clone(this.get(this.refunds, id, 'Refund'))
  }

  listRefunds(q: { begin_time?: string; end_time?: string; sort_order?: string; location_id?: string }): Obj[] {
    return this.listByTime([...this.refunds.values()], q)
  }

  /** A refund the card network gives back: FAILED or REJECTED (it then no longer counts). */
  failRefund(id: string, status: 'FAILED' | 'REJECTED' = 'FAILED'): Obj {
    const r = this.get(this.refunds, id, 'Refund')
    if (r.status !== 'PENDING') throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', `Refund ${id} is ${String(r.status)}.`)
    r.status = status
    r.updated_at = this.iso()
    this.emit('refund.updated', 'refund', id, { refund: r })
    return clone(r)
  }

  private completeRefund(r: Obj): void {
    r.status = 'COMPLETED'
    r.updated_at = this.iso()
    const p = this.payments.get(String(r.payment_id))
    if (p) {
      p.refunded_money = usd(((p.refunded_money as Money | undefined)?.amount ?? 0) + (r.amount_money as Money).amount)
      p.updated_at = this.iso()
    }
    this.emit('refund.updated', 'refund', String(r.id), { refund: r })
    if (p) this.emit('payment.updated', 'payment', String(p.id), { payment: p })
  }

  // ---- payment links ---------------------------------------------------------------------------------------------------------

  createLink(input: Obj): { link: Obj; order: Obj } {
    let order: Obj
    if (input.quick_pay) {
      const q = input.quick_pay as Obj
      this.assertLocation(q.location_id)
      order = this.newOrder({ lines: [{ name: q.name, quantity: '1', base_price_money: { amount: moneyIn(q.price_money, 'price_money'), currency: 'USD' } }], state: 'DRAFT', owner: 'link', fulfillment: true })
    } else if (input.order) {
      const o = input.order as Obj
      this.assertLocation(o.location_id)
      const lines = (o.line_items as Obj[] | undefined) ?? []
      if (!lines.length) throw new SimError(400, 'INVALID_REQUEST_ERROR', 'MISSING_REQUIRED_PARAMETER', 'order.line_items is required.')
      for (const l of lines) moneyIn(l.base_price_money, 'base_price_money')
      order = this.newOrder({ lines, state: 'DRAFT', owner: 'link', reference_id: o.reference_id, customer_id: o.customer_id, fulfillment: true })
    } else throw new SimError(400, 'INVALID_REQUEST_ERROR', 'MISSING_REQUIRED_PARAMETER', 'One of quick_pay or order is required.')
    const id = rid(16)
    const link: Obj = {
      id,
      version: 1,
      order_id: order.id,
      ...(input.checkout_options ? { checkout_options: input.checkout_options } : {}),
      ...(input.pre_populated_data ? { pre_populated_data: input.pre_populated_data } : {}),
      url: `https://${this.linkHost}/u/${rid(8)}`,
      long_url: `https://connect.squareupsandbox.com/v2/online-checkout/sandbox-testing-panel/${this.merchantId}/${id}`,
      created_at: this.iso(),
      ...(input.payment_note ? { payment_note: input.payment_note } : {}),
    }
    this.links.set(id, link)
    return { link: clone(link), order: clone(order) }
  }

  retrieveLink(id: string): Obj {
    return clone(this.get(this.links, id, 'Payment link'))
  }

  updateLink(id: string, patch: Obj): Obj {
    const l = this.get(this.links, id, 'Payment link')
    if (patch.version !== l.version) throw new SimError(400, 'INVALID_REQUEST_ERROR', 'VERSION_MISMATCH', 'The payment link version does not match.')
    Object.assign(l, pick(patch, ['checkout_options', 'pre_populated_data', 'payment_note', 'description']), {
      version: Number(l.version) + 1,
      updated_at: this.iso(),
    })
    return clone(l)
  }

  deleteLink(id: string): { id: string; cancelled_order_id: string } {
    const l = this.get(this.links, id, 'Payment link')
    this.links.delete(id)
    const order = this.orders.get(String(l.order_id))
    if (order && (order.state === 'DRAFT' || order.state === 'OPEN') && !(order.tenders as Obj[] | undefined)?.length) {
      order.state = 'CANCELED'
      this.touchOrder(order)
    }
    return { id, cancelled_order_id: String(l.order_id) }
  }

  /** The buyer pays a link on Square's checkout page: the order is opened and paid with its total (plus an optional tip). */
  payLink(id: string, o: { tipCents?: number; nonce?: string } = {}): Obj {
    const l = this.get(this.links, id, 'Payment link')
    const order = this.get(this.orders, String(l.order_id), 'Order')
    if (order.state === 'DRAFT') {
      order.state = 'OPEN'
      this.touchOrder(order)
    }
    return this.createPayment({
      source_id: o.nonce ?? 'cnon:card-nonce-ok',
      order_id: order.id,
      amount_money: order.net_amount_due_money,
      ...(o.tipCents ? { tip_money: usd(o.tipCents) } : {}),
      location_id: this.locationId,
      autocomplete: true,
      ...(l.payment_note ? { note: l.payment_note } : {}),
    })
  }

  // ---- point of sale (controls only) -----------------------------------------------------------------------------------------

  /** A payment taken on the Square POS app or reader at the counter. */
  posPayment(o: { amountCents: number; tipCents?: number; note?: string; sourceType?: 'CARD' | 'CASH'; customerId?: string }): Obj {
    return this.createPayment(
      {
        source_id: o.sourceType === 'CASH' ? 'CASH' : 'pos:reader',
        amount_money: usd(o.amountCents),
        ...(o.tipCents ? { tip_money: usd(o.tipCents) } : {}),
        location_id: this.locationId,
        ...(o.customerId ? { customer_id: o.customerId } : {}),
        ...(o.note ? { note: o.note } : {}),
        autocomplete: true,
      },
      { product: 'SQUARE_POS' },
    )
  }

  // ---- catalog -----------------------------------------------------------------------------------------------------------------

  upsertCatalog(objects: Obj[]): { objects: Obj[]; id_mappings: Obj[] } {
    const mappings: Obj[] = []
    const temp = new Map<string, string>()
    for (const o of objects) if (typeof o.id === 'string' && o.id.startsWith('#')) temp.set(o.id, rid(24))
    const resolve = (v: unknown) => (typeof v === 'string' && temp.has(v) ? temp.get(v)! : v)
    const out: Obj[] = []
    for (const raw of objects) {
      const o = clone(raw)
      const tempId = typeof o.id === 'string' && o.id.startsWith('#') ? o.id : undefined
      const id = tempId ? temp.get(tempId)! : String(o.id ?? '')
      const existing = tempId ? undefined : this.catalog.get(id)
      if (!tempId && !existing) throw new SimError(404, 'INVALID_REQUEST_ERROR', 'NOT_FOUND', `Catalog object \`${id}\` not found.`)
      if (existing && o.version !== undefined && o.version !== existing.version)
        throw new SimError(400, 'INVALID_REQUEST_ERROR', 'VERSION_MISMATCH', 'Object version does not match.')
      if (o.type === 'SUBSCRIPTION_PLAN_VARIATION') {
        const data = (o.subscription_plan_variation_data ?? {}) as Obj
        data.subscription_plan_id = resolve(data.subscription_plan_id)
        const plan = this.catalog.get(String(data.subscription_plan_id)) ?? out.find((x) => x.id === data.subscription_plan_id)
        if (!plan) throw new SimError(400, 'INVALID_REQUEST_ERROR', 'INVALID_VALUE', 'subscription_plan_id must name a SUBSCRIPTION_PLAN.')
        const phases = (data.phases as Obj[] | undefined) ?? []
        if (!phases.length) throw new SimError(400, 'INVALID_REQUEST_ERROR', 'MISSING_REQUIRED_PARAMETER', 'phases is required.')
        for (const ph of phases) {
          const pricing = (ph.pricing ?? {}) as Obj
          if (pricing.type === 'STATIC') {
            moneyIn(pricing.price_money, 'price_money')
            pricing.price = pricing.price_money
          }
          ph.uid ??= rid(22)
        }
      } else if (o.type !== 'SUBSCRIPTION_PLAN' && o.type !== 'ITEM' && o.type !== 'ITEM_VARIATION')
        throw new SimError(400, 'INVALID_REQUEST_ERROR', 'INVALID_VALUE', `The simulator does not keep catalog objects of type ${String(o.type)}.`)
      const stored: Obj = {
        ...o,
        id,
        updated_at: this.iso(),
        created_at: existing?.created_at ?? this.iso(),
        version: this.now().getTime() + out.length,
        is_deleted: false,
        present_at_all_locations: true,
      }
      this.catalog.set(id, stored)
      out.push(stored)
      if (tempId) mappings.push({ client_object_id: tempId, object_id: id })
    }
    this.emit('catalog.version.updated', 'catalog_version', undefined, { catalog_version: { updated_at: this.iso() } }, false)
    return { objects: out.map(clone), id_mappings: mappings }
  }

  retrieveCatalog(id: string): Obj {
    return clone(this.get(this.catalog, id, 'Catalog object'))
  }

  searchCatalog(types: string[]): Obj[] {
    return [...this.catalog.values()].filter((o) => !types.length || types.includes(String(o.type))).map(clone)
  }

  deleteCatalog(id: string): string[] {
    const o = this.get(this.catalog, id, 'Catalog object')
    const variations = o.type === 'SUBSCRIPTION_PLAN'
      ? [...this.catalog.values()].filter((v) => (v.subscription_plan_variation_data as Obj | undefined)?.subscription_plan_id === id).map((v) => String(v.id))
      : [id]
    const used = [...this.subscriptions.values()].some((s) => variations.includes(String(s.plan_variation_id)))
    if (used) throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', `Catalog Object cannot be deleted for token(s) ${id}`)
    const gone = o.type === 'SUBSCRIPTION_PLAN' ? [id, ...variations] : [id]
    for (const g of gone) this.catalog.delete(g)
    return gone
  }

  // ---- subscriptions -----------------------------------------------------------------------------------------------------------

  createSubscription(input: Obj): Obj {
    this.assertLocation(input.location_id)
    const variation = this.catalog.get(String(input.plan_variation_id ?? ''))
    if (!variation || variation.type !== 'SUBSCRIPTION_PLAN_VARIATION')
      throw new SimError(400, 'INVALID_REQUEST_ERROR', 'INVALID_VALUE', 'plan_variation_id must name a SUBSCRIPTION_PLAN_VARIATION.')
    const customer = this.get(this.customers, String(input.customer_id ?? ''), 'Customer')
    if (input.card_id) {
      const card = this.get(this.cards, String(input.card_id), 'Card')
      if (card.customer_id !== customer.id || !card.enabled)
        throw new SimError(400, 'INVALID_REQUEST_ERROR', 'INVALID_CARD', 'The card must be an enabled card of the customer.')
    }
    const today = this.today()
    const start = String(input.start_date ?? today)
    const id = randomUUID()
    const s: Obj = {
      id,
      location_id: this.locationId,
      customer_id: customer.id,
      start_date: start,
      status: start > today ? 'PENDING' : 'ACTIVE',
      version: 1,
      created_at: this.iso().replace(/\.\d{3}Z$/, 'Z'),
      ...(input.card_id ? { card_id: input.card_id } : {}),
      timezone: input.timezone ?? this.timezone,
      source: { name: 'Oasis (simulator)' },
      plan_variation_id: variation.id,
    }
    this.subscriptions.set(id, s)
    this.actions.set(id, [])
    const created = this.now().getTime()
    this.billing.set(id, {
      nextBillAt: Math.max(created + this.firstInvoiceDelayMs, this.dateMs(start)),
      ...(UNDELIVERABLE.test(String(customer.email_address ?? '')) ? { deactivateAt: created + 1 } : {}),
    })
    this.emit('subscription.created', 'subscription', id, { subscription: s })
    return clone(s)
  }

  retrieveSubscription(id: string): { subscription: Obj; actions: Obj[] } {
    return { subscription: clone(this.get(this.subscriptions, id, 'Subscription')), actions: clone(this.actions.get(id) ?? []) }
  }

  searchSubscriptions(filter: { customer_ids?: string[]; location_ids?: string[] }): Obj[] {
    return [...this.subscriptions.values()]
      .filter((s) => !filter.customer_ids?.length || filter.customer_ids.includes(String(s.customer_id)))
      .filter((s) => !filter.location_ids?.length || filter.location_ids.includes(String(s.location_id)))
      .map(clone)
  }

  updateSubscription(id: string, patch: Obj): Obj {
    const s = this.get(this.subscriptions, id, 'Subscription')
    if (patch.card_id !== undefined) {
      const card = this.get(this.cards, String(patch.card_id), 'Card')
      if (card.customer_id !== s.customer_id) throw new SimError(400, 'INVALID_REQUEST_ERROR', 'INVALID_CARD', 'The card must belong to the customer.')
      s.card_id = patch.card_id
    }
    s.version = Number(s.version) + 1
    this.emit('subscription.updated', 'subscription', id, { subscription: s })
    // a new card on a subscription with a failed invoice: Square tries the invoice again with it (sandbox finding, wave Q2b)
    if (patch.card_id !== undefined && this.cards.get(String(patch.card_id))?.enabled) {
      const open = (s.invoice_ids as string[] | undefined)?.map((x) => this.invoices.get(x)).find((x) => x?.status === 'SCHEDULED')
      if (open) this.payInvoice(String(open.id))
    }
    return clone(s)
  }

  private nextBillingDate(s: Obj): string {
    return String(s.charged_through_date ?? s.start_date)
  }

  private act(id: string, type: string, effective: string, extra: Obj = {}): Obj {
    const a = { id: randomUUID(), type, effective_date: effective, ...extra }
    this.actions.get(id)!.push(a)
    return a
  }

  pauseSubscription(id: string, input: Obj): { subscription: Obj; actions: Obj[] } {
    const s = this.get(this.subscriptions, id, 'Subscription')
    if (s.status !== 'ACTIVE') throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', `The provided subscription \`${id}\` must have a \`ACTIVE\` state to pause.`)
    if (this.actions.get(id)!.some((a) => a.type === 'PAUSE'))
      throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', `The provided subscription \`${id}\` already has a pending pause.`)
    const at = String(input.pause_effective_date ?? this.nextBillingDate(s))
    const out = [this.act(id, 'PAUSE', at)]
    if (input.pause_cycle_duration) {
      const resumeAt = DateTime.fromISO(at).plus({ months: Number(input.pause_cycle_duration) }).toFormat('yyyy-MM-dd')
      out.push(this.act(id, 'RESUME', resumeAt))
    }
    this.emit('subscription.updated', 'subscription', id, { subscription: s })
    return { subscription: clone(s), actions: clone(out) }
  }

  resumeSubscription(id: string, input: Obj): { subscription: Obj; actions: Obj[] } {
    const s = this.get(this.subscriptions, id, 'Subscription')
    const pending = this.actions.get(id)!.find((a) => a.type === 'PAUSE')
    if (s.status !== 'PAUSED' && pending)
      throw new SimError(400, 'INVALID_REQUEST_ERROR', 'INVALID_DATE', `The subscription has a scheduled pause date of \`${String(pending.effective_date)}\`, a resume request must have a date after it.`)
    if (s.status !== 'PAUSED') throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', `The provided subscription \`${id}\` must have a \`PAUSED\` state to resume.`)
    const at = input.resume_change_timing === 'IMMEDIATE' || !input.resume_effective_date ? this.today() : String(input.resume_effective_date)
    this.actions.set(id, this.actions.get(id)!.filter((a) => a.type !== 'RESUME'))
    const a = this.act(id, 'RESUME', at)
    this.runActions(id)
    return { subscription: clone(s), actions: clone([a]) }
  }

  cancelSubscription(id: string): { subscription: Obj; actions: Obj[] } {
    const s = this.get(this.subscriptions, id, 'Subscription')
    if (s.status === 'CANCELED' || s.status === 'DEACTIVATED')
      throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', `The provided subscription \`${id}\` is already ${String(s.status)}.`)
    if (s.canceled_date)
      throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', `The provided subscription \`${id}\` already has a pending cancel date of \`${String(s.canceled_date)}\`.`)
    const at = s.charged_through_date ? String(s.charged_through_date) : this.today()
    s.canceled_date = at
    s.version = Number(s.version) + 1
    const a = this.act(id, 'CANCEL', at)
    this.emit('subscription.updated', 'subscription', id, { subscription: s })
    this.runActions(id)
    return { subscription: clone(s), actions: clone([a]) }
  }

  swapPlan(id: string, input: Obj): { subscription: Obj; actions: Obj[] } {
    const s = this.get(this.subscriptions, id, 'Subscription')
    if (s.status !== 'ACTIVE')
      throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', `The provided subscription \`${id}\` must have a \`ACTIVE\` state to swap the plan.`)
    const v = this.catalog.get(String(input.new_plan_variation_id ?? ''))
    if (!v || v.type !== 'SUBSCRIPTION_PLAN_VARIATION') throw new SimError(400, 'INVALID_REQUEST_ERROR', 'INVALID_VALUE', 'new_plan_variation_id must name a plan variation.')
    const lock = this.swapLockOf(s)
    if (lock.undone.has(String(v.id))) {
      lock.locked = true
      throw new SimError(500, 'API_ERROR', 'INTERNAL_SERVER_ERROR', `Subscription ${id} is locked and is not billable`)
    }
    const a = this.act(id, 'SWAP_PLAN', this.nextBillingDate(s), { new_plan_variation_id: v.id })
    this.emit('subscription.updated', 'subscription', id, { subscription: s })
    return { subscription: clone(s), actions: clone([a]) }
  }

  /** The swap lock of the subscription's current billing period (a new period starts a new one). */
  private swapLockOf(s: Obj): { period: string; undone: Set<string>; locked: boolean } {
    const period = this.nextBillingDate(s)
    let l = this.swapLocks.get(String(s.id))
    if (!l || l.period !== period) {
      l = { period, undone: new Set(), locked: false }
      this.swapLocks.set(String(s.id), l)
    }
    return l
  }

  bulkSwapPlan(input: Obj): number {
    this.assertLocation(input.location_id)
    let n = 0
    for (const s of this.subscriptions.values())
      if (s.plan_variation_id === input.old_plan_variation_id && s.status === 'ACTIVE') {
        this.act(String(s.id), 'SWAP_PLAN', this.nextBillingDate(s), { new_plan_variation_id: input.new_plan_variation_id })
        n++
      }
    return n
  }

  deleteAction(id: string, actionId: string): Obj {
    const s = this.get(this.subscriptions, id, 'Subscription')
    const list = this.actions.get(id) ?? []
    const a = list.find((x) => x.id === actionId)
    if (!a) throw new SimError(404, 'INVALID_REQUEST_ERROR', 'NOT_FOUND', `Action \`${actionId}\` not found.`)
    const lock = this.swapLockOf(s)
    if (lock.locked) throw new SimError(409, 'INVALID_REQUEST_ERROR', 'CONFLICT', `Unable to lock subscription ${id}`)
    if (a.type === 'SWAP_PLAN' && a.new_plan_variation_id) lock.undone.add(String(a.new_plan_variation_id))
    this.actions.set(id, list.filter((x) => x.id !== actionId))
    if (a.type === 'CANCEL') delete s.canceled_date
    s.version = Number(s.version) + 1
    this.emit('subscription.updated', 'subscription', id, { subscription: s })
    return clone(s)
  }

  /** Bills the next period now (controls): `paid` charges the card, `failed` leaves the invoice unpaid with a failed charge. */
  billNow(id: string, outcome: 'paid' | 'failed' = 'paid'): Obj {
    const s = this.get(this.subscriptions, id, 'Subscription')
    return this.bill(s, outcome)
  }

  private bill(s: Obj, outcome?: 'paid' | 'failed'): Obj {
    const id = String(s.id)
    const variation = this.catalog.get(String(s.plan_variation_id))
    const phase = ((variation?.subscription_plan_variation_data as Obj | undefined)?.phases as Obj[] | undefined)?.[0]
    const price = ((phase?.pricing as Obj | undefined)?.price_money as Money | undefined)?.amount ?? 0
    const start = this.nextBillingDate(s)
    const end = DateTime.fromISO(start).plus({ months: 1 }).toFormat('yyyy-MM-dd')
    const name = String((variation?.subscription_plan_variation_data as Obj | undefined)?.name ?? 'Subscription')
    const order = this.newOrder({ lines: [{ name, quantity: '1', base_price_money: usd(price) }], state: 'OPEN', owner: 'invoice', customer_id: s.customer_id })
    const invId = `inv:0-${rid(28)}`
    const inv: Obj = {
      id: invId,
      version: 1,
      location_id: this.locationId,
      order_id: order.id,
      payment_requests: [
        {
          uid: rid(22),
          request_type: 'BALANCE',
          due_date: start,
          tipping_enabled: false,
          computed_amount_money: usd(price),
          total_completed_amount_money: usd(0),
          automatic_payment_source: s.card_id ? 'CARD_ON_FILE' : 'NONE',
          ...(s.card_id ? { card_id: s.card_id } : {}),
        },
      ],
      primary_recipient: { customer_id: s.customer_id },
      invoice_number: String(this.invoices.size + 1).padStart(6, '0'),
      title: `${name} Subscription`,
      public_url: `https://app.squareupsandbox.com/pay-invoice/${invId}`,
      status: 'UNPAID',
      timezone: s.timezone,
      created_at: this.iso(),
      updated_at: this.iso(),
      delivery_method: 'EMAIL',
      subscription_id: id,
    }
    this.invoices.set(invId, inv)
    s.invoice_ids = [invId, ...((s.invoice_ids as string[] | undefined) ?? [])]
    s.monthly_billing_anchor_date ??= Number(start.slice(8, 10))
    this.emit('invoice.created', 'invoice', invId, { invoice: inv })
    this.emit('invoice.published', 'invoice', invId, { invoice: inv })
    const card = s.card_id ? this.cards.get(String(s.card_id)) : undefined
    const result = outcome ?? (card?.enabled ? 'paid' : card ? 'failed' : undefined)
    if (result === 'paid' && card) {
      this.chargeInvoice(inv, String(card.id))
      s.charged_through_date = end
      s.paid_until_date = end
    } else if (result === 'failed' || (result === 'paid' && !card)) {
      inv.status = 'SCHEDULED'
      this.emit('invoice.scheduled_charge_failed', 'invoice', invId, { invoice: inv })
      s.charged_through_date = end
    } else {
      // no card: the customer pays from the invoice email; the period is billed, the invoice waits
      s.charged_through_date = end
    }
    s.version = Number(s.version) + 1
    this.emit('subscription.updated', 'subscription', id, { subscription: s })
    const b = this.billing.get(id)
    if (b) b.nextBillAt = this.dateMs(end)
    return clone(inv)
  }

  private runActions(id: string): void {
    const s = this.subscriptions.get(id)
    if (!s) return
    const today = this.today()
    const due = (this.actions.get(id) ?? []).filter((a) => String(a.effective_date) <= today)
    if (!due.length) return
    for (const a of due) {
      if (a.type === 'PAUSE') s.status = 'PAUSED'
      else if (a.type === 'RESUME') s.status = 'ACTIVE'
      else if (a.type === 'CANCEL') s.status = 'CANCELED'
      else if (a.type === 'SWAP_PLAN') s.plan_variation_id = a.new_plan_variation_id
    }
    this.actions.set(id, (this.actions.get(id) ?? []).filter((a) => !due.includes(a)))
    s.version = Number(s.version) + 1
    this.emit('subscription.updated', 'subscription', id, { subscription: s })
  }

  // ---- invoices ----------------------------------------------------------------------------------------------------------------

  /** Pays an open subscription invoice with a saved card or a card nonce: the payment carries the invoice's order. */
  private chargeInvoice(inv: Obj, sourceId: string): Obj {
    const req = (inv.payment_requests as Obj[])[0]!
    const amount = (req.computed_amount_money as Money).amount
    const orderId = String(inv.order_id)
    this.orderOwner.set(orderId, 'payment')
    let payment: Obj
    try {
      payment = this.createPayment({
        source_id: sourceId,
        customer_id: (inv.primary_recipient as Obj).customer_id,
        order_id: orderId,
        amount_money: usd(amount),
        location_id: this.locationId,
        autocomplete: true,
      })
    } finally {
      this.orderOwner.set(orderId, 'invoice')
    }
    inv.status = 'PAID'
    req.total_completed_amount_money = usd(amount)
    inv.version = Number(inv.version) + 1
    inv.updated_at = this.iso()
    this.emit('invoice.payment_made', 'invoice', String(inv.id), { invoice: inv })
    return payment
  }

  /** The client pays a subscription invoice from its public page (controls), or Square's retry after a card update. */
  payInvoice(id: string, o: { nonce?: string } = {}): Obj {
    const inv = this.get(this.invoices, id, 'Invoice')
    if (!['UNPAID', 'SCHEDULED', 'PARTIALLY_PAID'].includes(String(inv.status)))
      throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', `Invoice \`${id}\` is ${String(inv.status)}.`)
    const sub = this.subscriptions.get(String(inv.subscription_id ?? ''))
    const source = o.nonce ?? (sub?.card_id ? String(sub.card_id) : '')
    if (!source) throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', 'No card to pay the invoice with.')
    this.chargeInvoice(inv, source)
    if (sub) {
      sub.paid_until_date = sub.charged_through_date
      sub.version = Number(sub.version) + 1
      this.emit('subscription.updated', 'subscription', String(sub.id), { subscription: sub })
    }
    return clone(inv)
  }

  /** CancelInvoice: an open invoice only (version must match); Square stops asking for it. */
  cancelInvoice(id: string, version: unknown): Obj {
    const inv = this.get(this.invoices, id, 'Invoice')
    if (version !== undefined && Number(version) !== Number(inv.version))
      throw new SimError(400, 'INVALID_REQUEST_ERROR', 'VERSION_MISMATCH', 'The invoice version does not match.')
    // the sandbox answers a canceled and a paid invoice alike (2026-10-12)
    if (!['UNPAID', 'SCHEDULED', 'PARTIALLY_PAID'].includes(String(inv.status)))
      throw new SimError(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST', 'Can only cancel an unpaid or scheduled invoice')
    inv.status = 'CANCELED'
    inv.version = Number(inv.version) + 1
    inv.updated_at = this.iso()
    this.emit('invoice.canceled', 'invoice', id, { invoice: inv })
    return clone(inv)
  }

  getInvoice(id: string): Obj {
    return clone(this.get(this.invoices, id, 'Invoice'))
  }

  searchInvoices(filter: { location_ids?: string[]; customer_ids?: string[] }): Obj[] {
    return [...this.invoices.values()]
      .filter((i) => !filter.location_ids?.length || filter.location_ids.includes(String(i.location_id)))
      .filter((i) => !filter.customer_ids?.length || filter.customer_ids.includes(String((i.primary_recipient as Obj).customer_id)))
      .map(clone)
  }

  // ---- events --------------------------------------------------------------------------------------------------------------------

  searchEvents(filter: { event_types?: string[]; location_ids?: string[]; merchant_ids?: string[]; start_at?: string; end_at?: string }): SimEventRecord[] {
    const start = filter.start_at ? Date.parse(filter.start_at) : -Infinity
    const end = filter.end_at ? Date.parse(filter.end_at) : Infinity
    return this.events
      .filter((e) => !filter.event_types?.length || filter.event_types.includes(e.type))
      .filter((e) => !filter.location_ids?.length || (e.location_id !== undefined && filter.location_ids.includes(e.location_id)))
      .filter((e) => !filter.merchant_ids?.length || filter.merchant_ids.includes(e.merchant_id))
      .filter((e) => {
        const t = Date.parse(e.created_at)
        return t >= start && t < end
      })
      .map(clone)
  }

  // ---- the clock -----------------------------------------------------------------------------------------------------------------

  /** Moves everything time drives up to now: refunds settle, subscriptions bill and deactivate, scheduled actions take effect. */
  tick(): void {
    const now = this.now().getTime()
    for (const r of this.refunds.values())
      if (r.status === 'PENDING' && Date.parse(String(r.created_at)) + this.refundDelayMs <= now) this.completeRefund(r)
    for (const s of this.subscriptions.values()) {
      const id = String(s.id)
      const b = this.billing.get(id)
      if (!b) continue
      if (b.deactivateAt !== undefined && b.deactivateAt <= now && s.status !== 'DEACTIVATED') {
        s.status = 'DEACTIVATED'
        s.monthly_billing_anchor_date ??= Number(String(s.start_date).slice(8, 10))
        this.emit('subscription.updated', 'subscription', id, { subscription: s })
        continue
      }
      if (s.status === 'PENDING' && this.dateMs(String(s.start_date)) <= now) s.status = 'ACTIVE'
      this.runActions(id)
      for (let guard = 0; guard < 24 && s.status === 'ACTIVE' && b.nextBillAt <= now; guard++) this.bill(s)
    }
  }

  advance(ms: number): void {
    this.offsetMs += ms
    this.tick()
  }
}

function pick(o: Obj, keys: string[]): Obj {
  const out: Obj = {}
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k]
  return out
}

function moneyIn(m: unknown, field: string): number {
  const v = m as Money | undefined
  if (!v || typeof v.amount !== 'number' || !Number.isInteger(v.amount) || v.amount < 0)
    throw new SimError(400, 'INVALID_REQUEST_ERROR', 'INVALID_VALUE', `${field}.amount must be a non-negative integer.`)
  if (v.currency !== 'USD') throw new SimError(400, 'INVALID_REQUEST_ERROR', 'UNSUPPORTED_CURRENCY', `${field}.currency must be USD.`)
  return v.amount
}
