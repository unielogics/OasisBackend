// Oracle: the board of the ORIGINAL Operations bundle at 2026-06-13 10:36 AM (test/golden/ops/original.json, extracted
// with extract/extract-original.ts) against the backend's snapshot for the parity-ops seed. Every value must match
// exactly except the deviations listed here and in DEVIATIONS.md; the test fails if a listed deviation stops happening.
import { describe, expect, it } from 'vitest'
import { getAvailability } from '../../../src/modules/scheduling/availability-loader.js'
import { evaluateStart, type Slot } from '../../../src/modules/scheduling/availability.js'
import { loadSnapshot, type OpsSnapshot, type BayCard } from '../../../src/modules/scheduling/snapshot.js'
import { asDeviations, diff } from './diff.js'
import { original, useParityOps, type Card } from './parity.js'

const w = useParityOps()

/** a1..a12 for the design appointments, the uuid for the procedural ones. */
const designId = (id: string): string => [...w.ids].find(([, v]) => v === id)?.[0] ?? id

function card(c: OpsSnapshot['queue'][number]): Card {
  return {
    id: designId(c.id),
    name: c.customer.name,
    vip: c.vip,
    member: c.member?.label ?? '',
    vehicleLine: c.vehicleLine,
    service: c.service,
    time: c.time,
    badgeLabel: c.badge.label,
    bayLabel: c.bayLabel,
    durLabel: c.durLabel,
    payLabel: c.pay.label,
    nextLabel: c.next.label,
    hasNotes: c.hasNotes,
    hasPhotos: c.hasPhotos,
    hasAddons: c.hasAddons,
    addonCount: c.addonCount,
  }
}

const bayShape = (b: BayCard): Record<string, unknown> =>
  b.occupant
    ? {
        name: b.name,
        occupied: true,
        free: false,
        vehicle: [b.occupant.card.vehicle?.year, b.occupant.card.vehicle?.make, b.occupant.card.vehicle?.model].join(' '),
        customer: b.occupant.card.customer.name,
        plate: b.occupant.card.vehicle?.plate,
        service: b.occupant.card.service,
        worker: b.occupant.worker?.name,
        workerInitials: b.occupant.worker?.initials,
        elapsed: b.occupant.elapsedLabel,
        eta: b.occupant.estCompletionLabel,
        progressLabel: b.occupant.progressLabel,
        durLabel: b.occupant.durLabel,
        nextLabel: b.occupant.card.next.label,
        badgeLabel: b.occupant.card.badge.label,
      }
    : { name: b.name, free: true, occupied: false, nextUp: b.nextUp }

async function board(window: 'next24' | 'today' | 'tomorrow' | 'week') {
  const snap = await loadSnapshot(w.t.db, w.ctx, { window, canContact: true })
  const cards: Record<string, Card> = {}
  for (const c of [...snap.timeline.groups.flatMap((g) => g.items), ...snap.queue]) cards[designId(c.id)] = card(c)
  return { snap, cards }
}

describe('the board at 10:36 AM (original.initial vs /ops/snapshot next24)', () => {
  it('matches the original except the documented deviations', async () => {
    const { snap, cards } = await board('next24')
    const o = original.initial

    // the lists, as ids in order
    const groups = snap.timeline.groups.map((g) => ({ dividerLabel: g.divider, time: g.time, ampm: g.ampm, items: g.items.map((i) => designId(i.id)) }))
    expect(groups).toEqual(o.groups.map((g) => ({ ...g, items: g.items.map((i) => i.id) })))
    expect(snap.timeline.count).toBe(o.apptCount)
    expect(snap.inFacilityLabel).toBe(o.inFacilityLabel)

    // Up Next: VIP first, top six. Aisha Rahman is a VIP client (Settings design) though a9 carries no vip flag.
    expect(o.queue.map((c) => c.id)).toEqual(['a6', 'a11', 'a7', 'a5', 'a8', 'a9'])
    expect(snap.queue.map((c) => designId(c.id))).toEqual(['a6', 'a9', 'a11', 'a7', 'a5', 'a8'])

    // alerts: titles, descriptions, actions and the order, all identical
    expect(snap.alerts.map((a) => ({ glyph: a.glyph, title: a.title, desc: a.desc, actionLabel: a.actionLabel, pri: a.priority }))).toEqual(o.alerts)

    // cards
    const originalCards: Record<string, Card> = {}
    for (const c of [...o.groups.flatMap((g) => g.items), ...o.queue]) originalCards[c.id] = c
    expect(asDeviations(diff(originalCards, cards))).toEqual({
      'a5.payLabel': ['Deposit · $228 due', 'Deposit · $228.20 due'],
      'a7.payLabel': ['Deposit · $114 due', 'Deposit · $113.75 due'],
      'a8.payLabel': ['$48 due', '$48.15 due'],
      'a9.vip': [false, true],
      'a10.payLabel': ['$48 due', '$48.15 due'],
      'a11.payLabel': ['$696 due', '$695.50 due'],
    })

    // KPIs
    expect(
      asDeviations(diff(o.kpis, snap.kpis.map((k) => ({ label: k.label, value: k.value, sub: k.sub })))),
    ).toEqual({
      '[0].sub': ['12 booked', '7 booked'],
      '[3].sub': ['$1,299', '$1,298.53'],
      '[4].value': ['3.5h', '2.8h'],
      '[6].value': ['$1,488', '$1,487.48'],
    })
  })

  it('the numbers behind the deviating KPIs (DEVIATIONS.md 2-4): cents and minutes', async () => {
    const { snap } = await board('next24')
    const raw = Object.fromEntries(snap.kpis.map((k) => [k.key, k.raw]))
    expect(raw).toEqual({
      appointments24h: 12,
      activeJobs: 1,
      readyForPickup: 1,
      // a3 16478 + a5 22820 + a7 11375 + a8 4815 + a10 4815 + a11 69550
      pendingPayments: 129_853,
      // 768 bay-minutes left (2 bays x 384) less 601 committed
      bayTimeFree: 167,
      membersToday: 6,
      // a1 9895 + a2 42125 + a4 19688 + a6 19260 + a9 57780
      revenueToday: 148_748,
    })
  })

  it('completed column, bays, arrivals and staff columns', async () => {
    const { snap } = await board('next24')
    const o = original.initial
    expect(snap.completed.count).toBe(o.completedCount)
    expect(
      snap.completed.items.map((c) => ({
        id: designId(c.id),
        name: c.customer.name,
        time: c.time,
        vehicleLine: c.vehicleLine,
        service: c.service,
        payChipLabel: c.pay.kind === 'paid' ? 'Paid' : 'Unpaid · collect',
        pickupChipLabel: c.pickupState === 'collected' ? 'Picked up' : 'Needs pickup',
      })),
    ).toEqual(o.completed)

    expect(asDeviations(diff(o.bays, snap.bays.map(bayShape)))).toEqual({
      '[0].eta': ['11:15 AM', '11:24 AM'],
    })
    expect(
      snap.arrivals.map((a) => ({ title: a.title, desc: a.desc, prepLabel: a.prepLabel })),
    ).toEqual(o.arrivals)
    expect(
      snap.staff.map((s) => ({
        name: s.name,
        role: s.role,
        initials: s.initials,
        count: s.count,
        jobs: s.jobs.map((j) => ({ id: designId(j.id), name: j.customer.name, time: j.time })),
      })),
    ).toEqual(o.staffCols)
  })
})

