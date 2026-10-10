// GET /public/availability and GET /public/catalog over the real app and the design seed: the board's states from the real rows,
// the bays-open-now pill, the cache header, no personal or operations data, and the catalog keys the writes take.
import { describe, expect, it } from 'vitest'
import { bookingBody, json, keysOf, usePublicHarness, TODAY } from './harness.js'

const h = usePublicHarness()

// nothing a visitor may learn about people or jobs
const FORBIDDEN = /name$|^id$|Id$|customer|phone|email|plate|vehicle|appointment|notes|message|employee|staff|invoice|cents/i

describe('GET /public/availability', () => {
  it('shows the next five days from the real rows: today from now + 30 min, Sunday closed, a VIP hold, free bays per slot', async () => {
    const r = await h.get('public/availability')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.headers['cache-control']).toBe('public, max-age=60')
    const b = json(r)
    expect(b.tz).toBe('America/New_York')
    expect(b.generatedAt).toBe('2026-06-13T14:36:00.000Z')
    expect(b.serviceKey).toBe(h.key('Express Hand Wash'))
    expect(b.durationMin).toBeGreaterThan(0)
    expect(b.now).toEqual({ open: true, baysFree: 2, baysTotal: 2 })
    expect(b.days).toHaveLength(5)
    const [today, sunday, monday] = b.days
    expect(today).toMatchObject({ date: TODAY, label: 'Today', dateLabel: 'Saturday, Jun 13', weekday: 6, closed: false })
    expect(today.slots[0]).toMatchObject({ startMin: 690, start: '11:30 AM', state: 'open', bays: 2 })
    expect(today.openCount).toBe(today.slots.length)
    // the design seed keeps Sunday open 9 to 3 (the production Settings close it; the Settings test covers that flip)
    expect(sunday).toMatchObject({ date: '2026-06-14', label: 'Tomorrow' })
    expect(monday).toMatchObject({ date: '2026-06-15', label: 'Mon', closed: false })
    expect([...keysOf(b)].filter((k) => FORBIDDEN.test(k))).toEqual([])
  })

  it('reflects a booking at once: the slot loses a bay, then is booked when both bays are taken', async () => {
    const slot = (days: { date: string; slots: { startMin: number; state: string; bays: number }[] }[]) =>
      days.find((d) => d.date === TODAY)!.slots.find((s) => s.startMin === 13 * 60)!
    expect(slot(json(await h.get('public/availability')).days)).toMatchObject({ state: 'open', bays: 2 })
    expect((await h.post('public/bookings', bookingBody(h))).statusCode).toBe(201)
    expect(slot(json(await h.get('public/availability')).days)).toMatchObject({ state: 'last', bays: 1 })
    expect((await h.post('public/bookings', bookingBody(h, { phone: '+12015550106', name: 'Second Guest' }))).statusCode).toBe(201)
    expect(slot(json(await h.get('public/availability')).days)).toMatchObject({ state: 'booked', bays: 0 })
    const pill = json(await h.get('public/availability')).now
    expect(pill).toEqual({ open: true, baysFree: 2, baysTotal: 2 }) // 1:00 PM jobs do not occupy a bay at 10:36
  })

  it('marks a VIP-held time as vip for everyone (Friday 4:00 PM is held in the seed)', async () => {
    const b = json(await h.get('public/availability?days=7'))
    const friday = b.days.find((d: { date: string }) => d.date === '2026-06-19')
    expect(friday.label).toBe('Fri')
    expect(friday.slots.find((s: { startMin: number }) => s.startMin === 960)).toMatchObject({ state: 'vip' })
  })

  it('takes a service key and a day count, ignores add-ons, and refuses an unknown service (422)', async () => {
    const r = json(await h.get(`public/availability?days=2&service=${h.key('Full Detail')}&addons=wax,odor-removal`))
    expect(r.days).toHaveLength(2)
    expect(r.serviceKey).toBe(h.key('Full Detail'))
    const bad = await h.get('public/availability?service=no-such-wash')
    expect(bad.statusCode).toBe(422)
    expect(json(bad).errors[0].path).toBe('query.service')
    expect((await h.get('public/availability?days=99')).statusCode).toBe(422)
  })

  it('takes the query exactly as the website writes it, add-ons as the site encodes them included', async () => {
    const wash = h.key('Full Detail')
    for (const q of [
      '',
      '?days=14',
      `?days=7&service=${wash}&addons=wax%2Codor-removal`, // encodeURIComponent of "wax,odor-removal"
      `?days=7&service=${wash}&addons=wax,odor-removal`,
      `?days=7&service=${wash}&addons=`,
      `?service=${wash}&days=7`,
    ])
      expect((await h.get(`public/availability${q}`)).statusCode, q).toBe(200)
  })

  it('refuses every other spelling of the query (422), so nothing can be used to miss the cache (review 2026-10-10)', async () => {
    const wash = h.key('Full Detail')
    for (const q of [
      '?days=5&zz=1', // an unknown parameter
      '?days=5&cachebust=123',
      '?days=014', // the same number, spelled differently
      '?days=%31%34',
      '?days=1.0',
      '?days=+1',
      '?days=0',
      '?days=15',
      '?days=5&days=6', // twice
      '?%64ays=5', // an encoded name
      `?service=${wash.replace('-', '%2D')}`, // an encoded key
      `?service=${wash.toUpperCase()}`,
      '?addons=<script>',
      `?addons=${'a,'.repeat(40)}a`,
    ]) {
      const r = await h.get(`public/availability${q}`)
      expect(r.statusCode, q).toBe(422)
      expect(json(r).code, q).toBe('VALIDATION_FAILED')
    }
    for (const route of ['public/catalog?x=1', 'public/hours?x=1', 'public/hours?_=1700000000'])
      expect((await h.get(route)).statusCode, route).toBe(422)
    expect((await h.get('public/catalog')).statusCode).toBe(200)
    expect((await h.get('public/hours')).statusCode).toBe(200)
  })

  it('closes a day the shop closes, with the closure name, and shows "closed" in the pill after an emergency', async () => {
    const created = await h.staff('POST', 'closures', { date: '2026-06-15', name: 'Inventory day', type: 'closed', notify: false })
    expect(created.statusCode, created.body).toBe(201)
    const monday = json(await h.get('public/availability')).days.find((d: { date: string }) => d.date === '2026-06-15')
    expect(monday).toMatchObject({ closed: true, reason: 'Inventory day', openCount: 0, slots: [] })
    const closed = await h.staff('POST', 'emergency/close', { reason: 'Severe weather', dur: 'today' })
    expect(closed.statusCode, closed.body).toBe(201)
    const b = json(await h.get('public/availability'))
    expect(b.now).toEqual({ open: false, baysFree: 0, baysTotal: 2 })
    expect(b.days[0]).toMatchObject({ date: TODAY, slots: [] })
  })
})

