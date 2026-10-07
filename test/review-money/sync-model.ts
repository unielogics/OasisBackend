// Randomized interleavings of the counter (staff record card money and refunds in Oasis) with Squarespace (orders, payments,
// refunds on the simulator), the poll, the webhook and the manual queue, checked against a ground truth that the generator keeps:
// every real Squarespace payment or refund may appear in the Oasis ledger at most once.
import { sql } from 'kysely'
import { expect } from 'vitest'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { PaymentsService } from '../../src/modules/payments/commands.js'
import { defaultPorts } from '../../src/modules/payments/ports.js'
import { SqspLedgerOps } from '../../src/modules/payments-sync/db/ledger.js'
import { listOrders, manualIgnore, manualMatch } from '../../src/modules/payments-sync/db/manual.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { makeCustomer, makeInvoice, setupEnv, type Env, type MadeInvoice } from '../payments/helpers.js'
import { H, D, type Rig } from '../payments-sync-db/harness.js'
import { ctxFor, makeUser, stubActor, type StubUser } from './helpers.js'
import { rng, STRICT } from './model.js'

interface Cust {
  customerId: string
  email: string
  phone: string
  inv: MadeInvoice
  total: number
  items: number
  tax: number
  realPayments: Array<{ orderId: string; paymentId: string; amount: number }>
  strayStaff: number
  refundPairs: Array<{ staffEventId: string | null; sqspRefundId: string | null; orderId: string; amount: number; approvedAt: number | null }>
}

export class SyncModel {
  readonly trace: string[] = []
  private readonly r: () => number
  private env!: Env
  private custs: Cust[] = []
  private service!: PaymentsService
  private sofia!: { u: StubUser; limit: number | null }
  private rafael!: { u: StubUser; limit: number | null }
  private errors: string[] = []

  constructor(
    private readonly rig: () => Rig,
    readonly seed: number,
  ) {
    this.r = rng(seed)
  }

