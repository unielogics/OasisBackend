// GET /invoices/:id carries refundCaps, the caps the refund command applies per destination after done and pending refunds,
// so the refund sheet can say before sending what the server would answer. Each case below is one of the money review's
// findings (2: card refund of cash money, 7: pending card refunds reserve the card cap, 14: store credit cashed out) or a
// plain invoice; for every destination the caps must predict the command's answer exactly: the error code of every refused
// amount around the caps, and the success of the largest amount allowed.
import { describe, expect, it } from 'vitest'
import { addEvent, makeInvoice, type MadeInvoice } from './helpers.js'
import { usePayHarness, type Person } from './http.js'

const p = usePayHarness()

type Dest = 'card' | 'cash' | 'credit'
interface Caps {
  cardCents: number
  otherCents: number
  totalCents: number
}

/** The refund command's checks in its own order (commands.ts refund): what it answers for `val` to `dest`. */
function predict(c: Caps, dest: Dest, val: number): string | null {
  if (dest === 'card' && val > c.cardCents) return 'REFUND_EXCEEDS_CARD'
  if (val > c.totalCents) return 'REFUND_EXCEEDS_REFUNDABLE'
  if (dest === 'cash' && val > c.otherCents) return 'REFUND_EXCEEDS_ORIGINAL'
  return null
}

const visa = { method: 'Visa', methodKind: 'card' as const, processorState: 'confirmed' as const }

interface Case {
  name: string
  build: () => Promise<MadeInvoice>
  caps: Caps
}

const CASES: Case[] = [
  {
    name: 'paid in full by card',
    build: async () => {
      const inv = await makeInvoice(p.h.t.db, p.env(), {
        items: [{ name: 'Express Hand Wash', priceCents: 10000 }],
      })
      await addEvent(p.h.t.db, p.env(), inv, { type: 'pay', amountCents: 10700, ...visa })
      return inv
    },
    caps: { cardCents: 10700, otherCents: 10700, totalCents: 10700 },
  },
  {
    name: 'paid in full in cash (finding 2: nothing can go back to a card)',
    build: async () => {
      const inv = await makeInvoice(p.h.t.db, p.env(), {
        items: [{ name: 'Express Hand Wash', priceCents: 10000 }],
      })
      await addEvent(p.h.t.db, p.env(), inv, {
        type: 'pay',
        amountCents: 10700,
        method: 'Cash',
        methodKind: 'cash',
      })
      return inv
    },
    caps: { cardCents: 0, otherCents: 10700, totalCents: 10700 },
  },
  {
    name: 'cash 70.00 + card 37.00 (finding 2: the card part only)',
    build: async () => {
      const inv = await makeInvoice(p.h.t.db, p.env(), {
        items: [{ name: 'Express Hand Wash', priceCents: 10000 }],
      })
      await addEvent(p.h.t.db, p.env(), inv, {
        type: 'pay',
        amountCents: 7000,
        method: 'Cash',
        methodKind: 'cash',
      })
      await addEvent(p.h.t.db, p.env(), inv, { type: 'pay', amountCents: 3700, ...visa })
      return inv
    },
    caps: { cardCents: 3700, otherCents: 10700, totalCents: 10700 },
  },
  {
    name: 'card 120.00 + store credit 59.76, a 100.00 card refund waiting for approval (finding 7)',
    build: async () => {
      const inv = await makeInvoice(p.h.t.db, p.env(), {
        items: [{ name: 'Executive Detail', priceCents: 16800 }],
      })
      await addEvent(p.h.t.db, p.env(), inv, { type: 'pay', amountCents: 12000, ...visa })
      await addEvent(p.h.t.db, p.env(), inv, {
        type: 'credit_apply',
        amountCents: 5976,
        method: 'Store credit',
        methodKind: 'store_credit',
      })
      const pending = await p.send(p.people().sofia, 'POST', `invoices/${inv.id}/refunds`, {
        mode: 'custom',
        amountCents: 10000,
        dest: 'card',
      })
      expect(pending.json()).toMatchObject({ event: { status: 'pending' } })
      return inv
    },
    caps: { cardCents: 2000, otherCents: 2000, totalCents: 7976 },
  },
  {
    name: 'paid with store credit only (finding 14: credit never comes back as money)',
    build: async () => {
      const inv = await makeInvoice(p.h.t.db, p.env(), {
        items: [{ name: 'Express Hand Wash', priceCents: 4000 }],
      })
      const { sofia } = p.people()
      expect(
        (await p.send(sofia, 'POST', `invoices/${inv.id}/credits`, { amountCents: 3000, expiry: 'none' }))
          .statusCode,
      ).toBe(201)
      expect((await p.send(sofia, 'POST', `invoices/${inv.id}/credit-applications`, {})).statusCode).toBe(201)
      return inv
    },
    caps: { cardCents: 0, otherCents: 0, totalCents: 3000 },
  },
  {
    name: 'paid by card and refunded in full to store credit (the card cap stays above what is refundable)',
    build: async () => {
      const inv = await makeInvoice(p.h.t.db, p.env(), {
        items: [{ name: 'Express Hand Wash', priceCents: 10000 }],
      })
      await addEvent(p.h.t.db, p.env(), inv, { type: 'pay', amountCents: 10700, ...visa })
      const r = await p.send(p.people().rafael, 'POST', `invoices/${inv.id}/refunds`, {
        mode: 'full',
        dest: 'credit',
      })
      expect(r.statusCode).toBe(201)
      return inv
    },
    caps: { cardCents: 10700, otherCents: 10700, totalCents: 0 },
  },
]