describe('GET /public/catalog', () => {
  it('lists the live packages and add-ons with keys, durations and prices in cents, and the two website plans', async () => {
    const r = await h.get('public/catalog')
    expect(r.statusCode).toBe(200)
    expect(r.headers['cache-control']).toBe('public, max-age=60')
    const b = json(r)
    const express = b.services.find((s: { name: string }) => s.name === 'Express Hand Wash')
    expect(express).toMatchObject({ key: 'express-hand-wash', durationMin: expect.any(Number), priceCents: expect.any(Number) })
    expect(express.priceCents).toBeGreaterThan(0)
    expect(b.addons.find((a: { name: string }) => a.name === 'Wax')).toMatchObject({ key: 'wax' })
    expect(b.addons.every((a: { priceCents: number }) => Number.isInteger(a.priceCents))).toBe(true)
    expect(b.plans.map((p: { key: string; name: string; planKey: string; priceCents: null }) => [p.key, p.name, p.planKey, p.priceCents])).toEqual([
      ['gold', 'Gold', 'premium', null],
      ['vip', 'VIP', 'executive', null],
    ])
    expect(new Set(b.services.map((s: { key: string }) => s.key)).size).toBe(b.services.length)
    expect([...keysOf(b)].filter((k) => /customer|phone|email|^id$|Id$/.test(k))).toEqual([])
  })
})
