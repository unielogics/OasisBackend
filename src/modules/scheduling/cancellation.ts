// The deposit policy of a cancel or a no-show, as pure functions (ADR 0082): which share of the money held on the invoice is
// kept, the sentence that explains it, and the texts the activity log and the customer get. The ledger work lives in
// settlement.ts; nothing here touches the database.
import { divHalfUp, formatUsd } from '../../platform/money.js'

export interface CancellationPolicy {
  /** Cancelling at least this many hours before the start refunds the held money in full. */
  freeCancelHours: number
  /** Inside that window (or after the start) this share of the held money is kept, in basis points. */
  lateRetainBp: number
  /** A no-show keeps this share. */
  noShowRetainBp: number
  /** Where a refund goes: the tender the money came in on, or store credit. */
  refundTo: 'original' | 'credit'
}

export type SettlementKind = 'canceled' | 'no_show'

/** The share of the held money that stays with the shop, and why. */
export interface RetentionRule {
  retainBp: number
  text: string
}

const pct = (bp: number): string => `${Number((bp / 100).toFixed(2))}%`

/** "47h" or "25 min"; "0 min" at or after the start. */
export function leadLabel(leadMin: number): string {
  if (leadMin <= 0) return '0 min'
  return leadMin >= 60 ? `${Math.floor(leadMin / 60)}h` : `${Math.floor(leadMin)} min`
}

function keptPhrase(retainBp: number): string {
  if (retainBp >= 10_000) return 'deposit kept'
  if (retainBp <= 0) return 'refunded in full'
  return `${pct(retainBp)} of the deposit kept`
}

export function retentionRule(
  p: CancellationPolicy,
  o: { kind: SettlementKind; leadMin: number },
): RetentionRule {
  if (o.kind === 'no_show') {
    return { retainBp: p.noShowRetainBp, text: `No-show · ${keptPhrase(p.noShowRetainBp)}` }
  }
  const lead = leadLabel(o.leadMin)
  const when = o.leadMin <= 0 ? 'Canceled after the start time' : `Canceled ${lead} ahead`
  if (o.leadMin >= p.freeCancelHours * 60)
    return {
      retainBp: 0,
      text: `${when} · free cancellation up to ${p.freeCancelHours}h before · refunded in full`,
    }
  return {
    retainBp: p.lateRetainBp,
    text: `${when} · inside the ${p.freeCancelHours}h free cancellation window · ${keptPhrase(p.lateRetainBp)}`,
  }
}

/** Splits the money held: the kept share rounds half-up, the rest is refunded. */
export function splitHeld(heldCents: number, retainBp: number): { retained: number; refund: number } {
  const retained = Math.min(heldCents, divHalfUp(heldCents * retainBp, 10_000))
  return { retained, refund: heldCents - retained }
}

export type RefundDestination = 'card' | 'cash' | 'credit'

export interface SettledRefundView {
  amountCents: number
  dest: RefundDestination
  state: 'done' | 'pending'
  awaitingProcessor: boolean
}

export interface SettlementView {
  heldCents: number
  refundedCents: number
  retainedCents: number
  refunds: SettledRefundView[]
}

const destPhrase: Record<RefundDestination, { log: string; text: string }> = {
  card: { log: 'to the card', text: 'is being refunded to your card' },
  cash: { log: 'in cash', text: 'will be returned in cash' },
  credit: { log: 'to store credit', text: 'was added to your store credit' },
}

/** Activity-log lines, in order: one per refund, then the kept share. `by` names the rule that decided ("cancellation policy"). */
export function activityLines(s: SettlementView, by: string): string[] {
  const out: string[] = []
  for (const r of s.refunds) {
    const where = destPhrase[r.dest].log
    if (r.state === 'pending')
      out.push(`Deposit refund requested · ${formatUsd(r.amountCents)} ${where} (needs approval)`)
    else
      out.push(
        `Deposit refunded · ${formatUsd(r.amountCents)} ${where}${r.awaitingProcessor ? ' (awaiting Squarespace)' : ''}`,
      )
  }
  if (s.retainedCents > 0) out.push(`Deposit kept · ${formatUsd(s.retainedCents)} (${by})`)
  return out
}

/** The sentence about the money in the cancellation text; '' when nothing was held. */
export function depositSentence(s: SettlementView): string {
  if (s.heldCents <= 0) return ''
  const held = formatUsd(s.heldCents)
  const kept =
    s.retainedCents > 0 ? `${formatUsd(s.retainedCents)} is kept under our cancellation policy` : ''
  const refunds = s.refunds
  if (refunds.length === 0) return `Your ${held} deposit is kept under our cancellation policy.`
  if (refunds.every((r) => r.state === 'pending'))
    return `Your ${formatUsd(s.refundedCents)} deposit refund is being reviewed.${kept ? ` ${kept[0]!.toUpperCase()}${kept.slice(1)}.` : ''}`
  if (refunds.length === 1) {
    const r = refunds[0]!
    const phrase = destPhrase[r.dest].text
    return s.retainedCents === 0
      ? `Your ${held} deposit ${phrase}.`
      : `${formatUsd(r.amountCents)} of your ${held} deposit ${phrase}; ${kept}.`
  }
  const parts = refunds.map((r) => `${formatUsd(r.amountCents)} ${destPhrase[r.dest].text}`)
  return `Your ${held} deposit: ${parts.join(' and ')}${kept ? `; ${kept}` : ''}.`
}
