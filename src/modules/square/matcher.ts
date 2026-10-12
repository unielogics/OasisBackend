// The counter (POS) matcher (ADR 0171 D6, plan decision 5, design 2.4): a pure decision over a snapshot the caller loads. A Square
// payment taken on the POS app or reader is recorded automatically only on strong evidence; everything else goes to the "Square
// payments to match" queue with ranked candidates. The caller re-checks the decision under the invoice lock (payments.ts), and the
// ledger keys make a second recording impossible.
//
//   R1  the invoice number in the note or reference id   record on that invoice, or confirm its awaiting entry of the same amount
//   R2  a POS intent (the dashboard's app switch)          the same, on the intent's invoice
//   R3  exactly one staff "Square reader" (awaiting card) entry of the same amount (tip excluded), narrowed by the client's
//       identity when there are several                    confirm it (the tip is recorded on top)
//   R4  exactly one open invoice of the day whose balance is the amount, backed by the client's identity (the payer's email or
//       phone is the invoice client's)                     record
//   R4a (SQUARE_POS_AUTOMATCH=amount only) exactly one open invoice of the day whose balance is the amount   record
//   R5  anything else                                     unmatched, with ranked candidates
// Cash taken in the POS app of the same amount as a staff cash entry (no processor reference yet) only attaches its references (no
// new money); otherwise cash follows R1, R2 and R4 like a card. A partial amount is recorded only under R1 or R2.
import type { SquareCandidate, SquareMatchRule } from './db/schema.js'
import type { SquarePaymentFacts } from './facts.js'

export interface Identity {
  emails: readonly string[]
  phones: readonly string[]
}

export interface MatchInvoice {
  id: string
  no: number
  customerId: string
  client: string
  balanceCents: number
  canceled: boolean
  identity: Identity
}

export interface MatchEntry {
  eventId: string
  invoiceId: string
  amountCents: number
  occurredAt: Date
  identity: Identity
}

export interface MatchContext {
  /** R1: the invoice the note or reference id names (null when none or unknown). */
  named: (MatchInvoice & { entries: MatchEntry[]; cashEntries: MatchEntry[] }) | null
  /** R2: the POS intent's invoice and the awaiting entry the intent wrote. */
  intent: (MatchInvoice & { entryId: string | null; entries: MatchEntry[] }) | null
  /** Staff card entries still awaiting the processor, unclaimed, in the window around the payment. */
  awaitingCards: readonly MatchEntry[]
  /** Staff cash entries with no processor reference, in the window around the payment. */
  cashEntries: readonly MatchEntry[]
  /** Open invoices of the business day (and the days either side) with a balance. */
  openInvoices: readonly MatchInvoice[]
  /** The payer, as Square knows them (buyer email, the Square customer's email and phone). */
  payer: Identity
}

export interface MatchOptions {
  automatch: 'evidence' | 'amount'
}

export type MatchDecision =
  | { action: 'confirm'; invoiceId: string; eventId: string; rule: SquareMatchRule; confidence: number }
  | { action: 'record'; invoiceId: string; rule: SquareMatchRule; confidence: number }
  | { action: 'attach_cash'; invoiceId: string; eventId: string; rule: 'cash_entry'; confidence: number }
  | { action: 'unmatched'; reason: string; candidates: SquareCandidate[] }

const lower = (xs: readonly string[]): Set<string> => new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))

/** The payer's email or phone is one of the client's. */
export function identityBacks(payer: Identity, client: Identity): boolean {
  const pe = lower(payer.emails)
  const pp = lower(payer.phones)
  return client.emails.some((e) => pe.has(e.trim().toLowerCase())) || client.phones.some((p) => pp.has(p.trim().toLowerCase()))
}

const isCash = (p: SquarePaymentFacts): boolean => p.sourceType === 'CASH'

function onInvoice(
  p: SquarePaymentFacts,
  inv: { id: string; entries: readonly MatchEntry[]; cashEntries?: readonly MatchEntry[] },
  rule: 'R1' | 'R2',
  preferEventId?: string | null,
): MatchDecision {
  if (isCash(p)) {
    const cash = (inv.cashEntries ?? []).filter((e) => e.amountCents === p.amountCents)
    if (cash.length >= 1) return { action: 'attach_cash', invoiceId: inv.id, eventId: cash[0]!.eventId, rule: 'cash_entry', confidence: 1 }
    return { action: 'record', invoiceId: inv.id, rule, confidence: 1 }
  }
  const same = inv.entries.filter((e) => e.amountCents === p.amountCents)
  const preferred = preferEventId ? same.find((e) => e.eventId === preferEventId) : undefined
  const entry = preferred ?? same[0]
  if (entry) return { action: 'confirm', invoiceId: inv.id, eventId: entry.eventId, rule, confidence: 1 }
  return { action: 'record', invoiceId: inv.id, rule, confidence: 1 }
}

