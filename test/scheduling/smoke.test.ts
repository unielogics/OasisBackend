import { describe, expect, it } from 'vitest'
import { getAvailability } from '../../src/modules/scheduling/availability-loader.js'
import { loadSnapshot } from '../../src/modules/scheduling/snapshot.js'
import { useOps } from './helpers.js'

const o = useOps()

describe('smoke', () => {
  it('books, reads the board and the availability', async () => {
    const r = await o.book({ at: '2026-06-13T14:30:00-04:00', serviceName: 'Premium Hand Wash + Interior' })
    expect(r.appointment.status).toBe('booked')
    expect(r.invoice.invoiceNo).toBe(20611)
    const snap = await loadSnapshot(o.t.db, o.ctx, { window: 'next24', canContact: true })
    expect(snap.timeline.count).toBe(1)
    const av = await getAvailability(o.t.db, {
      locationId: o.locationId,
      tz: o.ctx.tz,
      now: o.clock.now(),
      date: '2026-06-13',
      serviceId: o.svc('Premium Hand Wash + Interior').id,
      channel: 'desk',
    })
    expect(av.slots.length).toBeGreaterThan(5)
    console.log(JSON.stringify(av.slots.map((s) => `${s.label}:${s.state}`)))
    console.log(JSON.stringify(snap.kpis))
  })
})