async function capsOf(who: Person, id: string): Promise<Caps> {
  const res = await p.get(who, `invoices/${id}`)
  expect(res.statusCode).toBe(200)
  return (res.json() as { refundCaps: Caps }).refundCaps
}

describe('GET /invoices/:id refundCaps', () => {
  // one test per case (the harness signs five people in before each test); each destination gets its own invoice
  for (const c of CASES) {
    it(`${c.name}: the caps predict every answer of a refund to card, cash and store credit`, async () => {
      const { rafael } = p.people()
      for (const dest of ['card', 'cash', 'credit'] as const) {
        const inv = await c.build()
        const caps = await capsOf(rafael, inv.id)
        expect(caps).toEqual(c.caps)

        const probes = [
          ...new Set([1, caps.cardCents, caps.otherCents, caps.totalCents].flatMap((v) => [v, v + 1])),
        ]
          .filter((v) => v > 0)
          .sort((a, b) => a - b)
        // refused amounts first (they change nothing), then the largest allowed one
        for (const val of probes.filter((v) => predict(caps, dest, v) !== null)) {
          const res = await p.send(rafael, 'POST', `invoices/${inv.id}/refunds`, {
            mode: 'custom',
            amountCents: val,
            dest,
          })
          expect(res.statusCode, `${val} to ${dest}: ${res.body.slice(0, 200)}`).toBe(422)
          expect((res.json() as { code: string }).code, `${val} to ${dest}`).toBe(predict(caps, dest, val))
        }
        const allowed = probes.filter((v) => predict(caps, dest, v) === null)
        if (allowed.length) {
          const val = Math.max(...allowed)
          const res = await p.send(rafael, 'POST', `invoices/${inv.id}/refunds`, {
            mode: 'custom',
            amountCents: val,
            dest,
          })
          expect(res.statusCode, `${val} to ${dest}: ${res.body.slice(0, 200)}`).toBe(201)
          const after = (res.json() as { invoice: { refundCaps: Caps } }).invoice.refundCaps
          expect(after.totalCents).toBe(caps.totalCents - val)
          if (dest === 'card') expect(after.cardCents).toBe(caps.cardCents - val)
          if (dest !== 'credit') expect(after.otherCents).toBe(caps.otherCents - val)
          expect(await capsOf(rafael, inv.id)).toEqual(after)
        } else {
          expect(Math.min(dest === 'card' ? caps.cardCents : caps.otherCents, caps.totalCents)).toBe(0)
        }
      }
    })
  }
})