export function planSquarePayment(p: SquarePaymentFacts, ctx: MatchContext, o: MatchOptions): MatchDecision {
  // R2: the POS intent of the dashboard's app switch (checked first: its note also names the invoice, and the intent says which entry)
  if (ctx.intent && !ctx.intent.canceled) return onInvoice(p, ctx.intent, 'R2', ctx.intent.entryId)
  // R1: the invoice number in the note or reference id (a canceled invoice is never paid this way: a person decides)
  if (ctx.named && !ctx.named.canceled) return onInvoice(p, ctx.named, 'R1')

  if (isCash(p)) {
    const cash = ctx.cashEntries.filter((e) => e.amountCents === p.amountCents)
    if (cash.length === 1)
      return { action: 'attach_cash', invoiceId: cash[0]!.invoiceId, eventId: cash[0]!.eventId, rule: 'cash_entry', confidence: 0.95 }
    if (cash.length > 1) {
      const backed = cash.filter((e) => identityBacks(ctx.payer, e.identity))
      if (backed.length === 1)
        return { action: 'attach_cash', invoiceId: backed[0]!.invoiceId, eventId: backed[0]!.eventId, rule: 'cash_entry', confidence: 0.95 }
      return unmatched(p, ctx, 'several staff cash entries of this amount')
    }
  } else {
    // R3: one staff "Square reader" entry of the same amount (the tip is not part of amount_money)
    const same = ctx.awaitingCards.filter((e) => e.amountCents === p.amountCents)
    if (same.length === 1) return { action: 'confirm', invoiceId: same[0]!.invoiceId, eventId: same[0]!.eventId, rule: 'R3', confidence: 0.95 }
    if (same.length > 1) {
      const backed = same.filter((e) => identityBacks(ctx.payer, e.identity))
      if (backed.length === 1)
        return { action: 'confirm', invoiceId: backed[0]!.invoiceId, eventId: backed[0]!.eventId, rule: 'R3', confidence: 0.95 }
      return unmatched(p, ctx, 'several staff card entries of this amount')
    }
  }

  // R4: one open invoice of that balance, backed by the client's identity
  const exact = ctx.openInvoices.filter((i) => !i.canceled && i.balanceCents === p.amountCents)
  const backed = exact.filter((i) => identityBacks(ctx.payer, i.identity))
  if (backed.length === 1) return { action: 'record', invoiceId: backed[0]!.id, rule: 'R4', confidence: 0.85 }
  // R4a: amount only, when the owner turned it on
  if (o.automatch === 'amount' && backed.length === 0 && exact.length === 1)
    return { action: 'record', invoiceId: exact[0]!.id, rule: 'R4a', confidence: 0.8 }
  return unmatched(p, ctx, exact.length > 1 ? 'several open invoices of this amount' : 'no strong evidence')
}

/** R5: the invoices a person would look at first, best first (at most 5). */
export function rankCandidates(p: SquarePaymentFacts, ctx: MatchContext): SquareCandidate[] {
  const by = new Map<string, SquareCandidate>()
  const add = (inv: MatchInvoice, points: number, why: string, awaitingEventId: string | null = null): void => {
    const c = by.get(inv.id) ?? {
      invoiceId: inv.id,
      invoiceNo: inv.no,
      client: inv.client,
      balanceCents: inv.balanceCents,
      awaitingEventId: null,
      score: 0,
      why: [],
    }
    c.score += points
    if (!c.why.includes(why)) c.why.push(why)
    if (awaitingEventId && !c.awaitingEventId) c.awaitingEventId = awaitingEventId
    by.set(inv.id, c)
  }
  const invoices = new Map(ctx.openInvoices.map((i) => [i.id, i]))
  if (ctx.named) add(ctx.named, 5, ctx.named.canceled ? 'named in the note (canceled)' : 'named in the note')
  if (ctx.intent) add(ctx.intent, 5, 'opened from Oasis')
  const entries = isCash(p) ? ctx.cashEntries : ctx.awaitingCards
  for (const e of entries) {
    const inv = invoices.get(e.invoiceId)
    if (!inv) continue
    if (e.amountCents === p.amountCents) add(inv, 3, isCash(p) ? 'staff cash entry of this amount' : 'staff card entry of this amount', isCash(p) ? null : e.eventId)
  }
  for (const inv of ctx.openInvoices) {
    if (inv.canceled) continue
    if (inv.balanceCents === p.amountCents) add(inv, 3, 'balance is this amount')
    else if (inv.balanceCents === p.totalCents) add(inv, 2, 'balance is this amount with the tip')
    if (identityBacks(ctx.payer, inv.identity)) add(inv, 2, 'same client as the payer')
  }
  return [...by.values()].sort((a, b) => b.score - a.score || a.invoiceNo - b.invoiceNo).slice(0, 5)
}

function unmatched(p: SquarePaymentFacts, ctx: MatchContext, reason: string): MatchDecision {
  return { action: 'unmatched', reason, candidates: rankCandidates(p, ctx) }
}
