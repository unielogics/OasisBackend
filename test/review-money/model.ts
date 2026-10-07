// A randomized model of the Payments commands over HTTP + Postgres, checked against the independent oracle (oracle.ts) after
// every step. Used by 90-model-based.test.ts; failures print the seed and the command trace so they can be replayed.
import { sql } from 'kysely'
import { DateTime } from 'luxon'
import { expect } from 'vitest'
import { createInvoiceGateway } from '../../src/modules/payments/gateway.js'
import { ledgerRevenueSource } from '../../src/modules/payments/revenue.js'
import { transaction } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { makeAppointment, makeService } from '../domain-schema/helpers.js'
import { makeCustomer, makeInvoice } from '../payments/helpers.js'
import { freshKey, type PayHarness, type Person } from './pay-harness.js'
import { creditOracle, oracleCalc, type Alloc, type Ev, type OracleCalc } from './oracle.js'

export type Who = 'rafael' | 'sofia' | 'amara' | 'daniel' | 'kevin'
export const WHO: readonly Who[] = ['rafael', 'sofia', 'amara', 'daniel', 'kevin']

/**
 * The model asserts the corrected behaviour (the fixes on rv/money). RV_LEGACY=1 relaxes the expectations that the reported
 * defects 1, 2, 3, 5, 7, 10 and 13 break, to run it against the code before the fixes.
 */
export const STRICT = process.env.RV_LEGACY !== '1'

export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Caller {
  canCollect: boolean
  canRefund: boolean
  canAdjust: boolean
  canCredit: boolean
  canVoid: boolean
  refundLimitCents: number | null
  adjustLimitCents: number | null
  creditLimitCents: number | null
}

interface InvRef {
  id: string
  customerId: string
  appointmentId: string
  taxBp: number
}

interface Row {
  inv: {
    id: string
    customer_id: string
    tax_bp: number
    tip_cents: number
    canceled_at: Date | null
    appointment_id: string | null
  }
  prices: number[]
  itemIds: string[]
  itemPrice: Map<string, number>
  evs: Ev[]
}

const IMMUTABLE_COLS = [
  'id',
  'seq',
  'invoice_id',
  'customer_id',
  'type',
  'amount_cents',
  'method',
  'method_kind',
  'dest',
  'reason',
  'occurred_at',
  'source',
  'voids_event_id',
  'parent_event_id',
  'idempotency_key',
  'actor_user_id',
  'expires_at',
]

export class Model {
  readonly trace: string[] = []
  private readonly r: () => number
  private invs: InvRef[] = []
  private callers = new Map<Who, Caller>()
  private snapshot = new Map<string, string>()
  private statusSeen = new Map<string, { processor: string; status: string }>()
  private people: Record<Who, Person>
  private gw: ReturnType<typeof createInvoiceGateway>
  private userOf = new Map<string, Who>()

  constructor(
    private readonly p: PayHarness,
    readonly seed: number,
  ) {
    this.r = rng(seed)
    this.gw = createInvoiceGateway({ clock: p.h.t.clock, newId: p.env().newId })
    this.people = p.people() as Record<Who, Person>
    for (const w of WHO) this.userOf.set(this.people[w].user.userId, w)
  }

