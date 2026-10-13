// The pure parts of the Square core (ADR 0171, wave Q2b): the classifier, the counter matcher R1-R5 (cash too), the exact-sum link
// lines, the link staleness rule, how staff "Send link" goes out, the payment link hosts, the refund leg planner, the POS app-switch
// URLs, and the calc with a failed card refund (golden cases).
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { calcInvoice, type CalcEvent } from '../../src/modules/payments/calc.js'
import { linkDelivery } from '../../src/modules/payments/commands.js'
import { linkHostAllowed, linkHostsFromEnv } from '../../src/modules/payments/ports.js'
import { payHostAllowed } from '../../src/modules/public/links/service.js'
import { cardLabel } from '../../src/modules/payments/repository.js'
import { classifySquarePayment, invoiceNoIn, posCodeIn, type ClassifyContext } from '../../src/modules/square/classify.js'
import type { SquarePaymentFacts } from '../../src/modules/square/facts.js'
import { assertExactSum, balanceLines, LinkSumError, staleReason } from '../../src/modules/square/links.js'
import { planSquarePayment, type MatchContext, type MatchEntry, type MatchInvoice } from '../../src/modules/square/matcher.js'
import { newPosCode, posAppSwitchUrls } from '../../src/modules/square/pos.js'
import { planRefundLegs } from '../../src/modules/square/refunds.js'
import { feeHow } from '../../src/modules/square/deposits.js'
import { squareHealthProblems } from '../../src/modules/square/db/alerts.js'

const at = new Date('2026-06-13T14:30:00Z')

const pay = (o: Partial<SquarePaymentFacts> = {}): SquarePaymentFacts => ({
  paymentId: 'P1',
  status: 'COMPLETED',
  squareLocationId: 'LOC',
  sourceType: 'CARD',
  product: 'SQUARE_POS',
  applicationId: null,
  orderId: 'O1',
  referenceId: null,
  note: null,
  receiptNumber: 'R1',
  receiptUrl: null,
  amountCents: 4280,
  tipCents: 0,
  totalCents: 4280,
  refundedCents: 0,
  brand: 'VISA',
  last4: '4242',
  entryMethod: 'EMV',
  customerId: null,
  buyerEmail: null,
  createdAt: at,
  updatedAt: at,
  ...o,
})

const ctx0: ClassifyContext = { squareLocationId: 'LOC', inLedger: false, link: null, charge: false, membership: false, posIntent: null }

describe('classifier (design 2.3)', () => {
  it('the first rule that applies wins', () => {
    const link = { id: 'L', invoiceId: 'I', purpose: 'balance' as const, expectedCents: 4280, state: 'active' }
    const intent = { id: 'PI', invoiceId: 'I', ledgerEventId: 'E', amountCents: 4280 }
    expect(classifySquarePayment(pay({ status: 'APPROVED' }), ctx0).kind).toBe('waiting')
    expect(classifySquarePayment(pay({ status: 'FAILED' }), ctx0).kind).toBe('ignored')
    expect(classifySquarePayment(pay({ squareLocationId: 'OTHER' }), { ...ctx0, inLedger: true, link }).kind).toBe('ignored')
    expect(classifySquarePayment(pay(), { ...ctx0, inLedger: true, link }).kind).toBe('done')
    expect(classifySquarePayment(pay(), { ...ctx0, link, posIntent: intent })).toEqual({ kind: 'link', link })
    expect(classifySquarePayment(pay(), { ...ctx0, charge: true, posIntent: intent }).kind).toBe('charge')
    expect(classifySquarePayment(pay(), { ...ctx0, membership: true, posIntent: intent }).kind).toBe('membership')
    expect(classifySquarePayment(pay(), { ...ctx0, posIntent: intent })).toEqual({ kind: 'pos_intent', intent })
    expect(classifySquarePayment(pay(), ctx0).kind).toBe('counter')
  })

  it('reads an invoice number and a POS code from a note or reference id', () => {
    expect(invoiceNoIn('INV-20640 · OAS-PI-7KQ2X3')).toBe(20640)
    expect(invoiceNoIn(null, 'inv20641')).toBe(20641)
    expect(invoiceNoIn('wash for INV-12')).toBeNull()
    expect(posCodeIn('INV-20640 · OAS-PI-7KQ2X3')).toBe('OAS-PI-7KQ2X3')
    expect(posCodeIn('no code')).toBeNull()
    expect(newPosCode()).toMatch(/^OAS-PI-[A-Z0-9]{6}$/)
  })
})

