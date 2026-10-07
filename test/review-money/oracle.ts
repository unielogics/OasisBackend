// An independent oracle for the money path: it recomputes everything from the raw table rows with BigInt arithmetic and its own
// formulas (it shares no code with src/modules/payments/calc.ts or invoice_calc_of). Used by the randomized model tests.

export interface Ev {
  id: string
  seq: number | string
  invoice_id: string
  customer_id: string
  type: 'pay' | 'adjust' | 'refund' | 'credit_issue' | 'credit_apply' | 'void'
  amount_cents: number
  status: 'pending' | 'done' | 'denied'
  dest: 'card' | 'credit' | 'cash' | null
  method_kind: string | null
  processor_state: 'na' | 'awaiting_processor' | 'confirmed' | 'failed'
  voids_event_id: string | null
  occurred_at: Date
  resolved_at: Date | null
  expires_at: Date | null
  actor_user_id: string | null
  approved_by_user_id: string | null
  item_ids: string[]
  source: string
  parent_event_id: string | null
  idempotency_key: string | null
}

const big = (n: number): bigint => BigInt(n)
const max0 = (n: bigint): bigint => (n > 0n ? n : 0n)

export interface OracleCalc {
  items: number
  adj: number
  sub: number
  tax: number
  total: number
  paidOrig: number
  creditApplied: number
  paid: number
  refunded: number
  refOrig: number
  pendingAmt: number
  pendingN: number
  issued: number
  balance: number
  refundable: number
  toOrigMax: number
  net: number
  overpaid: number
  status: string
}

export function oracleCalc(
  inv: { tax_bp: number; tip_cents: number; canceled: boolean },
  prices: readonly number[],
  evs: readonly Ev[],
): OracleCalc {
  const bp = big(inv.tax_bp)
  let items = 0n
  for (const p of prices) items += big(p)
  let adj = 0n
  let pay = 0n
  let voided = 0n
  let creditApplied = 0n
  let refunded = 0n
  let refOrig = 0n
  let pending = 0n
  let pendingN = 0
  let issued = 0n
  for (const e of evs) {
    const a = big(e.amount_cents)
    if (e.type === 'adjust') adj += a
    else if (e.type === 'pay') pay += a
    else if (e.type === 'void') voided += a
    else if (e.type === 'credit_apply') creditApplied += a
    else if (e.type === 'credit_issue') issued += a
    else if (e.type === 'refund') {
      if (e.status === 'done') {
        refunded += a
        if (e.dest !== 'credit') refOrig += a
      } else if (e.status === 'pending') {
        pending += a
        pendingN++
      }
    }
  }
  const sub = max0(items + adj)
  // round-half-up of sub * bp / 10000 without the (n + d/2) / d shortcut the product code uses
  const tax = (2n * sub * bp + 10_000n) / 20_000n
  const total = sub + tax + big(inv.tip_cents)
  const paidOrig = pay - voided
  const paid = paidOrig + creditApplied
  const balance = inv.canceled ? 0n : max0(total - paid)
  const refundable = max0(paid - refunded - pending)
  const toOrigMax = max0(paidOrig - refOrig)
  const overpaid = max0(paid - refunded - total)
  const d = 10_000n + bp
  const net = items + adj - (2n * refunded * 10_000n + d) / (2n * d)
  let status: string
  if (inv.canceled && paid === 0n && refunded === 0n) status = 'canceled'
  else if (inv.canceled && refunded >= paid) status = 'canceled_refunded'
  else if (inv.canceled) status = 'canceled_kept'
  else if (refunded > 0n && refunded >= paid - 1n) status = 'refunded'
  else if (paid === 0n) status = 'unpaid'
  else if (balance > 0n) status = 'partially_paid'
  else if (refunded > 0n) status = 'partially_refunded'
  else status = 'paid'
  const n = (x: bigint): number => Number(x)
  return {
    items: n(items),
    adj: n(adj),
    sub: n(sub),
    tax: n(tax),
    total: n(total),
    paidOrig: n(paidOrig),
    creditApplied: n(creditApplied),
    paid: n(paid),
    refunded: n(refunded),
    refOrig: n(refOrig),
    pendingAmt: n(pending),
    pendingN,
    issued: n(issued),
    balance: n(balance),
    refundable: n(refundable),
    toOrigMax: n(toOrigMax),
    net: n(net),
    overpaid: n(overpaid),
    status,
  }
}