describe('the range tabs', () => {
  it.each(['today', 'tomorrow', 'next24'] as const)('%s lists what the original lists', async (range) => {
    const { snap } = await board(range)
    const o = original.ranges[range]
    expect(snap.timeline.count).toBe(o.apptCount)
    expect(snap.timeline.groups.map((g) => g.items.map((i) => designId(i.id)))).toEqual(
      o.groups.map((g) => g.items.map((i) => i.id)),
    )
    expect(snap.completed.items.map((c) => designId(c.id))).toEqual(o.completed.map((c) => c.id))
  })

  it('week is today through today + 6: it also lists the procedural days that follow, where the original repeats Next 24h', async () => {
    const { snap } = await board('week')
    const o = original.ranges.week
    expect(o.apptCount).toBe(original.ranges.next24.apptCount)
    const procedural = original.dayCounts.filter((d) => d.offset >= 2 && d.offset <= 6).reduce((n, d) => n + d.count, 0)
    expect(procedural).toBeGreaterThan(0)
    expect(snap.timeline.count).toBe(o.apptCount + procedural)
    expect(snap.completed.count).toBe(o.completedCount)
  })
})

describe('the New Appointment slot grid at 10:36 AM (default package, desk)', () => {
  it('reproduces the blocked slots; the hard-coded VIP holds and the cutoff differ', async () => {
    const pkg = await w.t.db.selectFrom('services').select('id').where('name', '=', 'Premium Hand Wash + Interior').executeTakeFirstOrThrow()
    const av = await getAvailability(w.t.db, {
      locationId: w.locationId,
      tz: w.ctx.tz,
      now: w.ctx.clock.now(),
      date: '2026-06-13',
      serviceId: pkg.id,
      channel: 'desk',
    })
    const byLabel = new Map<string, Slot>(av.slots.map((s) => [s.label, s]))
    const classify = (s: { label: string; opacity: number }): string =>
      s.label.endsWith(' · VIP') ? 'vip_held' : s.opacity === 0.6 ? 'blocked' : 'available'
    const stateAt = (label: string): string => {
      const s = byLabel.get(label)
      if (s) return s.state
      return 'cutoff' // 4:30 PM is after the last start (close - cutoff)
    }
    const got: Record<string, string> = {}
    const want: Record<string, string> = {}
    for (const s of original.slots) {
      const time = s.label.replace(' · VIP', '')
      want[time] = classify(s)
      got[time] = stateAt(time)
    }
    expect(want).toEqual({
      '10:30 AM': 'available',
      '11:00 AM': 'blocked',
      '11:30 AM': 'vip_held',
      '12:30 PM': 'vip_held',
      '1:00 PM': 'blocked',
      '2:30 PM': 'available',
      '4:00 PM': 'available',
      '4:30 PM': 'available',
    })
    expect(asDeviations(diff(want, got))).toEqual({
      '10:30 AM': ['available', 'past'],
      '11:30 AM': ['vip_held', 'blocked'],
      '12:30 PM': ['vip_held', 'blocked'],
      '4:30 PM': ['available', 'cutoff'],
    })
    expect(evaluateStart).toBeTypeOf('function')
  })
})
