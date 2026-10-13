// K4 review (ADR 0180): what an unlocked kiosk may change about the money a client owes. Anyone at the tablet can act (attribution is
// honest-use), so a tip it sets is bounded, a paid tip is never lowered into an overpaid invoice (for anyone), and a payment link it
// texts is for the balance, on the invoice's own link or an exact shop host only (kiosk:F3, tax:H4, tax:M2).
import { describe, expect, it } from 'vitest'
import { kioskLinkHostAllowed, kioskTipMax } from '../../src/modules/payments/commands.js'
import { kioskWorld as makeWorld, type KioskWorld } from './world.js'
import { idemKey, useRig } from '../scheduling-gaps/support.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

const m = useRig()
const A = '/api/v1'
const db = () => m.h.t.db
const sup = () => m.superS()

const kiosk = (w: KioskWorld, method: 'POST' | 'PUT', url: string, body: unknown = {}) =>
  m.h.kioskCall(method, `${A}/${url}`, w.kiosk, { actor: w.marco.employeeId, body, headers: { 'idempotency-key': idemKey() } })

async function completedVisit() {
  const v = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T14:00:00-04:00')
  await m.complete(v.appointmentId)
  return v
}

/** The bill before the tip (subtotal + tax), as the kiosk tip bound reads it. */
async function billOf(id: string): Promise<number> {
  const j = (await m.get(sup(), `/invoices/${id}`)).json() as Json
  const d = (j.invoice ?? j) as Json
  return (d.calc.sub as number) + (d.calc.tax as number)
}

describe('tips', () => {
  it('a kiosk sets a tip up to half the bill (at least $20), never $5,000 to charge a saved card with', async () => {
    const w = await makeWorld(m.h)
    const v = await completedVisit()
    const bill = await billOf(v.invoiceId)
    expect(bill).toBeGreaterThan(0)
    const huge = await kiosk(w, 'PUT', `invoices/${v.invoiceId}/tip`, { tipCents: 500_000 })
    expect(huge.statusCode, huge.body).toBe(422)
    expect((huge.json() as Json).code).toBe('PAY_TIP_KIOSK_LIMIT')
    expect((huge.json() as Json).detail).toBe(`On the kiosk a tip can be at most $${(kioskTipMax(bill) / 100).toFixed(2)}. Ask a manager for a bigger tip.`)
    expect((await kiosk(w, 'PUT', `invoices/${v.invoiceId}/tip`, { tipCents: kioskTipMax(bill) })).statusCode).toBe(200)
    // a manager signed in is not bound by it
    expect((await m.send(sup(), 'PUT', `/invoices/${v.invoiceId}/tip`, { tipCents: 500_000 })).statusCode).toBe(200)
    // and the kiosk may still lower a tip nobody paid yet
    expect((await kiosk(w, 'PUT', `invoices/${v.invoiceId}/tip`, { tipCents: 500 })).statusCode).toBe(200)
  })

  it('a paid tip is never lowered into an overpaid invoice, on the kiosk or signed in', async () => {
    const w = await makeWorld(m.h)
    const v = await completedVisit()
    expect((await m.send(sup(), 'PUT', `/invoices/${v.invoiceId}/tip`, { tipCents: 2000 })).statusCode).toBe(200)
    const paid = await kiosk(w, 'POST', `invoices/${v.invoiceId}/payments`, { method: 'cash' })
    expect(paid.statusCode, paid.body).toBe(201)
    for (const call of [
      () => kiosk(w, 'PUT', `invoices/${v.invoiceId}/tip`, { tipCents: 0 }),
      () => m.send(sup(), 'PUT', `/invoices/${v.invoiceId}/tip`, { tipCents: 1999 }),
    ]) {
      const r = await call()
      expect(r.statusCode, r.body).toBe(409)
      expect((r.json() as Json).code).toBe('PAY_TIP_BELOW_PAID')
    }
    const row = await db().selectFrom('invoices').select('tip_cents').where('id', '=', v.invoiceId).executeTakeFirstOrThrow()
    expect(row.tip_cents).toBe(2000)
    // raising it is fine (the client then owes the difference)
    expect((await m.send(sup(), 'PUT', `/invoices/${v.invoiceId}/tip`, { tipCents: 2500 })).statusCode).toBe(200)
  })
})

