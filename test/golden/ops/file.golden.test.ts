// Oracle: per-appointment values of the original (checklist progress, photo counts, totals and balances) against the
// appointment file and the invoice summaries of the parity-ops seed.
import { describe, expect, it } from 'vitest'
import { loadAppointmentFile } from '../../../src/modules/scheduling/file.js'
import type { AuthContext } from '../../../src/http/authorizer.js'
import { original, useParityOps } from './parity.js'

const w = useParityOps()
const auth: AuthContext = {
  userId: '00000000-0000-7000-8000-000000000001',
  employeeId: null,
  locationId: '',
  permissions: new Set(['*']),
}

/** Golden cents for the design appointments that Payments' vectors name (INV-20603..20608). */
const GOLDEN_TOTALS: Record<string, number> = { a3: 16478, a4: 19688, a5: 27820, a7: 13375, a9: 57780 }

describe.each(original.appointments)('$id ($time, $svc)', (o) => {
  it('checklist progress and sections match the original', async () => {
    const file = await loadAppointmentFile(w.t.db, w.ctx, { ...auth, locationId: w.locationId }, w.ids.get(o.id)!)
    expect({ done: file.checklist.done, total: file.checklist.total, pct: `${file.checklist.pct}%` }).toEqual({
      done: o.checkDone,
      total: o.checkTotal,
      pct: o.checkPct,
    })
    expect(
      file.checklist.sections.map((s) => ({
        title: s.title,
        kind: s.kind === 'package' ? 'Package' : 'Add-on',
        countLabel: `${s.done} / ${s.total}`,
      })),
    ).toEqual(o.sections)
  })

  it('photo counts, notes, visits and status match', async () => {
    const file = await loadAppointmentFile(w.t.db, w.ctx, { ...auth, locationId: w.locationId }, w.ids.get(o.id)!)
    expect({
      arrival: file.photos.arrival.count,
      before: file.photos.before.count,
      after: file.photos.after.count,
      issue: file.photos.issue.count,
    }).toEqual(o.photos)
    expect(file.status).toBe(o.status)
    expect(file.overview.service.name).toBe(o.svc)
    expect(file.overview.staff.name).toBe(o.staff === 'Unassigned' ? 'Unassigned' : o.staff)
    expect(file.addons.selected.map((a) => a.name)).toEqual(o.addons)
    expect(file.overview.specialInstructions).toBe(o.special)
    // notes: the design's default text for "none" is the absence of a note here
    expect(file.overview.notes).toBe(o.notes === 'No special instructions on file.' ? null : o.notes)
  })

  it('totals: the subtotal is exact, tax and total are in cents (the design rounds to whole dollars)', async () => {
    const inv = (await w.gateway.summariesFor(w.t.db, [w.ids.get(o.id)!])).get(w.ids.get(o.id)!)!
    expect(inv.subtotalCents).toBe(o.sub * 100)
    // the same half-up rule, at cent precision: the design's whole-dollar tax is the cent tax rounded to a dollar
    expect(Math.round(inv.taxCents / 100)).toBe(o.tax)
    expect(inv.totalCents).toBe(inv.subtotalCents + inv.taxCents + o.tip * 100)
    if (GOLDEN_TOTALS[o.id]) expect(inv.totalCents).toBe(GOLDEN_TOTALS[o.id])
    // balance: paid in full -> 0; deposit -> total less the deposit; unpaid -> total
    const expectedBalance = o.pay === 'paid' ? 0 : o.pay === 'deposit' ? inv.totalCents - o.deposit * 100 : inv.totalCents
    expect(inv.balanceCents).toBe(expectedBalance)
    expect(Math.round(inv.balanceCents / 100)).toBe(Math.round(o.balance))
  })
})

describe('the deviations in totals', () => {
  it('lists the cents the design rounds away', async () => {
    const rows: Record<string, [number, number]> = {}
    for (const o of original.appointments) {
      const inv = (await w.gateway.summariesFor(w.t.db, [w.ids.get(o.id)!])).get(w.ids.get(o.id)!)!
      if (inv.totalCents !== o.grand * 100) rows[o.id] = [o.grand, inv.totalCents / 100]
    }
    expect(rows).toEqual({
      a1: [99, 98.95],
      a2: [421, 421.25],
      a3: [165, 164.78],
      a4: [197, 196.88],
      a5: [278, 278.2],
      a6: [193, 192.6],
      a7: [134, 133.75],
      a8: [48, 48.15],
      a9: [578, 577.8],
      a10: [48, 48.15],
      a11: [696, 695.5],
      a12: [139, 139.1],
    })
  })
})
