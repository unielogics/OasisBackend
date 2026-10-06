import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../../src/platform/random.js'
import {
  isAutoApplicable,
  matchArrivals,
  type Arrival,
  type LedgerEventRef,
  type PaymentLinkRef,
} from '../../src/modules/payments-sync/matcher.js'
import type { IdentityRef } from '../../src/modules/payments-sync/identity.js'
import { H, T0, arrival, cfg, event, invoice, link } from './matcher-helpers.js'

/**
 * Randomised scenarios over the whole decision space. The invariants are the binding rules from the reviews:
 * nothing auto-applies below the threshold, a payment is never both confirmed and recorded, no ledger object is used
 * twice, and a staff-recorded unconfirmed payment of the same amount never lets the link rule create a second pay event.
 */
const people: IdentityRef[] = [
  { emails: ['a@example.com'], phones: ['5550000001'] },
  { emails: ['b@example.com'], phones: ['5550000002'] },
  { emails: [], phones: ['5550000003'] },
  { emails: [], phones: [] },
]

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!
}

function scenario(seed: number) {
  const rng = mulberry32(seed)
  const amount = pick(rng, [5000, 6313, 20223])
  const who = pick(rng, people)
  const arrivals: Arrival[] = Array.from({ length: 1 + Math.floor(rng() * 3) }, (_, i) =>
    arrival({
      transactionId: `t${i}`,
      kind: rng() < 0.2 ? 'refund' : 'payment',
      amountCents: rng() < 0.7 ? amount : pick(rng, [amount - 1, amount + 100, 100]),
      occurredAt: new Date(T0.getTime() + Math.floor(rng() * 6) * 12 * H),
      email: rng() < 0.7 ? who.emails[0] : undefined,
      phone: rng() < 0.5 ? who.phones[0] : undefined,
    }),
  )
  const events: LedgerEventRef[] = Array.from({ length: Math.floor(rng() * 4) }, (_, i) =>
    event({
      id: `e${i}`,
      type: rng() < 0.25 ? 'refund' : 'pay',
      invoiceId: `inv-${Math.floor(rng() * 3)}`,
      customer: rng() < 0.7 ? who : pick(rng, people),
      amountCents: rng() < 0.7 ? amount : pick(rng, [amount + 1, 2000]),
      occurredAt: new Date(T0.getTime() - Math.floor(rng() * 80) * H),
      processorState: pick(rng, ['awaiting_processor', 'awaiting_processor', 'confirmed', 'na'] as const),
      status: pick(rng, ['done', 'done', 'pending', 'denied'] as const),
      sqspOrderId: rng() < 0.25 ? 'ord-1' : undefined,
      processorRef: rng() < 0.2 ? pick(rng, ['t0', 't1', 'tx']) : undefined,
    }),
  )
  const links: PaymentLinkRef[] = Array.from({ length: Math.floor(rng() * 3) }, (_, i) =>
    link({
      id: `l${i}`,
      invoiceId: `inv-${i}`,
      state: pick(rng, ['active', 'active', 'paid', 'expired'] as const),
      expectedCents: rng() < 0.7 ? amount : amount + 50,
      customer: rng() < 0.7 ? who : pick(rng, people),
      sentAt: new Date(T0.getTime() - Math.floor(rng() * 20) * 24 * H),
      invoice: invoice({ id: `inv-${i}`, balanceCents: pick(rng, [0, amount, amount * 2]), payEvents: [] }),
    }),
  )
  return { arrivals, events, links, orderInvoiceId: rng() < 0.5 ? 'inv-0' : undefined }
}