describe('payment links from a kiosk', () => {
  it('a pasted link on a whole domain (any store on squarespace.com) is refused; the invoice’s own link is sent', async () => {
    const w = await makeWorld(m.h)
    const v = await completedVisit()
    const phish = await kiosk(w, 'POST', `invoices/${v.invoiceId}/payment-links`, {
      kind: 'balance',
      url: 'https://totally-not-oasis.squarespace.com/checkout/pay-now',
    })
    expect(phish.statusCode, phish.body).toBe(422)
    expect((phish.json() as Json).code).toBe('PAYMENT_LINK_KIOSK_URL')
    const viaCollect = await kiosk(w, 'POST', `invoices/${v.invoiceId}/payments`, {
      method: 'payment_link',
      url: 'https://totally-not-oasis.squarespace.com/checkout/pay-now',
    })
    expect(viaCollect.statusCode, viaCollect.body).toBe(422)
    expect(await db().selectFrom('payment_links').select('id').execute()).toEqual([])

    await db().updateTable('invoices').set({ payment_link_url: 'https://oasis-auto-spa.squarespace.com/checkout/inv-1' }).where('id', '=', v.invoiceId).execute()
    const own = await kiosk(w, 'POST', `invoices/${v.invoiceId}/payment-links`, { kind: 'balance' })
    expect(own.statusCode, own.body).toBe(201)
    expect((own.json() as Json).paymentLink.url).toBe('https://oasis-auto-spa.squarespace.com/checkout/inv-1')
    // a manager signed in may still paste one (the allow-list applies as before)
    const pasted = await m.send(sup(), 'POST', `/invoices/${v.invoiceId}/payment-links`, {
      kind: 'balance',
      url: 'https://oasis-auto-spa.squarespace.com/checkout/inv-2',
    })
    expect(pasted.statusCode, pasted.body).toBe(201)
  })

  it('a deposit link or a typed amount is not a kiosk action', async () => {
    const w = await makeWorld(m.h)
    const v = await completedVisit()
    await db().updateTable('invoices').set({ payment_link_url: 'https://oasis-auto-spa.squarespace.com/checkout/inv-1' }).where('id', '=', v.invoiceId).execute()
    for (const body of [{ kind: 'deposit', amountCents: 2500 }, { kind: 'balance', amountCents: 99_900 }]) {
      const r = await kiosk(w, 'POST', `invoices/${v.invoiceId}/payment-links`, body)
      expect(r.statusCode, JSON.stringify(body)).toBe(403)
      expect((r.json() as Json).code).toBe('PAYMENT_LINK_KIOSK')
    }
    expect(await db().selectFrom('payment_links').select('id').execute()).toEqual([])
  })

  it('a pasted kiosk link must be on a host PAYMENT_LINK_HOSTS names exactly, never Square’s shared link hosts', () => {
    const def = ['squarespace.com', '=square.link', '=checkout.square.site']
    expect(kioskLinkHostAllowed('https://oasis-auto-spa.squarespace.com/x', def)).toBe(false)
    expect(kioskLinkHostAllowed('https://square.link/u/abc', def)).toBe(false)
    const pinned = ['=oasis-auto-spa.squarespace.com', '=square.link']
    expect(kioskLinkHostAllowed('https://oasis-auto-spa.squarespace.com/checkout/1', pinned)).toBe(true)
    expect(kioskLinkHostAllowed('https://evil.oasis-auto-spa.squarespace.com/checkout/1', pinned)).toBe(false)
    expect(kioskLinkHostAllowed('https://totally-not-oasis.squarespace.com/x', pinned)).toBe(false)
    expect(kioskLinkHostAllowed('not a url', pinned)).toBe(false)
    expect(kioskTipMax(4815)).toBe(2408)
    expect(kioskTipMax(1000)).toBe(2000)
  })
})