const id = (emails: string[] = [], phones: string[] = []) => ({ emails, phones })
const inv = (o: Partial<MatchInvoice> & { id: string }): MatchInvoice => ({
  no: 20000,
  customerId: `C-${o.id}`,
  client: `Client ${o.id}`,
  balanceCents: 4280,
  canceled: false,
  identity: id(),
  ...o,
})
const entry = (o: Partial<MatchEntry> & { eventId: string; invoiceId: string }): MatchEntry => ({
  amountCents: 4280,
  occurredAt: at,
  identity: id(),
  ...o,
})
const ctx = (o: Partial<MatchContext> = {}): MatchContext => ({
  named: null,
  intent: null,
  awaitingCards: [],
  cashEntries: [],
  openInvoices: [],
  payer: id(),
  ...o,
})
const evidence = { automatch: 'evidence' as const }

describe('counter matcher R1-R5 (design 2.4, plan decision 5)', () => {
  it('R1: the invoice number in the note records there, or confirms its staff entry of the same amount; a partial amount too', () => {
    const named = { ...inv({ id: 'A' }), entries: [entry({ eventId: 'E1', invoiceId: 'A' })], cashEntries: [] }
    expect(planSquarePayment(pay(), ctx({ named }), evidence)).toEqual({ action: 'confirm', invoiceId: 'A', eventId: 'E1', rule: 'R1', confidence: 1 })
    expect(planSquarePayment(pay({ amountCents: 1000 }), ctx({ named: { ...named, entries: [] } }), evidence)).toEqual({ action: 'record', invoiceId: 'A', rule: 'R1', confidence: 1 })
    // a staff entry of another amount waits there (a split tender, a partial reader payment): a person decides (review Q4 M1)
    expect(planSquarePayment(pay({ amountCents: 1000 }), ctx({ named }), evidence)).toMatchObject({
      action: 'unmatched',
      reason: 'a staff card entry of another amount is waiting on this invoice',
      candidates: [expect.objectContaining({ invoiceId: 'A' })],
    })
    // a canceled invoice is never paid this way
    expect(planSquarePayment(pay(), ctx({ named: { ...named, canceled: true } }), evidence).action).toBe('unmatched')
  })

  it('R2: the POS intent confirms the entry it wrote', () => {
    const intent = { ...inv({ id: 'B' }), entryId: 'E2', entries: [entry({ eventId: 'E9', invoiceId: 'B' }), entry({ eventId: 'E2', invoiceId: 'B' })] }
    expect(planSquarePayment(pay(), ctx({ intent }), evidence)).toEqual({ action: 'confirm', invoiceId: 'B', eventId: 'E2', rule: 'R2', confidence: 1 })
    // one tender of a split payment (2000 of the 4280 the intent wrote): never new money beside the waiting entry (review Q4 M1)
    expect(planSquarePayment(pay({ amountCents: 2000, totalCents: 2000 }), ctx({ intent }), evidence)).toMatchObject({ action: 'unmatched' })
    expect(planSquarePayment(pay({ amountCents: 2000, totalCents: 2000 }), ctx({ intent: { ...intent, entries: [] } }), evidence)).toMatchObject({ action: 'record', rule: 'R2' })
  })

  it('R3: one staff card entry of the amount (tip excluded) is confirmed; several are narrowed by identity, else unmatched', () => {
    const one = ctx({ awaitingCards: [entry({ eventId: 'E1', invoiceId: 'A' })] })
    expect(planSquarePayment(pay({ tipCents: 500, totalCents: 4780 }), one, evidence)).toMatchObject({ action: 'confirm', eventId: 'E1', rule: 'R3' })
    const two = ctx({
      awaitingCards: [entry({ eventId: 'E1', invoiceId: 'A', identity: id(['a@x.com']) }), entry({ eventId: 'E2', invoiceId: 'B', identity: id(['b@x.com']) })],
      openInvoices: [inv({ id: 'A' }), inv({ id: 'B' })],
    })
    expect(planSquarePayment(pay(), two, evidence)).toMatchObject({ action: 'unmatched' })
    expect(planSquarePayment(pay({ buyerEmail: 'B@x.com' }), { ...two, payer: id(['B@x.com']) }, evidence)).toMatchObject({ action: 'confirm', eventId: 'E2' })
  })

  it('R4: one open invoice of that balance backed by the identity; amount alone only with SQUARE_POS_AUTOMATCH=amount', () => {
    const open = [inv({ id: 'A', identity: id(['maria@x.com'], ['+15555550100']) }), inv({ id: 'B', balanceCents: 999 })]
    expect(planSquarePayment(pay(), ctx({ openInvoices: open, payer: id([], ['+15555550100']) }), evidence)).toEqual({
      action: 'record',
      invoiceId: 'A',
      rule: 'R4',
      confidence: 0.85,
    })
    expect(planSquarePayment(pay(), ctx({ openInvoices: open }), evidence).action).toBe('unmatched')
    expect(planSquarePayment(pay(), ctx({ openInvoices: open }), { automatch: 'amount' })).toMatchObject({ action: 'record', rule: 'R4a', invoiceId: 'A' })
    // two of the amount, one backed: the identity decides
    const twins = [inv({ id: 'A', identity: id(['maria@x.com']) }), inv({ id: 'C' })]
    expect(planSquarePayment(pay(), ctx({ openInvoices: twins, payer: id(['maria@x.com']) }), evidence)).toMatchObject({ action: 'record', invoiceId: 'A' })
    expect(planSquarePayment(pay(), ctx({ openInvoices: twins }), { automatch: 'amount' }).action).toBe('unmatched')
  })

  it('R5: candidates ranked (an entry of the amount, the balance, the payer), at most 5', () => {
    const open = [inv({ id: 'A', no: 1 }), inv({ id: 'B', no: 2, balanceCents: 4280 + 500 }), inv({ id: 'C', no: 3, balanceCents: 1 })]
    const out = planSquarePayment(
      pay({ tipCents: 500, totalCents: 4780 }),
      ctx({ openInvoices: [...open, inv({ id: 'D', no: 4 })], awaitingCards: [entry({ eventId: 'EA', invoiceId: 'A' }), entry({ eventId: 'ED', invoiceId: 'D' })] }),
      evidence,
    )
    expect(out.action).toBe('unmatched')
    if (out.action !== 'unmatched') return
    expect(out.candidates.map((c) => c.invoiceId)).toEqual(['A', 'D', 'B'])
    expect(out.candidates[0]).toMatchObject({ awaitingEventId: 'EA', why: expect.arrayContaining(['staff card entry of this amount', 'balance is this amount']) })
  })

  it('cash: a staff cash entry of the amount only takes the references; otherwise cash follows R1 and R4', () => {
    const cash = pay({ sourceType: 'CASH', brand: null, last4: null })
    expect(planSquarePayment(cash, ctx({ cashEntries: [entry({ eventId: 'K1', invoiceId: 'A' })] }), evidence)).toEqual({
      action: 'attach_cash',
      invoiceId: 'A',
      eventId: 'K1',
      rule: 'cash_entry',
      confidence: 0.95,
    })
    // a staff card entry never takes a cash payment
    expect(planSquarePayment(cash, ctx({ awaitingCards: [entry({ eventId: 'E1', invoiceId: 'A' })] }), evidence).action).toBe('unmatched')
    const named = { ...inv({ id: 'A' }), entries: [], cashEntries: [entry({ eventId: 'K2', invoiceId: 'A' })] }
    expect(planSquarePayment(cash, ctx({ named }), evidence)).toMatchObject({ action: 'attach_cash', eventId: 'K2' })
    expect(planSquarePayment(cash, ctx({ named: { ...named, cashEntries: [] } }), evidence)).toMatchObject({ action: 'record', rule: 'R1' })
    // a staff cash entry of another amount on the named invoice: a person decides (review Q4 M1)
    expect(planSquarePayment({ ...cash, amountCents: 1000, totalCents: 1000 }, ctx({ named }), evidence)).toMatchObject({ action: 'unmatched' })
  })

  it('property: a decision names at most one invoice, and a recording or confirmation only on strong evidence', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.constantFrom('A', 'B', 'C', 'D'), bal: fc.constantFrom(1000, 4280, 5000), mail: fc.boolean() }), { maxLength: 4 }),
        fc.array(fc.record({ inv: fc.constantFrom('A', 'B', 'C', 'D'), amt: fc.constantFrom(1000, 4280) }), { maxLength: 3 }),
        fc.constantFrom(1000, 4280),
        fc.boolean(),
        (invs, ents, amount, payerKnown) => {
          const seen = new Set<string>()
          const open = invs.filter((x) => !seen.has(x.id) && seen.add(x.id)).map((x) => inv({ id: x.id, balanceCents: x.bal, identity: id(x.mail ? ['m@x.com'] : []) }))
          const c = ctx({
            openInvoices: open,
            awaitingCards: ents.map((e, i) => entry({ eventId: `E${i}`, invoiceId: e.inv, amountCents: e.amt })),
            payer: id(payerKnown ? ['m@x.com'] : []),
          })
          const d = planSquarePayment(pay({ amountCents: amount, totalCents: amount }), c, evidence)
          if (d.action === 'record') {
            const target = open.find((i) => i.id === d.invoiceId)!
            expect(target.balanceCents).toBe(amount)
            expect(payerKnown && target.identity.emails.length > 0).toBe(true)
            expect(open.filter((i) => i.balanceCents === amount && i.identity.emails.length > 0 && payerKnown)).toHaveLength(1)
          }
          if (d.action === 'confirm') expect(c.awaitingCards.find((e) => e.eventId === d.eventId)!.amountCents).toBe(amount)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('payment links (design 3.1, 3.3)', () => {
  const calc = { paid: 0, adj: 0, refunded: 0, pendingAmt: 0, tax: 1078, tip: 0, balance: 16478, total: 16478 }
  it('an untouched invoice is its lines, a "Sales tax" line and a "Tip" line, adding up exactly to the balance', () => {
    const items = [
      { name: 'Premium Hand Wash + Interior', priceCents: 12900 },
      { name: 'Rain repellent', priceCents: 2500 },
    ]
    expect(balanceLines({ invoiceNo: 20640 }, items, calc)).toEqual([
      { name: 'Premium Hand Wash + Interior', cents: 12900 },
      { name: 'Rain repellent', cents: 2500 },
      { name: 'Sales tax', cents: 1078 },
    ])
    expect(balanceLines({ invoiceNo: 20640 }, items, { ...calc, tip: 600, balance: 17078, total: 17078 }).at(-1)).toEqual({ name: 'Tip', cents: 600 })
    // anything paid or adjusted: one balance line
    expect(balanceLines({ invoiceNo: 20640 }, items, { ...calc, paid: 2500, balance: 13978 })).toEqual([{ name: 'Balance due · INV-20640', cents: 13978 }])
    // lines that do not add up are never sent
    expect(() => balanceLines({ invoiceNo: 1 }, [{ name: 'x', priceCents: 100 }], calc)).toThrow(LinkSumError)
    expect(() => assertExactSum([{ name: 'a', cents: 0 }], 0)).toThrow(LinkSumError)
  })

  it('a link stops when the invoice no longer owes exactly its amount', () => {
    const l = { purpose: 'balance' as const, expectedCents: 4280, createdAt: at }
    const s = { canceled: false, balanceCents: 4280, depositPaid: false }
    expect(staleReason(l, s, at)).toBeNull()
    expect(staleReason(l, { ...s, canceled: true }, at)).toEqual({ reason: 'invoice_canceled', state: 'canceled' })
    expect(staleReason(l, { ...s, balanceCents: 0 }, at)).toEqual({ reason: 'paid_elsewhere', state: 'canceled' })
    expect(staleReason(l, { ...s, balanceCents: 4000 }, at)).toEqual({ reason: 'amount_changed', state: 'canceled' })
    expect(staleReason(l, s, new Date(at.getTime() + 8 * 86_400_000))).toEqual({ reason: 'expired', state: 'expired' })
    const dep = { purpose: 'deposit' as const, expectedCents: 2500, createdAt: at }
    expect(staleReason(dep, { ...s, balanceCents: 9000 }, at)).toBeNull()
    expect(staleReason(dep, { ...s, depositPaid: true }, at)).toEqual({ reason: 'deposit_paid', state: 'canceled' })
    expect(staleReason(dep, { ...s, balanceCents: 2000 }, at)).toEqual({ reason: 'amount_changed', state: 'canceled' })
  })

  it('staff Send link: Squarespace before the cutover; with Square the personal page while links are on, else a Square link', () => {
    expect(linkDelivery({ PAYMENT_PROCESSOR: 'squarespace', PUBLIC_LINKS_ENABLED: true }, 'balance')).toBe('squarespace')
    expect(linkDelivery({ PAYMENT_PROCESSOR: 'square', PUBLIC_LINKS_ENABLED: true }, 'balance')).toBe('personal')
    expect(linkDelivery({ PAYMENT_PROCESSOR: 'square', PUBLIC_LINKS_ENABLED: false }, 'balance')).toBe('square')
    expect(linkDelivery({ PAYMENT_PROCESSOR: 'square', PUBLIC_LINKS_ENABLED: true }, 'deposit')).toBe('square')
  })

  it('payment link hosts: Squarespace until the cutover, Square always, the sandbox outside production; PAYMENT_LINK_HOSTS wins', () => {
    expect(linkHostsFromEnv(undefined, { production: true })).toEqual(['squarespace.com', '=square.link', '=checkout.square.site'])
    expect(linkHostsFromEnv(undefined, { processor: 'square', production: true })).toEqual(['=square.link', '=checkout.square.site'])
    expect(linkHostsFromEnv(undefined, { processor: 'square', production: false })).toEqual(['=square.link', '=checkout.square.site', '=sandbox.square.link', 'squareupsandbox.com'])
    expect(linkHostsFromEnv('pay.example.com', { processor: 'square' })).toEqual(['pay.example.com'])
  })

  it('Square hosts are exact: another seller’s square.site store and the sandbox are refused in production (review Q4 SEC-3, SQ-SEM-4)', () => {
    const prod = linkHostsFromEnv(undefined, { processor: 'square', production: true })
    const today = linkHostsFromEnv(undefined, { production: true })
    for (const hosts of [prod, today]) {
      expect(payHostAllowed('https://square.link/u/AbCdEf12', hosts)).toBe(true)
      expect(payHostAllowed('https://checkout.square.site/merchant/M1/checkout/C1', hosts)).toBe(true)
      expect(payHostAllowed('https://some-other-seller.square.site/product/gift-card/1', hosts)).toBe(false)
      expect(payHostAllowed('https://square.site/x', hosts)).toBe(false)
      expect(payHostAllowed('https://sandbox.square.link/u/AbCdEf12', hosts)).toBe(false)
      expect(payHostAllowed('https://connect.squareupsandbox.com/v2/online-checkout/x', hosts)).toBe(false)
    }
    // Squarespace keeps matching its subdomains until the cutover (PAYMENT_LINK_HOSTS as documented)
    expect(payHostAllowed('https://oasis.squarespace.com/checkout', today)).toBe(true)
    // outside production the sandbox's links pass
    const dev = linkHostsFromEnv(undefined, { processor: 'square', production: false })
    expect(payHostAllowed('https://sandbox.square.link/u/AbCdEf12', dev)).toBe(true)
    // PAYMENT_LINK_HOSTS never brings the sandbox into production
    expect(linkHostsFromEnv('square.link,sandbox.square.link,squareupsandbox.com,=checkout.square.site', { production: true })).toEqual(['square.link', '=checkout.square.site'])
    expect(linkHostAllowed('SANDBOX.square.link.', ['=sandbox.square.link'])).toBe(true)
    // a plain square.link entry never lets the sandbox's subdomain through
    expect(payHostAllowed('https://sandbox.square.link/u/AbCdEf12', linkHostsFromEnv('square.link', { production: true }))).toBe(false)
  })

  it('the booking answer reads card_hold (wave Q3a) as at the counter', () => {
    expect(feeHow('link')).toBe('link')
    expect(feeHow('counter')).toBe('counter')
    expect(feeHow('card_hold')).toBe('counter')
  })
})

describe('card label', () => {
  it('names Square brands with the last four, never invents digits', () => {
    expect(cardLabel('VISA', '4242')).toEqual({ label: 'Visa ••4242', brand: 'visa' })
    expect(cardLabel('AMERICAN_EXPRESS', '0005')).toEqual({ label: 'Amex ••0005', brand: 'amex' })
    expect(cardLabel('visa')).toEqual({ label: 'Visa', brand: 'visa' })
    expect(cardLabel(null, 'abcd')).toEqual({ label: 'Card', brand: null })
  })
})

describe('refund legs (design 3.6)', () => {
  const p = (paymentId: string, totalCents: number, usedCents: number, minutes: number) => ({
    paymentId,
    totalCents,
    usedCents,
    occurredAt: new Date(at.getTime() + minutes * 60_000),
  })
  it('newest payment first, each capped by what it can still give back (tip included); null when it cannot be covered', () => {
    expect(planRefundLegs([p('old', 5000, 0, 0), p('new', 3000, 0, 10)], 2000)).toEqual([{ paymentId: 'new', amountCents: 2000 }])
    expect(planRefundLegs([p('old', 5000, 0, 0), p('new', 3000, 1000, 10)], 4000)).toEqual([
      { paymentId: 'new', amountCents: 2000 },
      { paymentId: 'old', amountCents: 2000 },
    ])
    expect(planRefundLegs([p('a', 1000, 0, 0)], 1001)).toBeNull()
    expect(planRefundLegs([], 100)).toBeNull()
  })
  it('property: the legs add up to the amount and never exceed a payment', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 0, max: 10_000 })), { maxLength: 4 }), fc.integer({ min: 1, max: 30_000 }), (pays, amount) => {
        const refs = pays.map(([total, used], i) => p(`P${i}`, total, Math.min(used, total), i))
        const legs = planRefundLegs(refs, amount)
        const room = refs.reduce((s, r) => s + r.totalCents - r.usedCents, 0)
        if (room < amount) {
          expect(legs).toBeNull()
          return
        }
        expect(legs!.reduce((s, l) => s + l.amountCents, 0)).toBe(amount)
        for (const l of legs!) {
          const r = refs.find((x) => x.paymentId === l.paymentId)!
          expect(l.amountCents).toBeLessThanOrEqual(r.totalCents - r.usedCents)
        }
      }),
      { numRuns: 300 },
    )
  })
})