describe('matcher invariants over 3000 random scenarios', () => {
  it('holds every binding rule', () => {
    const config = cfg()
    for (let seed = 1; seed <= 3000; seed++) {
      const s = scenario(seed)
      const decisions = matchArrivals(
        { kind: 'payments', alerts: [], arrivals: s.arrivals },
        { events: s.events, links: s.links, orderInvoiceId: s.orderInvoiceId },
        config,
      )
      expect(decisions).toHaveLength(s.arrivals.length)

      const usedEvents = new Set<string>()
      const usedLinks = new Set<string>()
      for (const d of decisions) {
        const where = `seed ${seed} ${d.kind}`
        // nothing auto-applies below the threshold
        if (isAutoApplicable(d, config))
          expect(d.confidence.score, where).toBeGreaterThanOrEqual(config.confidenceThreshold)
        if (d.kind === 'manual_queue' || d.kind === 'defer')
          expect(isAutoApplicable(d, config), where).toBe(false)
        if (d.kind === 'confirm_awaiting' || d.kind === 'create_payment')
          expect(d.confidence.score, where).toBeGreaterThanOrEqual(config.confidenceThreshold)
        // pay decisions only for payments, refund decisions only for refunds
        if (d.kind === 'confirm_awaiting' || d.kind === 'create_payment')
          expect(d.arrival.kind, where).toBe('payment')
        if (d.kind === 'confirm_refund' || d.kind === 'record_external_refund')
          expect(d.arrival.kind, where).toBe('refund')
        // a payment arrival's decision never mixes rules
        if (d.kind === 'create_payment') {
          expect(d.paymentLinkId, where).toBeTruthy()
          expect(usedLinks.has(d.paymentLinkId), where).toBe(false)
          usedLinks.add(d.paymentLinkId)
          // the link rule must not run when an equal-amount awaiting event exists for the same identity in the window
          const clash = s.events.filter(
            (e) =>
              e.type === 'pay' &&
              e.processorState === 'awaiting_processor' &&
              e.status !== 'denied' &&
              e.amountCents === d.arrival.amountCents &&
              Math.abs(e.occurredAt.getTime() - d.arrival.occurredAt.getTime()) <= config.awaitingWindowMs &&
              !usedEvents.has(e.id),
          )
          expect(clash, where).toEqual([])
        }
        if (d.kind === 'confirm_awaiting' || d.kind === 'confirm_refund' || d.kind === 'already_recorded') {
          expect(usedEvents.has(d.eventId), where).toBe(false)
          usedEvents.add(d.eventId)
        }
        // never target a denied event or a settled invoice
        if (d.kind === 'confirm_awaiting' || d.kind === 'confirm_refund') {
          expect(s.events.find((e) => e.id === d.eventId)!.status, where).not.toBe('denied')
        }
        if (d.kind === 'create_payment') {
          const l = s.links.find((x) => x.id === d.paymentLinkId)!
          expect(l.invoice.balanceCents, where).toBeGreaterThan(0)
          expect(l.state, where).not.toBe('canceled')
        }
      }
    }
  })

  it('is deterministic: the same scenario always yields the same decisions', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = scenario(seed)
      const run = () =>
        matchArrivals(
          { kind: 'payments', alerts: [], arrivals: s.arrivals },
          { events: s.events, links: s.links, orderInvoiceId: s.orderInvoiceId },
          cfg(),
        )
      expect(JSON.stringify(run())).toBe(JSON.stringify(run()))
    }
  })

  it('exercises every decision kind (the generator is not vacuous)', () => {
    const kinds = new Set<string>()
    for (let seed = 1; seed <= 3000; seed++) {
      const s = scenario(seed)
      for (const d of matchArrivals(
        { kind: 'payments', alerts: [], arrivals: s.arrivals },
        { events: s.events, links: s.links, orderInvoiceId: s.orderInvoiceId },
        cfg(),
      ))
        kinds.add(d.kind)
    }
    expect([...kinds].sort()).toEqual(
      [
        'already_recorded',
        'confirm_awaiting',
        'confirm_refund',
        'create_payment',
        'defer',
        'manual_queue',
        'record_external_refund',
      ].sort(),
    )
  })
})