  private get db() {
    return this.p.h.t.db
  }
  private get clock() {
    return this.p.h.t.clock
  }
  private int(lo: number, hi: number): number {
    return lo + Math.floor(this.r() * (hi - lo + 1))
  }
  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.r() * xs.length)]!
  }
  private pickWho(): Who {
    const x = this.r()
    return x < 0.3 ? 'rafael' : x < 0.62 ? 'sofia' : x < 0.8 ? 'amara' : x < 0.95 ? 'daniel' : 'kevin'
  }
  private chance(p: number): boolean {
    return this.r() < p
  }
  private log(s: string): void {
    this.trace.push(s)
  }
  private fail(msg: string): never {
    throw new Error(`${msg}\nseed=${this.seed}\n${this.trace.slice(-25).join('\n')}`)
  }

  // --- world -------------------------------------------------------------------------------------------------------

  async setup(): Promise<void> {
    const env = this.p.env()
    const f = { location: env.location, locationId: env.locationId, newId: env.newId }
    const serviceId = await makeService(this.db, f, { kind: 'package', name: 'Model Wash', priceCents: 4500 })
    const custA = await makeCustomer(this.db, env, { name: 'Model Alice' })
    const custB = await makeCustomer(this.db, env, { name: 'Model Bob' })
    const plan: Array<[string, string]> = [
      ['a1', custA],
      ['a2', custA],
      ['b1', custB],
    ]
    for (const [, customerId] of plan) {
      const taxBp = this.pick([700, 700, 825, 1000, 0, 625])
      const lines = this.int(1, 3)
      const items = Array.from({ length: lines }, (_, i) => ({
        name: `Line ${i}`,
        priceCents: this.int(1, 600) * this.pick([1, 7, 25, 100]),
        kind: i === 0 ? ('package' as const) : ('addon' as const),
      }))
      const inv = await makeInvoice(this.db, env, { customerId, items, taxBp, tipCents: this.chance(0.3) ? this.int(0, 3000) : 0 })
      const appointmentId = await makeAppointment(this.db, f, {
        customerId,
        serviceId,
        start: new Date('2026-06-13T10:30:00-04:00'),
      })
      await this.db.updateTable('invoices').set({ appointment_id: appointmentId }).where('id', '=', inv.id).execute()
      this.invs.push({ id: inv.id, customerId, appointmentId, taxBp })
    }
    for (const w of WHO) {
      const d = await this.p.get(this.people[w], 'me')
      expect(d.statusCode).toBe(200)
      const me = d.json() as { permissions: Record<string, { on: boolean; limit?: number | null }> }
      const on = (k: string): boolean => me.permissions[k]?.on === true
      const lim = (k: string): number | null => (on(k) ? (me.permissions[k]!.limit === undefined ? 2500 : me.permissions[k]!.limit!) : 0)
      this.callers.set(w, {
        canCollect: on('pay.collect'),
        canRefund: on('pay.refund'),
        canAdjust: on('pay.adjust'),
        canCredit: on('pay.credit'),
        canVoid: on('pay.void'),
        refundLimitCents: lim('pay.refund'),
        adjustLimitCents: lim('pay.adjust'),
        creditLimitCents: lim('pay.credit'),
      })
    }
    await this.snapshotLedger()
  }

  private can(w: Who, k: 'canCollect' | 'canRefund' | 'canAdjust' | 'canCredit' | 'canVoid'): boolean {
    return this.callers.get(w)![k]
  }
  private limit(w: Who, k: 'refund' | 'adjust' | 'credit'): number | null {
    const c = this.callers.get(w)!
    return k === 'refund' ? c.refundLimitCents : k === 'adjust' ? c.adjustLimitCents : c.creditLimitCents
  }

  callerTable(): Record<string, Caller> {
    return Object.fromEntries([...this.callers.entries()])
  }

  // --- reading state -----------------------------------------------------------------------------------------------

  private async load(invId: string): Promise<Row> {
    const inv = await this.db.selectFrom('invoices').selectAll().where('id', '=', invId).executeTakeFirstOrThrow()
    const items = await this.db.selectFrom('invoice_items').selectAll().where('invoice_id', '=', invId).orderBy('position').execute()
    const evs = (await sql<Ev>`select * from ledger_events where invoice_id = ${invId} order by seq`.execute(this.db)).rows
    return {
      inv,
      prices: items.map((i) => i.price_cents),
      itemIds: items.map((i) => i.id),
      itemPrice: new Map(items.map((i) => [i.id, i.price_cents])),
      evs: evs.map((e) => ({ ...e, seq: Number(e.seq) })),
    }
  }

  /**
   * What can still go back to the original payment methods: non-credit payments (voids out) less the card and cash refunds paid
   * or waiting for approval; to card, further capped by the card and wallet payments less the card refunds.
   */
  private origCap(row: Row, dest: 'card' | 'cash', exceptEvent?: string): number {
    let orig = 0
    let card = 0
    for (const e of row.evs) {
      const isCard = e.method_kind === 'card' || e.method_kind === 'apple_pay'
      if (e.type === 'pay') {
        orig += e.amount_cents
        if (isCard) card += e.amount_cents
      } else if (e.type === 'void') {
        orig -= e.amount_cents
        if (isCard) card -= e.amount_cents
      } else if (e.type === 'refund' && (e.status === 'done' || e.status === 'pending') && e.id !== exceptEvent && e.dest !== 'credit') {
        orig -= e.amount_cents
        if (e.dest === 'card') card -= e.amount_cents
      }
    }
    return Math.max(0, dest === 'card' ? Math.min(orig, card) : orig)
  }

  /** The cap a refund to this destination must respect (none for store credit). */
  private capOf(row: Row, oc: OracleCalc, dest: 'card' | 'cash' | 'credit', exceptEvent?: string): number {
    if (dest === 'credit') return Number.POSITIVE_INFINITY
    if (!STRICT) return dest === 'card' ? oc.toOrigMax : Number.POSITIVE_INFINITY
    return this.origCap(row, dest, exceptEvent)
  }

  private oc(row: Row): OracleCalc {
    return oracleCalc({ tax_bp: row.inv.tax_bp, tip_cents: row.inv.tip_cents, canceled: row.inv.canceled_at !== null }, row.prices, row.evs)
  }

  private async customerEvents(customerId: string): Promise<{ evs: Ev[]; allocs: Alloc[] }> {
    const evs = (await sql<Ev>`select * from ledger_events where customer_id = ${customerId} order by seq`.execute(this.db)).rows.map((e) => ({
      ...e,
      seq: Number(e.seq),
    }))
    const allocs = (await sql<Alloc>`select apply_event_id, lot_event_id, cents from credit_allocations where customer_id = ${customerId}`.execute(this.db)).rows
    return { evs, allocs }
  }

  private async creditBalance(customerId: string): Promise<number> {
    const { evs, allocs } = await this.customerEvents(customerId)
    return creditOracle(evs, allocs, this.clock.now()).balance
  }

  // --- the steps ---------------------------------------------------------------------------------------------------

  async step(): Promise<void> {
    const w = this.pick<string>([
      'collect',
      'collect',
      'collect',
      'credit-apply',
      'credit-apply',
      'refund',
      'refund',
      'refund',
      'approve',
      'approve',
      'deny',
      'adjust',
      'adjust',
      'issue-credit',
      'issue-credit',
      'void',
      'confirm',
      'tip',
      'items',
      'clock',
      'cancel',
      'race',
      'race',
      'replay',
    ])
    this.log(`-- ${w}`)
    // every step happens at its own instant, so ledger order and timestamps agree for the credit replay
    this.clock.advance(1000)
    switch (w) {
      case 'collect':
        await this.collect()
        break
      case 'credit-apply':
        await this.applyCredit()
        break
      case 'refund':
        await this.refund()
        break
      case 'approve':
        await this.approve()
        break
      case 'deny':
        await this.deny()
        break
      case 'adjust':
        await this.adjust()
        break
      case 'issue-credit':
        await this.issueCredit()
        break
      case 'void':
        await this.voidStep()
        break
      case 'confirm':
        await this.confirm()
        break
      case 'tip':
        await this.tip()
        break
      case 'items':
        await this.items()
        break
      case 'clock':
        await this.advanceClock()
        break
      case 'cancel':
        if (this.chance(0.25)) await this.cancel()
        break
      case 'race':
        await this.race()
        break
      case 'replay':
        await this.replay()
        break
    }
    await this.checkInvariants()
  }

  private anInvoice(): InvRef {
    return this.pick(this.invs)
  }

  private expectStatus(res: { statusCode: number; body: string }, want: number | number[], what: string): void {
    const ok = Array.isArray(want) ? want.includes(res.statusCode) : res.statusCode === want
    if (!ok) this.fail(`${what}: expected ${JSON.stringify(want)}, got ${res.statusCode} ${res.body.slice(0, 300)}`)
  }

  private async collect(): Promise<void> {
    const inv = this.anInvoice()
    const who = this.pickWho()
    const method = this.pick(['card', 'cash'] as const)
    const row = await this.load(inv.id)
    const oc = this.oc(row)
    const before = row.evs.length
    const res = await this.p.send(this.people[who], 'POST', `invoices/${inv.id}/payments`, { method })
    this.log(`collect ${who} ${method} inv=${inv.id.slice(-6)} balance=${oc.balance} -> ${res.statusCode}`)
    if (!this.can(who, 'canCollect')) return this.expectStatus(res, 403, 'collect without pay.collect')
    if (oc.balance <= 0) {
      this.expectStatus(res, 422, 'collect with nothing owed')
      expect((await this.load(inv.id)).evs.length).toBe(before)
      return
    }
    this.expectStatus(res, 201, 'collect')
    const after = await this.load(inv.id)
    const ev = after.evs[after.evs.length - 1]!
    expect(ev.type).toBe('pay')
    expect(ev.amount_cents).toBe(oc.balance)
    expect(ev.processor_state).toBe(method === 'card' ? 'awaiting_processor' : 'na')
  }

  private async applyCredit(): Promise<void> {
    const inv = this.anInvoice()
    const who = this.pickWho()
    const row = await this.load(inv.id)
    const oc = this.oc(row)
    const bal = await this.creditBalance(inv.customerId)
    const res = await this.p.send(this.people[who], 'POST', `invoices/${inv.id}/credit-applications`, {})
    this.log(`credit-apply ${who} inv=${inv.id.slice(-6)} balance=${oc.balance} credit=${bal} -> ${res.statusCode}`)
    if (!this.can(who, 'canCollect')) return this.expectStatus(res, 403, 'credit-apply without pay.collect')
    const use = Math.min(bal, oc.balance)
    if (use <= 0) return this.expectStatus(res, 422, 'credit-apply with nothing to apply')
    this.expectStatus(res, 201, 'credit-apply')
    const after = await this.load(inv.id)
    expect(after.evs[after.evs.length - 1]).toMatchObject({ type: 'credit_apply', amount_cents: use })
  }

  private claimedItems(row: Row): Set<string> {
    return new Set(row.evs.filter((e) => e.type === 'refund' && e.status !== 'denied').flatMap((e) => e.item_ids))
  }

  private async refund(): Promise<void> {
    const inv = this.anInvoice()
    const who = this.pickWho()
    const row = await this.load(inv.id)
    const oc = this.oc(row)
    const dest = this.pick(['card', 'credit', 'cash'] as const)
    const mode = this.pick(['full', 'custom', 'custom', 'items'] as const)
    const lim = this.limit(who, 'refund')
    let body: Record<string, unknown>
    let val: number
    const claimed = this.claimedItems(row)
    let itemsClaimed = false
    if (mode === 'full') {
      body = { mode, dest }
      val = oc.refundable
    } else if (mode === 'items') {
      const ids = row.itemIds.filter(() => this.chance(0.6))
      if (ids.length === 0) ids.push(row.itemIds[0]!)
      body = { mode, dest, itemIds: ids }
      const sum = ids.reduce((a, id) => a + BigInt(row.itemPrice.get(id)!), 0n)
      const raw = Number((2n * sum * BigInt(10_000 + row.inv.tax_bp) + 10_000n) / 20_000n)
      val = Math.min(oc.refundable, raw)
      itemsClaimed = ids.some((id) => claimed.has(id))
    } else {
      const edge = this.pick([
        oc.refundable,
        oc.refundable + 1,
        oc.toOrigMax,
        oc.toOrigMax + 1,
        this.origCap(row, 'card'),
        this.origCap(row, 'card') + 1,
        this.origCap(row, 'cash'),
        this.origCap(row, 'cash') + 1,
        lim ?? 100,
        (lim ?? 100) + 1,
        this.int(1, Math.max(1, oc.refundable)),
        this.int(1, 40_000),
      ])
      val = Math.max(1, edge)
      body = { mode, dest, amountCents: val }
    }
    const res = await this.p.send(this.people[who], 'POST', `invoices/${inv.id}/refunds`, body)
    this.log(`refund ${who} ${mode} ${dest} val=${val} refundable=${oc.refundable} toOrig=${oc.toOrigMax} limit=${lim} -> ${res.statusCode}`)
    if (!this.can(who, 'canRefund')) return this.expectStatus(res, 403, 'refund without pay.refund')
    const before = row.evs.length
    if (mode === 'items' && itemsClaimed) {
      this.expectStatus(res, 422, 'refund of an item already refunded')
      return
    }
    if (val <= 0) return this.expectStatus(res, 422, 'refund of nothing')
    const capped = val > this.capOf(row, oc, dest)
    if (capped || val > oc.refundable) {
      this.expectStatus(res, 422, 'refund over a cap')
      expect((await this.load(inv.id)).evs.length).toBe(before)
      return
    }
    this.expectStatus(res, 201, 'refund')
    const after = await this.load(inv.id)
    const ev = after.evs[after.evs.length - 1]!
    expect(ev).toMatchObject({ type: 'refund', amount_cents: val, dest })
    expect(ev.status).toBe(lim !== null && val > lim ? 'pending' : 'done')
    expect(ev.processor_state).toBe(ev.status === 'done' && dest === 'card' ? 'awaiting_processor' : 'na')
  }

  private async pendingRefund(): Promise<{ inv: InvRef; ev: Ev; row: Row } | null> {
    const cands: Array<{ inv: InvRef; ev: Ev; row: Row }> = []
    for (const inv of this.invs) {
      const row = await this.load(inv.id)
      for (const ev of row.evs) if (ev.type === 'refund' && ev.status === 'pending') cands.push({ inv, ev, row })
    }
    return cands.length ? this.pick(cands) : null
  }

  private async approve(): Promise<void> {
    const t = await this.pendingRefund()
    if (!t) return
    const who = this.pickWho()
    const oc = this.oc(t.row)
    const lim = this.limit(who, 'refund')
    const requester = t.ev.actor_user_id ? this.userOf.get(t.ev.actor_user_id) : undefined
    const res = await this.p.send(this.people[who], 'POST', `invoices/${t.inv.id}/refunds/${t.ev.id}/approve`, {})
    this.log(`approve ${who} (limit ${lim}) amount=${t.ev.amount_cents} requester=${requester} -> ${res.statusCode} ${res.statusCode >= 400 ? (res.json() as { code?: string }).code : ''}`)
    if (!this.can(who, 'canRefund')) return this.expectStatus(res, 403, 'approve without pay.refund')
    if (lim !== null && lim < t.ev.amount_cents) return this.expectStatus(res, 403, 'approve over the approver limit')
    if (requester === who && lim !== null) return this.expectStatus(res, 403, 'self-approval')
    const withoutOwn = Math.max(0, oc.paid - oc.refunded - (oc.pendingAmt - t.ev.amount_cents))
    if (t.ev.amount_cents > this.capOf(t.row, oc, t.ev.dest!, t.ev.id) || t.ev.amount_cents > withoutOwn)
      return this.expectStatus(res, 422, 'approve that no longer fits')
    this.expectStatus(res, 200, 'approve')
    const after = await this.load(t.inv.id)
    const ev = after.evs.find((e) => e.id === t.ev.id)!
    expect(ev.status).toBe('done')
    expect(ev.approved_by_user_id).toBe(this.people[who].user.userId)
    expect(ev.processor_state).toBe(ev.dest === 'card' ? 'awaiting_processor' : 'na')
  }

  private async deny(): Promise<void> {
    const t = await this.pendingRefund()
    if (!t) return
    const who = this.pickWho()
    const res = await this.p.send(this.people[who], 'POST', `invoices/${t.inv.id}/refunds/${t.ev.id}/deny`, {})
    this.log(`deny ${who} amount=${t.ev.amount_cents} -> ${res.statusCode}`)
    if (!this.can(who, 'canRefund')) return this.expectStatus(res, 403, 'deny without pay.refund')
    this.expectStatus(res, 200, 'deny')
    const after = await this.load(t.inv.id)
    expect(after.evs.find((e) => e.id === t.ev.id)!.status).toBe('denied')
  }

  private async adjust(): Promise<void> {
    const inv = this.anInvoice()
    const who = this.pickWho()
    const row = await this.load(inv.id)
    const oc = this.oc(row)
    const kind = this.pick(['discount', 'surcharge'] as const)
    const unit = this.pick(['$', '%'] as const)
    const value = unit === '%' ? this.int(1, 6000) : this.int(1, Math.max(2, Math.floor(oc.items * 0.8)))
    const settle = this.pick([undefined, 'credit', 'card'] as const)
    const body: Record<string, unknown> = { kind, unit, value }
    if (settle) body.settle = settle
    const res = await this.p.send(this.people[who], 'POST', `invoices/${inv.id}/adjustments`, body)
    const code = res.statusCode >= 400 ? (res.json() as { code?: string }).code : ''
    this.log(`adjust ${who} ${kind} ${value}${unit} settle=${settle} items=${oc.items} adj=${oc.adj} paid=${oc.paid} -> ${res.statusCode} ${code}`)
    if (!this.can(who, 'canAdjust')) return this.expectStatus(res, 403, 'adjust without pay.adjust')
    if (row.inv.canceled_at) return this.expectStatus(res, 409, 'adjust on a canceled invoice')
    const pre = unit === '%' ? Number((2n * BigInt(oc.items) * BigInt(value) + 10_000n) / 20_000n) : value
    const lim = this.limit(who, 'adjust')
    if (pre <= 0) return this.expectStatus(res, 422, 'adjust of nothing')
    if (lim !== null && pre > lim) return this.expectStatus(res, 422, 'adjust over the limit')
    const signed = kind === 'discount' ? -pre : pre
    const rawSub = oc.items + oc.adj + signed
    if (oc.sub + signed < 0) return this.expectStatus(res, 422, 'discount larger than the invoice')
    // what the invoice must look like after: the oracle on the would-be ledger
    const newSub = Math.max(rawSub, 0)
    const newTax = Number((2n * BigInt(newSub) * BigInt(row.inv.tax_bp) + 10_000n) / 20_000n)
    const newTotal = newSub + newTax + row.inv.tip_cents
    const diff = oc.paid - oc.refunded - newTotal
    const settleVal = Math.min(diff, oc.refundable)
    const wantsSettlement = diff > 0 && oc.paid > 0 && settleVal > 0
    if (wantsSettlement && settle === 'card' && settleVal > this.capOf(row, oc, 'card')) return this.expectStatus(res, 422, 'card settlement over the card cap')
    this.expectStatus(res, 201, 'adjust')
    const after = await this.load(inv.id)
    const aft = this.oc(after)
    expect(aft.total, 'total after adjust (oracle on the new ledger)').toBe(newTotal)
    const maxBefore = row.evs.reduce((m, e) => Math.max(m, Number(e.seq)), 0)
    const settlement = after.evs.find((e) => e.parent_event_id !== null && e.type === 'refund' && Number(e.seq) > maxBefore)
    if (wantsSettlement) {
      expect(settlement, 'settlement refund').toBeDefined()
      if (settlement!.amount_cents !== settleVal)
        this.fail(
          `settlement ${settlement!.amount_cents} but the oracle says ${settleVal}: ${JSON.stringify({ pre, signed, rawSub, newSub, newTax, newTotal, diff, oc, tip: row.inv.tip_cents, taxBp: row.inv.tax_bp, after: aft })}`,
        )
      expect(settlement!.dest).toBe(settle === 'card' ? 'card' : 'credit')
      const rl = this.limit(who, 'refund')
      expect(settlement!.status).toBe(rl !== null && settleVal > rl ? 'pending' : 'done')
    }
  }

  private async issueCredit(): Promise<void> {
    const inv = this.anInvoice()
    const who = this.pickWho()
    const amount = this.int(1, 30_000)
    const expiry = this.pick(['none', 'd30', 'd90'] as const)
    const before = this.clock.now()
    const res = await this.p.send(this.people[who], 'POST', `invoices/${inv.id}/credits`, { amountCents: amount, expiry })
    this.log(`issue-credit ${who} ${amount} ${expiry} -> ${res.statusCode}`)
    if (!this.can(who, 'canCredit')) return this.expectStatus(res, 403, 'credit without pay.credit')
    const lim = this.limit(who, 'credit')
    if (lim !== null && amount > lim) return this.expectStatus(res, 422, 'credit over the limit')
    this.expectStatus(res, 201, 'issue credit')
    const row = await this.load(inv.id)
    const ev = row.evs[row.evs.length - 1]!
    expect(ev.type).toBe('credit_issue')
    const days = expiry === 'd30' ? 30 : expiry === 'd90' ? 90 : 0
    if (days === 0) expect(ev.expires_at).toBeNull()
    else {
      const want = DateTime.fromJSDate(before, { zone: 'America/New_York' }).startOf('day').plus({ days: days + 1 }).startOf('day').toJSDate()
      expect(ev.expires_at?.toISOString()).toBe(want.toISOString())
    }
  }

  private async voidStep(): Promise<void> {
    const inv = this.anInvoice()
    const row = await this.load(inv.id)
    const pays = row.evs.filter((e) => e.type === 'pay')
    if (pays.length === 0) return
    const pay = this.pick(pays)
    const who = this.pickWho()
    const oc = this.oc(row)
    const already = row.evs.some((e) => e.voids_event_id === pay.id)
    const res = await this.p.send(this.people[who], 'POST', `invoices/${inv.id}/void`, { eventId: pay.id })
    const code = res.statusCode >= 400 ? (res.json() as { code?: string }).code : ''
    this.log(`void ${who} pay=${pay.method_kind}/${pay.processor_state}/${pay.amount_cents} already=${already} -> ${res.statusCode} ${code}`)
    if (!this.can(who, 'canVoid')) return this.expectStatus(res, 403, 'void without pay.void')
    if (already) return this.expectStatus(res, 409, 'double void')
    if (pay.method_kind !== 'cash' && pay.processor_state !== 'awaiting_processor') return this.expectStatus(res, 422, 'void of confirmed card money')
    if (oc.paid - pay.amount_cents - oc.refunded - oc.pendingAmt < 0) return this.expectStatus(res, 422, 'void of refunded money')
    const cardMoney = pay.method_kind === 'card' || pay.method_kind === 'apple_pay'
    if (STRICT && (this.origCap(row, 'cash') < pay.amount_cents || (cardMoney && this.origCap(row, 'card') < pay.amount_cents)))
      return this.expectStatus(res, 422, 'void that would leave refunds above the original payments')
    this.expectStatus(res, 201, 'void')
  }

  private async confirm(): Promise<void> {
    const inv = this.anInvoice()
    const row = await this.load(inv.id)
    const cands = row.evs.filter((e) => e.type === 'pay' || e.type === 'refund')
    if (cands.length === 0) return
    const ev = this.pick(cands)
    const who = this.pickWho()
    const res = await this.p.send(this.people[who], 'POST', `ledger-events/${ev.id}/confirm-processor`, {})
    this.log(`confirm ${who} ${ev.type}/${ev.processor_state} -> ${res.statusCode}`)
    const perm = ev.type === 'refund' ? 'canRefund' : 'canCollect'
    if (!this.can(who, perm)) return this.expectStatus(res, 403, 'confirm without permission')
    const voided = row.evs.some((e) => e.voids_event_id === ev.id)
    if (ev.processor_state !== 'awaiting_processor' || (voided && STRICT)) return this.expectStatus(res, 409, 'confirm of an event not awaiting')
    this.expectStatus(res, 200, 'confirm')
  }

  private async tip(): Promise<void> {
    const inv = this.anInvoice()
    const who = this.pickWho()
    const row = await this.load(inv.id)
    const tipCents = this.int(0, 4000)
    const res = await this.p.send(this.people[who], 'PUT', `invoices/${inv.id}/tip`, { tipCents })
    this.log(`tip ${who} ${tipCents} -> ${res.statusCode}`)
    if (!this.can(who, 'canCollect')) return this.expectStatus(res, 403, 'tip without pay.collect')
    if (row.inv.canceled_at) return this.expectStatus(res, 409, 'tip on a canceled invoice')
    this.expectStatus(res, 200, 'tip')
  }

  private async items(): Promise<void> {
    const inv = this.anInvoice()
    const row = await this.load(inv.id)
    if (row.inv.canceled_at) return
    const cur = await this.db.selectFrom('invoice_items').selectAll().where('invoice_id', '=', inv.id).orderBy('position').execute()
    let next = cur.map((i) => ({ name: i.name, priceCents: i.price_cents, kind: i.kind }))
    const op = this.pick(['add', 'remove', 'reprice'] as const)
    if (op === 'add') next = [...next, { name: `Addon ${this.int(1, 99)}`, priceCents: this.int(100, 9000), kind: 'addon' as const }]
    else if (op === 'remove' && next.length > 1) next = next.filter((_, i) => i !== this.int(1, next.length - 1))
    else if (op === 'reprice') next = next.map((n, i) => (i === next.length - 1 ? { ...n, priceCents: this.int(100, 9000) } : n))
    const oc = this.oc(row)
    // expected: a removal that leaves the invoice overpaid is refused (409); everything else goes through
    const removed = cur.length > next.length || op === 'reprice'
    const would = oracleCalc(
      { tax_bp: row.inv.tax_bp, tip_cents: row.inv.tip_cents, canceled: false },
      next.map((n) => n.priceCents),
      row.evs,
    )
    const changed = JSON.stringify(cur.map((i) => [i.kind, i.name, i.price_cents])) !== JSON.stringify(next.map((n) => [n.kind, n.name, n.priceCents]))
    let outcome = 'ok'
    try {
      await transaction(this.db, (tx) => this.gw.syncItems(tx, inv.appointmentId, next))
    } catch (e) {
      outcome = (e as { code?: string }).code ?? String(e)
    }
    this.log(`items ${op} -> ${outcome} (items ${oc.items} -> ${would.items}, overpaid would be ${would.overpaid})`)
    if (changed && removed && would.overpaid > 0) expect(outcome, 'item removal that overpays').toBe('ADDON_REMOVE_OVERPAID')
    else expect(outcome, 'item sync').toBe('ok')
  }

  private async advanceClock(): Promise<void> {
    const ms = this.pick([60_000, 3_600_000, 86_400_000, 10 * 86_400_000, 31 * 86_400_000, 95 * 86_400_000])
    this.clock.advance(ms)
    this.log(`clock +${ms / 3_600_000}h -> ${this.clock.now().toISOString()}`)
    // the sessions idle out after 12 h
    const n = this.p.people()
    for (const w of WHO) n[w].session = await this.p.h.login(n[w].user, `10.88.${this.int(1, 200)}.${this.int(1, 250)}`)
  }

  private async cancel(): Promise<void> {
    const inv = this.anInvoice()
    await transaction(this.db, (tx) =>
      this.gw.cancelForAppointment(tx, inv.appointmentId, this.pick(['canceled', 'no_show'] as const), { userId: null, name: 'Model', roles: null }),
    )
    this.log(`cancel inv=${inv.id.slice(-6)}`)
  }

  private async race(): Promise<void> {
    const kind = this.pick(['two-refunds', 'approve-deny', 'two-approvals', 'confirm-void', 'two-credit-apply', 'refund-adjust', 'collect-collect'])
    const inv = this.anInvoice()
    const row = await this.load(inv.id)
    const oc = this.oc(row)
    const before = row.evs.length
    const send = (who: Who, method: 'POST' | 'PUT', url: string, body: unknown, key?: string) => this.p.send(this.people[who], method, url, body, key)
    let results: Array<{ statusCode: number }> = []
    switch (kind) {
      case 'two-refunds': {
        const amt = Math.max(1, Math.floor(oc.refundable * 0.6))
        results = await Promise.all([
          send('amara', 'POST', `invoices/${inv.id}/refunds`, { mode: 'custom', amountCents: amt, dest: 'credit' }),
          send('rafael', 'POST', `invoices/${inv.id}/refunds`, { mode: 'custom', amountCents: amt, dest: 'credit' }),
        ])
        if (oc.refundable > 0 && amt * 2 > oc.refundable && amt <= oc.refundable)
          expect(results.filter((r) => r.statusCode === 201).length, 'two refunds of 60% each cannot both succeed').toBe(1)
        break
      }
      case 'approve-deny': {
        const t = await this.pendingRefund()
        if (!t) return
        results = await Promise.all([
          send('amara', 'POST', `invoices/${t.inv.id}/refunds/${t.ev.id}/approve`, {}),
          send('rafael', 'POST', `invoices/${t.inv.id}/refunds/${t.ev.id}/deny`, {}),
        ])
        expect(results.filter((r) => r.statusCode === 200).length, 'approve and deny of one request cannot both win').toBeLessThanOrEqual(1)
        break
      }
      case 'two-approvals': {
        const t = await this.pendingRefund()
        if (!t) return
        results = await Promise.all([
          send('amara', 'POST', `invoices/${t.inv.id}/refunds/${t.ev.id}/approve`, {}),
          send('amara', 'POST', `invoices/${t.inv.id}/refunds/${t.ev.id}/approve`, {}),
        ])
        expect(results.filter((r) => r.statusCode === 200).length, 'one request approved twice').toBeLessThanOrEqual(1)
        break
      }
      case 'confirm-void': {
        const pay = row.evs.find((e) => e.type === 'pay' && e.processor_state === 'awaiting_processor')
        if (!pay) return
        results = await Promise.all([
          send('rafael', 'POST', `ledger-events/${pay.id}/confirm-processor`, {}),
          send('amara', 'POST', `invoices/${inv.id}/void`, { eventId: pay.id }),
        ])
        if (STRICT) expect(results.filter((r) => r.statusCode < 300).length, 'confirm and void of one payment').toBe(1)
        break
      }
      case 'two-credit-apply': {
        const others = this.invs.filter((i) => i.customerId === inv.customerId && i.id !== inv.id)
        const other = others[0]
        if (!other) return
        results = await Promise.all([
          send('rafael', 'POST', `invoices/${inv.id}/credit-applications`, {}),
          send('amara', 'POST', `invoices/${other.id}/credit-applications`, {}),
        ])
        break
      }
      case 'refund-adjust': {
        const amt = Math.max(1, oc.refundable)
        results = await Promise.all([
          send('amara', 'POST', `invoices/${inv.id}/refunds`, { mode: 'custom', amountCents: amt, dest: 'credit' }),
          send('amara', 'POST', `invoices/${inv.id}/adjustments`, { kind: 'discount', unit: '%', value: 1000, settle: 'credit' }),
        ])
        break
      }
      case 'collect-collect': {
        results = await Promise.all([
          send('rafael', 'POST', `invoices/${inv.id}/payments`, { method: 'card' }),
          send('amara', 'POST', `invoices/${inv.id}/payments`, { method: 'cash' }),
        ])
        expect(results.filter((r) => r.statusCode === 201).length, 'the balance cannot be collected twice').toBeLessThanOrEqual(1)
        break
      }
    }
    this.log(`race ${kind} -> ${results.map((r) => r.statusCode).join(',')} (events ${before} -> ?)`)
    for (const r of results) if (r.statusCode >= 500) this.fail(`race ${kind} returned a 5xx`)
  }

  private async replay(): Promise<void> {
    const inv = this.anInvoice()
    const row = await this.load(inv.id)
    const oc = this.oc(row)
    if (oc.balance <= 0) return
    const key = freshKey()
    const who = this.pick(['rafael', 'amara', 'daniel'] as const)
    const a = await this.p.send(this.people[who], 'POST', `invoices/${inv.id}/payments`, { method: 'cash' }, key)
    const b = await this.p.send(this.people[who], 'POST', `invoices/${inv.id}/payments`, { method: 'cash' }, key)
    const c = await this.p.send(this.people[who], 'POST', `invoices/${inv.id}/payments`, { method: 'card' }, key)
    this.log(`replay ${who} -> ${a.statusCode},${b.statusCode},${c.statusCode}`)
    this.expectStatus(a, 201, 'first send of a key')
    expect(b.statusCode).toBe(201)
    expect(b.headers['idempotent-replayed']).toBe('true')
    expect(b.body).toBe(a.body)
    expect(c.statusCode, 'same key, different body').toBe(422)
    const after = await this.load(inv.id)
    expect(after.evs.length, 'a replayed key writes one event').toBe(row.evs.length + 1)
  }

  // --- invariants --------------------------------------------------------------------------------------------------

  private async snapshotLedger(): Promise<void> {
    const rows = (await sql<Record<string, unknown>>`select * from ledger_events order by seq`.execute(this.db)).rows
    for (const r of rows) {
      const key = String(r.id)
      const frozen = JSON.stringify(
        IMMUTABLE_COLS.map((c) => (r[c] instanceof Date ? (r[c] as Date).toISOString() : typeof r[c] === 'bigint' ? String(r[c]) : r[c])),
      )
      const prev = this.snapshot.get(key)
      if (prev !== undefined && prev !== frozen) this.fail(`ledger row ${key} changed an immutable column`)
      this.snapshot.set(key, frozen)
      const seen = this.statusSeen.get(key)
      const ps = String(r.processor_state)
      const st = String(r.status)
      if (seen) {
        if (seen.processor === 'confirmed' && ps !== 'confirmed') this.fail(`event ${key} left the confirmed state (${ps})`)
        if (seen.processor !== 'awaiting_processor' && ps === 'awaiting_processor' && seen.processor !== 'na')
          this.fail(`event ${key} went back to awaiting_processor from ${seen.processor}`)
        if (seen.status === 'done' && st !== 'done') this.fail(`event ${key} left status done (${st})`)
        if (seen.status === 'denied' && st !== 'denied') this.fail(`event ${key} left status denied (${st})`)
      }
      this.statusSeen.set(key, { processor: ps, status: st })
    }
    for (const key of this.snapshot.keys()) if (!rows.some((r) => String(r.id) === key)) this.fail(`ledger row ${key} disappeared`)
  }

  async checkInvariants(): Promise<void> {
    await this.snapshotLedger()
    const now = this.clock.now()
    for (const inv of this.invs) {
      const row = await this.load(inv.id)
      const oc = this.oc(row)
      const res = await this.p.get(this.people.amara, `invoices/${inv.id}`)
      this.expectStatus(res, 200, 'invoice detail')
      const d = res.json() as { calc: Record<string, number | string>; clientCredit: { balanceCents: number } }
      for (const k of Object.keys(oc) as Array<keyof OracleCalc>) {
        if (d.calc[k] !== oc[k]) this.fail(`calc.${k}: api=${String(d.calc[k])} oracle=${String(oc[k])} (inv ${inv.id.slice(-6)})`)
      }
      // balance, refunds and the caps
      if (oc.balance < 0) this.fail('negative balance')
      if (oc.refunded + oc.pendingAmt > oc.paid) this.fail(`refunds ${oc.refunded}+${oc.pendingAmt} exceed what was paid ${oc.paid}`)
      if (oc.paid < 0) this.fail(`negative paid ${oc.paid}`)
      if (STRICT) {
        if (oc.refOrig > oc.paidOrig) this.fail(`refunds to the original payments ${oc.refOrig} exceed ${oc.paidOrig}`)
        const cardPaid = row.evs.filter((e) => (e.type === 'pay' || e.type === 'void') && (e.method_kind === 'card' || e.method_kind === 'apple_pay')).reduce((a, e) => a + (e.type === 'pay' ? e.amount_cents : -e.amount_cents), 0)
        const cardRefunded = row.evs.filter((e) => e.type === 'refund' && e.status === 'done' && e.dest === 'card').reduce((a, e) => a + e.amount_cents, 0)
        if (cardRefunded > cardPaid) this.fail(`card refunds ${cardRefunded} exceed card payments ${cardPaid}`)
      }
      // the approvals rules on every resolved refund
      for (const e of row.evs) {
        if (e.type !== 'refund') continue
        if (e.status === 'pending' && e.resolved_at !== null) this.fail('a pending refund has resolved_at')
        if (e.status === 'done' && e.approved_by_user_id) {
          const approver = this.userOf.get(e.approved_by_user_id)
          const requester = e.actor_user_id ? this.userOf.get(e.actor_user_id) : undefined
          if (!approver) this.fail('approver unknown')
          const lim = this.limit(approver!, 'refund')
          if (lim !== null && lim < e.amount_cents) this.fail(`refund of ${e.amount_cents} approved by ${approver} whose limit is ${lim}`)
          if (requester === approver && lim !== null) this.fail('self-approval slipped through')
        }
        if (e.status === 'denied' && e.processor_state !== 'na') this.fail('a denied refund waits on the processor')
      }
      // the awaiting counters never include reversed money (known defect 1)
      if (STRICT) {
        for (const e of row.evs) {
          if (e.type === 'pay' && e.processor_state === 'awaiting_processor' && row.evs.some((v) => v.voids_event_id === e.id))
            this.fail(`voided payment ${e.id} still awaits the processor`)
        }
      }
      // store credit
      const { evs, allocs } = await this.customerEvents(inv.customerId)
      const rep = creditOracle(evs, allocs, now)
      if (rep.problems.length) this.fail(`store credit: ${rep.problems.join('; ')}`)
      if (d.clientCredit.balanceCents !== rep.balance) this.fail(`client credit balance api=${d.clientCredit.balanceCents} oracle=${rep.balance}`)
      const outside = allocs.filter((a) => a.cents <= 0)
      if (outside.length) this.fail('non-positive allocation')
      const spent = evs.filter((e) => e.type === 'credit_apply').reduce((a, e) => a + e.amount_cents, 0)
      const allocated = allocs.reduce((a, x) => a + x.cents, 0)
      if (spent !== allocated) this.fail(`credit applied ${spent} but allocated ${allocated}`)
    }
    await this.checkRevenue()
    await this.checkReports()
  }

  /** The summary KPIs, the invoice table and the CSV export against the oracle, for a range that contains the invoices. */
  private async checkReports(): Promise<void> {
    const rangeKey = this.pick(['7d', '30d', 'mtd', 'today'] as const)
    const sum = (await this.p.get(this.people.amara, `payments/summary?range=${rangeKey}`)).json() as {
      range: { from: string; to: string }
      kpis: { grossSales: number; netRevenue: number; refunds: number; adjustments: number; creditsIssued: number; outstanding: number; counts: { invoices: number; refunded: number; adjusted: number; openBalances: number } }
      byMethod: Record<string, number>
    }
    const rows: Array<{ inv: InvRef; row: Row; oc: OracleCalc; bizDate: string }> = []
    for (const inv of this.invs) {
      const row = await this.load(inv.id)
      const b = await this.db.selectFrom('invoices').select(sql<string>`biz_date::text`.as('d')).where('id', '=', inv.id).executeTakeFirstOrThrow()
      if (b.d >= sum.range.from && b.d <= sum.range.to) rows.push({ inv, row, oc: this.oc(row), bizDate: b.d })
    }
    const tot = (f: (r: { oc: OracleCalc }) => number): number => rows.reduce((a, r) => a + f(r), 0)
    const k = sum.kpis
    const mism: string[] = []
    if (k.grossSales !== tot((r) => r.oc.items)) mism.push(`grossSales ${k.grossSales} vs ${tot((r) => r.oc.items)}`)
    if (k.adjustments !== tot((r) => r.oc.adj)) mism.push(`adjustments ${k.adjustments} vs ${tot((r) => r.oc.adj)}`)
    if (k.refunds !== tot((r) => r.oc.refunded)) mism.push(`refunds ${k.refunds} vs ${tot((r) => r.oc.refunded)}`)
    if (k.outstanding !== tot((r) => r.oc.balance)) mism.push(`outstanding ${k.outstanding} vs ${tot((r) => r.oc.balance)}`)
    if (k.creditsIssued !== tot((r) => r.oc.issued)) mism.push(`creditsIssued ${k.creditsIssued} vs ${tot((r) => r.oc.issued)}`)
    if (k.counts.invoices !== rows.length) mism.push(`invoice count ${k.counts.invoices} vs ${rows.length}`)
    if (k.counts.openBalances !== rows.filter((r) => r.oc.balance > 0).length) mism.push('openBalances')
    // net: refunds lose their tax part once per tax rate, half-up on the aggregate
    const byRate = new Map<number, bigint>()
    for (const r of rows) byRate.set(r.row.inv.tax_bp, (byRate.get(r.row.inv.tax_bp) ?? 0n) + BigInt(r.oc.refunded))
    let refundNet = 0n
    for (const [bp, amt] of byRate) refundNet += (2n * amt * 10_000n + BigInt(10_000 + bp)) / (2n * BigInt(10_000 + bp))
    const wantNet = Number(BigInt(tot((r) => r.oc.items + r.oc.adj)) - refundNet)
    if (k.netRevenue !== wantNet) mism.push(`netRevenue ${k.netRevenue} vs ${wantNet}`)
    if (mism.length) this.fail(`summary ${rangeKey}: ${mism.join('; ')}`)

    // table vs CSV
    const list = (await this.p.get(this.people.amara, `payments/invoices?range=${rangeKey}&limit=500`)).json() as {
      items: Array<{ id: string; label: string; totalCents: number; paidCents: number; balanceCents: number; statusLabel: string; bizDate: string }>
    }
    if (list.items.length !== rows.length) this.fail(`table has ${list.items.length} rows, oracle ${rows.length}`)
    const csvRes = await this.p.get(this.people.amara, `payments/export.csv?range=${rangeKey}`)
    const lines = csvRes.body.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean)
    const header = lines[0]!.split(',')
    const col = (n: string): number => header.indexOf(n)
    if (lines.length - 1 !== list.items.length) this.fail(`csv has ${lines.length - 1} rows, table ${list.items.length}`)
    const cents = (txt: string): number => Math.round(Number(txt) * 100)
    for (const [i, item] of list.items.entries()) {
      const cells = lines[i + 1]!.split(',')
      const o = rows.find((r) => r.inv.id === item.id)!.oc
      if (cells[col('Invoice')] !== item.label) this.fail(`csv row ${i} is ${cells[col('Invoice')]}, table ${item.label}`)
      if (cents(cells[col('Total')]!) !== item.totalCents || item.totalCents !== o.total) this.fail(`csv/table/oracle total differ for ${item.label}`)
      if (cents(cells[col('Paid')]!) !== item.paidCents || item.paidCents !== o.paid) this.fail(`csv/table/oracle paid differ for ${item.label}`)
      if (cents(cells[col('Balance')]!) !== item.balanceCents || item.balanceCents !== o.balance) this.fail(`csv/table/oracle balance differ for ${item.label}`)
      if (cents(cells[col('Net revenue')]!) !== o.net) this.fail(`csv net differs from oracle for ${item.label}: ${cells[col('Net revenue')]} vs ${o.net}`)
    }
    // collected by method: pays by tender (voids back out) plus store credit applied, for invoices of the range
    const want: Record<string, number> = { card: 0, applePay: 0, cash: 0, storeCredit: 0, other: 0 }
    const key = (m: string | null): string => (m === 'card' ? 'card' : m === 'apple_pay' ? 'applePay' : m === 'cash' ? 'cash' : m === 'store_credit' ? 'storeCredit' : 'other')
    for (const r of rows) {
      for (const e of r.row.evs) {
        if (e.type === 'pay') want[key(e.method_kind)] = want[key(e.method_kind)]! + e.amount_cents
        else if (e.type === 'void') want[key(e.method_kind)] = want[key(e.method_kind)]! - e.amount_cents
        else if (e.type === 'credit_apply') want.storeCredit = want.storeCredit! + e.amount_cents
      }
    }
    for (const kk of Object.keys(want)) if ((sum.byMethod[kk] ?? 0) !== want[kk]) this.fail(`byMethod.${kk} ${sum.byMethod[kk]} vs ${want[kk]}`)
  }

  private async checkRevenue(): Promise<void> {
    const loc = this.p.env().locationId
    const now = this.clock.now()
    const all = (await sql<Ev>`select * from ledger_events where location_id = ${loc} order by seq`.execute(this.db)).rows
    const windows: Array<[Date, Date]> = [
      [new Date(now.getTime() - 86_400_000), new Date(now.getTime() + 1)],
      [new Date(now.getTime() - 10 * 86_400_000), new Date(now.getTime() - 3_600_000)],
      [new Date('2026-06-01T00:00:00Z'), new Date(now.getTime() + 86_400_000)],
    ]
    for (const [from, to] of windows) {
      let cents = 0n
      for (const e of all) {
        const a = BigInt(e.amount_cents)
        const at = e.occurred_at.getTime()
        if ((e.type === 'pay' || e.type === 'void') && at >= from.getTime() && at < to.getTime()) cents += e.type === 'pay' ? a : -a
        if (e.type === 'refund' && e.status === 'done' && e.dest !== 'credit') {
          const t = (e.resolved_at ?? e.occurred_at).getTime()
          if (t >= from.getTime() && t < to.getTime()) cents -= a
        }
      }
      const got = await ledgerRevenueSource.revenueCents(this.db, loc, from, to)
      if (got !== Number(cents)) this.fail(`revenue [${from.toISOString()}, ${to.toISOString()}) api=${got} oracle=${Number(cents)}`)
    }
  }
}

export { createIdGenerator }