describe('POS app switch (design 2.6)', () => {
  it('builds the iOS and Android URLs with the amount, the note, the state and the callback', () => {
    const u = posAppSwitchUrls({ amountCents: 4280, note: 'INV-20640 · OAS-PI-7KQ2X3', state: 'st4te-random-0001', callbackUrl: 'https://app.example.com/payments/square-callback', clientId: 'sq0idp-app' })
    expect(u.ios.startsWith('square-commerce-v1://payment/create?data=')).toBe(true)
    const data = JSON.parse(decodeURIComponent(u.ios.split('data=')[1]!))
    expect(data).toMatchObject({ amount_money: { amount: 4280, currency_code: 'USD' }, client_id: 'sq0idp-app', version: '1.3', state: 'st4te-random-0001', notes: 'INV-20640 · OAS-PI-7KQ2X3' })
    expect(u.android).toMatch(/^intent:#Intent;action=com\.squareup\.pos\.action\.CHARGE;/)
    expect(u.android).toContain('i.com.squareup.pos.TOTAL_AMOUNT=4280')
    expect(u.android).toMatch(/;end$/)
  })
})

describe('calc with a failed card refund (ADR 0171 D4; golden)', () => {
  const base = { itemPrices: [10_000], taxBp: 700, tipCents: 0, canceled: false }
  const payE: CalcEvent = { type: 'pay', amountCents: 10_700 }
  it('a refund Square reported failed is not refunded: refundable, net, status and the original-tender cap come back', () => {
    const done = calcInvoice({ ...base, events: [payE, { type: 'refund', amountCents: 4000, status: 'done', dest: 'card', processorState: 'confirmed' }] })
    const waiting = calcInvoice({ ...base, events: [payE, { type: 'refund', amountCents: 4000, status: 'done', dest: 'card', processorState: 'awaiting_processor' }] })
    const failed = calcInvoice({ ...base, events: [payE, { type: 'refund', amountCents: 4000, status: 'done', dest: 'card', processorState: 'failed' }] })
    const none = calcInvoice({ ...base, events: [payE] })
    expect(done).toMatchObject({ refunded: 4000, refOrig: 4000, refundable: 6700, status: 'partially_refunded' })
    expect(waiting).toEqual(done)
    expect(failed).toEqual(none)
    expect(failed).toMatchObject({ refunded: 0, refOrig: 0, refundable: 10_700, toOrigMax: 10_700, net: 10_000, status: 'paid' })
    // canceled and fully refunded, but the refund failed: the deposit is kept, not refunded
    const canceled = calcInvoice({ ...base, canceled: true, events: [payE, { type: 'refund', amountCents: 10_700, status: 'done', dest: 'card', processorState: 'failed' }] })
    expect(canceled.status).toBe('canceled_kept')
  })
})

describe('Square health alerts', () => {
  const now = new Date('2026-06-13T15:00:00Z')
  const ago = (m: number) => new Date(now.getTime() - m * 60_000)
  const ok = { last_catchup_at: ago(5), watermark: ago(15), last_catchup_claimed_at: null, last_webhook_at: ago(1), last_error: null, last_error_at: null }
  it('nothing with the simulator; a refused token, a stale catch-up and silent webhooks once live', () => {
    expect(squareHealthProblems({ SQUARE_PROVIDER: 'sim' }, undefined, now)).toEqual([])
    expect(squareHealthProblems({ SQUARE_PROVIDER: 'live' }, ok, now)).toEqual([])
    expect(squareHealthProblems({ SQUARE_PROVIDER: 'live' }, undefined, now).map((p) => p.key)).toEqual(['square_catchup'])
    const bad = { ...ok, last_catchup_at: ago(45), last_catchup_claimed_at: ago(60), last_webhook_at: ago(26 * 60), last_error: 'catch-up: Square GET /v2/events -> 401 UNAUTHORIZED', last_error_at: ago(30) }
    expect(squareHealthProblems({ SQUARE_PROVIDER: 'live' }, bad, now).map((p) => p.key)).toEqual(['square_auth', 'square_catchup', 'square_webhook'])
  })
})