  private get R(): Rig {
    return this.rig()
  }
  private int(lo: number, hi: number): number {
    return lo + Math.floor(this.r() * (hi - lo + 1))
  }
  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)]!
  }
  private chance(p: number): boolean {
    return this.r() < p
  }
  private log(s: string): void {
    this.trace.push(s)
  }
  private fail(msg: string): never {
    throw new Error(`${msg}\nseed=${this.seed}\n${this.trace.slice(-30).join('\n')}`)
  }

  async setup(): Promise<void> {
    const r = this.R
    this.env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [{ sku: 'DET', kind: 'service' }]),
    )
    this.service = new PaymentsService({ clock: r.clock, newId: r.newId, ports: defaultPorts() })
    this.sofia = { u: await makeUser(r.db, r.newId, 'Sofia'), limit: 5000 }
    this.rafael = { u: await makeUser(r.db, r.newId, 'Rafael'), limit: null }
    for (let i = 0; i < 4; i++) {
      const email = `cust${i}@example.com`
      const phone = `30555501${String(40 + i).padStart(2, '0')}`
      const customerId = await makeCustomer(r.db, this.env, { name: `Cust ${i} Test`, email, phone: `+1${phone}` })
      const items = this.int(80, 400) * 100 + this.pick([0, 0, 50, 99])
      const inv = await makeInvoice(r.db, this.env, { customerId, items: [{ name: 'Full Detail', priceCents: items }] })
      const tax = Number((2n * BigInt(items) * 700n + 10_000n) / 20_000n)
      this.custs.push({ customerId, email, phone, inv, total: items + tax, items, tax, realPayments: [], strayStaff: 0, refundPairs: [] })
    }
  }

  private actor(who: 'sofia' | 'rafael') {
    const a = who === 'sofia' ? this.sofia : this.rafael
    return stubActor(a.u, { refund: a.limit, adjust: a.limit, credit: a.limit })
  }

  private tick(ms: number): void {
    this.R.clock.advance(ms)
  }

  // --- counter actions ---------------------------------------------------------------------------------------------

  private async staffCollect(c: Cust): Promise<string | null> {
    try {
      const out = await transaction(this.R.db, (tx) =>
        this.service.collect(tx, ctxFor(this.R.locationId, this.actor('rafael')), c.inv.id, { method: 'card' }),
      )
      return 'event' in out ? out.event.id : null
    } catch (e) {
      if ((e as { code?: string }).code === 'PAY_NOTHING_TO_COLLECT') return null
      throw e
    }
  }

  private newOrder(c: Cust, o: { paid: boolean }): { orderId: string; paymentId?: string; amount: number } {
    const taxSq = this.chance(0.85) ? c.tax : c.tax + this.pick([-300, -2, 1, 2, 500])
    const res = this.R.store.createOrder({
      email: c.email,
      name: 'Cust Test',
      phone: c.phone,
      lineItems: [{ productId: 'p', sku: 'DET', name: 'Full Detail', unitCents: c.items }],
      taxCents: taxSq,
      pay: o.paid ? undefined : false,
    })
    return { ...res, amount: c.items + taxSq }
  }

  private async cycle(): Promise<void> {
    this.tick(2 * 60_000)
    // overlapping runs (webhook job + poll, two polls, a cashier tapping Collect mid-run) are what defects 5 and 13 are about:
    // they run unless RV_LEGACY=1, which relaxes the model for the code before the fixes
    const how = this.pick(STRICT ? (['cycle', 'cycle', 'two', 'webhook', 'collect-race'] as const) : (['cycle'] as const))
    const c = this.pick(this.custs)
    const loc = this.R.locationId
    if (how === 'cycle') await this.R.rt.syncCycle(loc)
    else if (how === 'two') await Promise.all([this.R.rt.syncCycle(loc), this.R.rt.syncCycle(loc)])
    else if (how === 'webhook') {
      const o = c.realPayments[0]
      await Promise.all([this.R.rt.syncCycle(loc), o ? this.R.rt.ingestOrder(loc, o.orderId) : Promise.resolve(undefined)])
    } else if (c.realPayments.length === 0 && c.strayStaff === 0) {
      // the cashier taps Collect while the poll is running; with no real payment behind it, it is a stray record
      const [, ev] = await Promise.all([this.R.rt.syncCycle(loc), this.staffCollect(c)])
      if (ev) c.strayStaff++
    } else await this.R.rt.syncCycle(loc)
    this.log(`cycle ${how}`)
  }

  async step(): Promise<void> {
    const act = this.pick([
      'counter-staff-first',
      'counter-order-first',
      'counter-order-first',
      'link-payment',
      'stray',
      'refund-pair',
      'refund-pair',
      'cycle',
      'cycle',
      'cycle',
      'clock',
      'manual',
      'void-awaiting',
    ] as const)
    const c = this.pick(this.custs)
    this.log(`-- ${act} cust=${this.custs.indexOf(c)}`)
    switch (act) {
      case 'counter-staff-first': {
        if (c.realPayments.length > 0 || c.strayStaff > 0) break
        const ev = await this.staffCollect(c)
        this.log(`staff collect -> ${ev?.slice(-6)}`)
        if (this.chance(0.5)) await this.cycle()
        this.tick(this.pick([30_000, 5 * 60_000, 3 * H]))
        const o = this.newOrder(c, { paid: true })
        c.realPayments.push({ orderId: o.orderId, paymentId: o.paymentId!, amount: o.amount })
        break
      }
      case 'counter-order-first': {
        if (c.realPayments.length > 0 || c.strayStaff > 0) break
        const o = this.newOrder(c, { paid: true })
        c.realPayments.push({ orderId: o.orderId, paymentId: o.paymentId!, amount: o.amount })
        if (this.chance(0.7)) await this.cycle()
        this.tick(this.pick([30_000, 5 * 60_000, 3 * H, 30 * H]))
        const ev = await this.staffCollect(c)
        this.log(`staff collect after the order -> ${ev?.slice(-6)}`)
        break
      }
      case 'link-payment': {
        if (c.realPayments.length > 0 || c.strayStaff > 0) break
        await transaction(this.R.db, (tx) =>
          this.service.attachPaymentLink(tx, ctxFor(this.R.locationId, this.actor('rafael')), c.inv.id, {
            kind: 'balance',
            url: 'https://oasis-auto-spa.squarespace.com/checkout/x',
          }),
        )
        this.tick(60_000)
        const o = this.newOrder(c, { paid: true })
        c.realPayments.push({ orderId: o.orderId, paymentId: o.paymentId!, amount: o.amount })
        if (this.chance(0.5)) await this.staffCollect(c)
        break
      }
      case 'stray': {
        if (c.realPayments.length > 0 || c.strayStaff > 0) break
        const ev = await this.staffCollect(c)
        if (ev) c.strayStaff++
        break
      }
      case 'void-awaiting': {
        const e = await this.R.db
          .selectFrom('ledger_events')
          .select('id')
          .where('invoice_id', '=', c.inv.id)
          .where('type', '=', 'pay')
          .where('processor_state', '=', 'awaiting_processor')
          .where((eb) => eb.not(eb.exists(eb.selectFrom('ledger_events as v').select('v.id').whereRef('v.voids_event_id', '=', 'ledger_events.id'))))
          .executeTakeFirst()
        if (!e) break
        const voided = await transaction(this.R.db, (tx) =>
          this.service.voidPayment(tx, ctxFor(this.R.locationId, this.actor('rafael')), c.inv.id, { eventId: e.id }),
        ).then(
          () => true,
          () => false,
        )
        if (voided && c.strayStaff > 0) c.strayStaff--
        this.log(`void awaiting -> ${voided}`)
        break
      }
      case 'refund-pair': {
        const pay = c.realPayments.find((p) => p.amount > 0)
        if (!pay) break
        const already = c.refundPairs.reduce((a, p) => a + p.amount, 0)
        const left = pay.amount - already
        if (left < 100) break
        const amount = this.pick([Math.floor(left / 3), Math.floor(left / 2), left, 4000, 6000])
        if (amount < 100 || amount > left) break
        const who = this.pick(['sofia', 'rafael'] as const)
        let staffEventId: string | null = null
        try {
          const res = await transaction(this.R.db, (tx) =>
            this.service.refund(tx, ctxFor(this.R.locationId, this.actor(who)), c.inv.id, { mode: 'custom', amountCents: amount, dest: 'card' }),
          )
          staffEventId = res.event.id
          this.log(`staff refund ${amount} by ${who} -> ${res.event.status}`)
        } catch (e) {
          this.log(`staff refund ${amount} refused ${(e as { code?: string }).code}`)
          break
        }
        const pair: Cust['refundPairs'][number] = { staffEventId, sqspRefundId: null, orderId: pay.orderId, amount, approvedAt: null }
        c.refundPairs.push(pair)
        await this.finishRefund(c, pair)
        break
      }
      case 'cycle':
        await this.cycle()
        break
      case 'clock':
        this.tick(this.pick([H, 10 * H, 49 * H, 80 * H, 5 * D]))
        this.log(`clock -> ${this.R.clock.now().toISOString()}`)
        break
      case 'manual':
        await this.manual()
        break
    }
    await this.checkInvariants()
  }

  /** Approve a pending staff refund after a random delay and perform the refund in Squarespace at a random moment. */
  private async finishRefund(c: Cust, pair: Cust['refundPairs'][number]): Promise<void> {
    const ev = await this.R.db.selectFrom('ledger_events').select('status').where('id', '=', pair.staffEventId!).executeTakeFirstOrThrow()
    const sqspFirst = this.chance(0.2)
    const doSqsp = () => {
      pair.sqspRefundId = this.R.store.refund(pair.orderId, { amountCents: pair.amount, refundedOn: this.R.clock.now() })
      this.log(`squarespace refund ${pair.amount}`)
    }
    if (sqspFirst) doSqsp()
    if (ev.status === 'pending') {
      // beyond 48 h the staff refund no longer pairs with the feed (reported defect 4), so only strict mode waits that long
      const wait = this.pick(STRICT ? [10 * 60_000, 5 * H, 30 * H, 72 * H] : [10 * 60_000, 5 * H, 30 * H])
      this.tick(wait)
      this.log(`approval after ${wait / H} h`)
      await transaction(this.R.db, (tx) =>
        this.service.approveRefund(tx, ctxFor(this.R.locationId, this.actor('rafael')), c.inv.id, pair.staffEventId!),
      )
      pair.approvedAt = this.R.clock.now().getTime()
      this.log('approved')
    }
    if (!sqspFirst) {
      this.tick(this.pick([60_000, 10 * 60_000, 2 * H]))
      doSqsp()
    }
    if (this.chance(0.7)) await this.cycle()
  }

  /** Staff work the manual queue: match to the customer's invoice (or the waiting event), or ignore. */
  private async manual(): Promise<void> {
    const page = await listOrders(this.R.db, this.R.locationId, { state: 'unmatched', limit: 20 })
    const item = page.items.find((o) => o.queue.length > 0)
    if (!item) return
    const c = this.custs.find((x) => x.realPayments.some((p) => p.orderId === item.sqspOrderId))
    const deps = { locationId: this.R.locationId, clock: this.R.clock, newId: this.R.newId, ops: new SqspLedgerOps({ locationId: this.R.locationId, clock: this.R.clock, newId: this.R.newId }), varianceAlertCents: 100 }
    const actor = { userId: this.rafael.u.userId, employeeId: this.rafael.u.employeeId, name: this.rafael.u.name }
    try {
      if (!c || this.chance(0.2)) {
        await transaction(this.R.db, (tx) => manualIgnore(tx, deps, { orderId: item.sqspOrderId }, actor))
        this.log(`manual ignore ${item.sqspOrderId.slice(-6)}`)
      } else {
        const waiting = await this.R.db
          .selectFrom('ledger_events')
          .select('id')
          .where('invoice_id', '=', c.inv.id)
          .where('processor_state', '=', 'awaiting_processor')
          .executeTakeFirst()
        // matching a refund to the invoice (instead of to the waiting event) has no duplicate guard: reported defect 10
        const hasRefund = item.transactions.some((t) => t.kind === 'refund' && t.state !== 'matched')
        // a manual match also books every refund of the order as an external one, with no duplicate guard: defect 10
        if (hasRefund && !STRICT) return
        const byEvent = waiting && this.chance(0.5)
        await transaction(this.R.db, (tx) =>
          manualMatch(tx, deps, byEvent ? { orderId: item.sqspOrderId, eventId: waiting!.id } : { orderId: item.sqspOrderId, invoiceId: c.inv.id }, actor),
        )
        this.log(`manual match ${item.sqspOrderId.slice(-6)}`)
      }
    } catch (e) {
      this.log(`manual refused ${(e as { code?: string }).code ?? (e as Error).message}`)
    }
  }

  // --- invariants --------------------------------------------------------------------------------------------------

  async checkInvariants(): Promise<void> {
    const db = this.R.db
    // a Squarespace payment or refund id appears on at most one ledger event
    const dup = await sql<{ ref: string; n: number }>`
      select processor_ref as ref, count(*)::int as n from ledger_events
      where processor_ref is not null and not exists (select 1 from ledger_events v where v.voids_event_id = ledger_events.id)
      group by processor_ref having count(*) > 1`.execute(db)
    if (dup.rows.length) this.fail(`processor reference used twice: ${JSON.stringify(dup.rows)}`)

    for (const [i, c] of this.custs.entries()) {
      const evs = (
        await sql<{
          id: string
          type: string
          amount_cents: number
          status: string
          source: string
          method_kind: string | null
          processor_state: string
          processor_ref: string | null
          sqsp_order_id: string | null
          dest: string | null
          occurred_at: Date
        }>`select id, type, amount_cents, status, source, method_kind, processor_state, processor_ref, sqsp_order_id, dest, occurred_at
           from ledger_events e where invoice_id = ${c.inv.id}
             and not exists (select 1 from ledger_events v where v.voids_event_id = e.id) order by seq`.execute(db)
      ).rows
      const cardPays = evs.filter((e) => e.type === 'pay' && (e.method_kind === 'card' || e.method_kind === 'apple_pay'))
      const realTotal = c.realPayments.reduce((a, p) => a + p.amount, 0)
      const paid = cardPays.reduce((a, e) => a + e.amount_cents, 0)
      if (cardPays.length > c.realPayments.length + c.strayStaff)
        this.fail(`cust ${i}: ${cardPays.length} card payments in the ledger for ${c.realPayments.length} real payment(s) and ${c.strayStaff} stray staff record(s)\n${JSON.stringify(cardPays)}`)
      void paid
      void realTotal
      // every real refund is on the ledger at most once, counting the staff record of it and the sync's copy together
      for (const p of c.refundPairs) {
        if (!p.sqspRefundId) continue
        const copies = evs.filter(
          (e) => e.type === 'refund' && e.status !== 'denied' && (e.id === p.staffEventId || e.processor_ref === p.sqspRefundId),
        )
        if (copies.length > 1) {
          const matches = await sql`select kind, rule, sqsp_txn_id, event_id, manual, created_at from sqsp_matches where sqsp_order_id = ${p.orderId} order by created_at, id`.execute(db)
          const queue = await sql`select reason, state, sqsp_txn_id, created_at from sqsp_manual_queue where sqsp_order_id = ${p.orderId} order by created_at`.execute(db)
          const allRefunds = evs.filter((e) => e.type === 'refund')
          this.log(`DEBUG matches=${JSON.stringify(matches.rows)} queue=${JSON.stringify(queue.rows)} refunds=${JSON.stringify(allRefunds)}`)
        }
        if (copies.length > 1)
          this.fail(`cust ${i}: the ${p.amount} refund (staff event ${p.staffEventId?.slice(-6)}, squarespace refund ${p.sqspRefundId.slice(-6)}) is on the ledger ${copies.length} times\n${JSON.stringify(copies)}`)
      }
      const refunded = evs.filter((e) => e.type === 'refund' && e.status === 'done').reduce((a, e) => a + e.amount_cents, 0)
      const intended = c.refundPairs.reduce((a, p) => a + p.amount, 0)
      if (refunded > intended) this.fail(`cust ${i}: refunded ${refunded} on the ledger but only ${intended} intended/real`)
    }
  }

  async errorsSeen(): Promise<string[]> {
    return this.errors
  }
}

export { expect }