// --- store credit ----------------------------------------------------------------------------------------------------

export interface Alloc {
  apply_event_id: string
  lot_event_id: string
  cents: number
}

const seqOf = (e: Pick<Ev, 'seq'>): number => Number(e.seq)

export interface CreditReport {
  balance: number
  problems: string[]
}

/**
 * Replays every credit_apply of a customer in ledger order against the lots (credit_issue events and done refunds to
 * credit) with the FIFO rule (earliest expiry first, no expiry last, then earliest effective time, then id), skipping lots
 * that were expired or not yet effective at that instant, and compares the replay with the stored allocations. Also
 * returns the spendable balance at `now`.
 */
export function creditOracle(events: readonly Ev[], allocs: readonly Alloc[], now: Date): CreditReport {
  const problems: string[] = []
  const lots = events.filter(
    (e) => e.type === 'credit_issue' || (e.type === 'refund' && e.dest === 'credit' && e.status === 'done'),
  )
  const eff = (e: Ev): number => (e.resolved_at ?? e.occurred_at).getTime()
  const exp = (e: Ev): number =>
    e.type === 'credit_issue' && e.expires_at ? e.expires_at.getTime() : Number.POSITIVE_INFINITY
  const remaining = new Map<string, number>(lots.map((l) => [l.id, l.amount_cents]))
  const applies = events.filter((e) => e.type === 'credit_apply').sort((a, b) => seqOf(a) - seqOf(b))
  for (const a of applies) {
    const at = a.occurred_at.getTime()
    const usable = lots
      // a lot written after the apply in ledger order did not exist when the apply ran, whatever the timestamps say
      .filter((l) => seqOf(l) < seqOf(a) && eff(l) <= at && exp(l) > at && (remaining.get(l.id) ?? 0) > 0)
      .sort((x, y) => exp(x) - exp(y) || eff(x) - eff(y) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    let left = a.amount_cents
    const expected = new Map<string, number>()
    for (const l of usable) {
      if (left <= 0) break
      const take = Math.min(left, remaining.get(l.id) ?? 0)
      expected.set(l.id, take)
      left -= take
    }
    if (left > 0) problems.push(`apply ${a.id} of ${a.amount_cents} exceeds the usable credit by ${left}`)
    const actual = new Map<string, number>()
    for (const al of allocs.filter((x) => x.apply_event_id === a.id))
      actual.set(al.lot_event_id, (actual.get(al.lot_event_id) ?? 0) + al.cents)
    const key = (m: Map<string, number>): string => JSON.stringify([...m.entries()].sort())
    if (key(expected) !== key(actual))
      problems.push(
        `apply ${a.id}: stored allocation ${key(actual)} differs from the FIFO replay ${key(expected)}`,
      )
    for (const [lot, c] of expected) remaining.set(lot, (remaining.get(lot) ?? 0) - c)
  }
  // the spendable balance is read from what is actually stored, so a replay mismatch cannot hide a wrong balance
  const stored = new Map<string, number>(lots.map((l) => [l.id, l.amount_cents]))
  for (const al of allocs) stored.set(al.lot_event_id, (stored.get(al.lot_event_id) ?? 0) - al.cents)
  for (const [lot, left] of stored) if (left < 0) problems.push(`lot ${lot} is over-allocated by ${-left}`)
  let balance = 0
  const nowMs = now.getTime()
  for (const l of lots) if (eff(l) <= nowMs && exp(l) > nowMs) balance += stored.get(l.id) ?? 0
  return { balance, problems }
}
