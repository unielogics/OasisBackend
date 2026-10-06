// "Needs attention" rules 1-12: conditions, copy, order, priority. Pure: rows are built in memory.
import { describe, expect, it } from 'vitest'
import { wallToInstant } from '../../src/platform/time.js'
import { buildAlerts } from '../../src/modules/scheduling/alerts.js'
import type { AppointmentRecord } from '../../src/modules/scheduling/appointments.js'
import type { BoardRow } from '../../src/modules/scheduling/board.js'
import type { OpsSettings } from '../../src/modules/scheduling/context.js'
import type { InvoiceSummary, MembershipInfo } from '../../src/modules/scheduling/ports.js'

const TZ = 'America/New_York'
const at = (hhmm: string, date = '2026-06-13'): Date => {
  const [h, m] = hhmm.split(':').map(Number)
  return wallToInstant(date, h! * 60 + m!, TZ)
}
const NOW = at('10:36')
const OPS: OpsSettings = {
  lateGraceMin: 10,
  etaVisibleMaxMin: 30,
  prepAtMin: 15,
  vipFirst: true,
  autoArrive: true,
  welcome: true,
  arrivalEnabled: true,
}
const BAYS = new Map([
  ['bay1', 1],
  ['bay2', 2],
])

let n = 0
function row(o: {
  status?: AppointmentRecord['status']
  start?: string
  date?: string
  name?: string
  vip?: boolean
  planned?: string | null
  eta?: number | null
  prepped?: boolean
  geo?: string | null
  special?: string | null
  pickup?: 'pending' | 'collected' | null
  balance?: number
  pkg?: string
  member?: MembershipInfo | null
  make?: string
  model?: string
}): BoardRow {
  n += 1
  const start = at(o.start ?? '11:00', o.date)
  const a = {
    id: `a${n}`,
    status: o.status ?? 'confirmed',
    scheduledStart: start,
    scheduledEnd: new Date(start.getTime() + 35 * 60_000),
    packageName: o.pkg ?? 'Express Hand Wash',
    plannedBayId: o.planned === undefined ? 'bay1' : o.planned,
    bayId: null,
    etaMinutes: o.eta ?? null,
    bayPreppedAt: o.prepped ? NOW : null,
    geoCheckedInAt: o.geo ? at(o.geo) : null,
    pickupState: o.pickup ?? null,
    specialInstructions: o.special ?? null,
    seq: n,
  } as unknown as AppointmentRecord
  const invoice = { balanceCents: o.balance ?? 0, paidCents: 0 } as unknown as InvoiceSummary
  return {
    a,
    customer: {
      id: `c${n}`,
      fullName: o.name ?? 'Maria Delgado',
      phoneDisplay: null,
      phoneE164: null,
      email: null,
    },
    vehicle: { year: 2021, make: o.make ?? 'Audi', model: o.model ?? 'Q5', color: null, plate: null },
    staff: null,
    addonCount: 0,
    hasPhotos: false,
    vip: o.vip ?? false,
    member: o.member ?? null,
    invoice,
  }
}

const alerts = (rows: BoardRow[], ops: Partial<OpsSettings> = {}, now = NOW) =>
  buildAlerts({ now, tz: TZ, rows, ops: { ...OPS, ...ops } }, BAYS)
const kinds = (rows: BoardRow[], ops: Partial<OpsSettings> = {}) => alerts(rows, ops).map((a) => a.kind)

describe('rule 1: ready for pickup', () => {
  it('a completed job not collected; "payment due" only with a balance; collected is quiet', () => {
    const [a] = alerts([
      row({
        status: 'completed',
        pickup: 'pending',
        balance: 16478,
        name: 'Priya Nair',
        make: 'Tesla',
        start: '09:45',
      }),
    ])
    expect(a).toMatchObject({
      kind: 'ready_for_pickup',
      tone: 'green',
      glyph: '↑',
      title: 'Ready for pickup',
      desc: "Priya Nair's Tesla is done · payment due",
      actionLabel: 'Mark picked up',
    })
    expect(alerts([row({ status: 'completed', pickup: 'pending' })])[0]!.desc).toBe(
      "Maria Delgado's Audi is done",
    )
    expect(alerts([row({ status: 'completed', pickup: 'collected' })])).toEqual([])
  })
  it("yesterday's uncollected car still alerts; it is not bounded to today", () => {
    expect(kinds([row({ status: 'completed', pickup: 'pending', date: '2026-06-12' })])).toEqual([
      'ready_for_pickup',
    ])
  })
})

describe('rule 2: running late (computed)', () => {
  it('booked or confirmed past start + grace; not before; not once arrived', () => {
    const late = (start: string, status: AppointmentRecord['status'] = 'confirmed') =>
      kinds([row({ start, status, planned: 'bay1' })]).includes('running_late')
    expect(late('10:15')).toBe(true)
    expect(late('10:26')).toBe(false) // 10:36 is 10 minutes past 10:26: not yet more than the grace
    expect(late('10:25')).toBe(true)
    expect(late('10:15', 'booked')).toBe(true)
    expect(late('10:15', 'arrived')).toBe(false)
    const [x] = alerts([
      row({ start: '10:15', name: 'Marcus Webb', make: 'Jeep', model: 'Wrangler', planned: 'bay1' }),
    ])
    expect(x).toMatchObject({
      tone: 'red',
      glyph: '!',
      title: 'Running late · Marcus Webb',
      desc: '10:15 AM Jeep Wrangler — no arrival logged',
      actionLabel: 'Message customer',
    })
  })
  it('follows the grace setting', () => {
    expect(kinds([row({ start: '10:20', planned: 'bay1' })], { lateGraceMin: 20 })).not.toContain(
      'running_late',
    )
  })
})

describe('rule 3: needs a bay', () => {
  it('only jobs of today that are booked, confirmed or arrived with no planned bay', () => {
    expect(kinds([row({ planned: null })])).toContain('needs_bay')
    expect(kinds([row({ planned: null, date: '2026-06-14' })])).not.toContain('needs_bay') // tomorrow
    expect(kinds([row({ planned: null, status: 'completed', pickup: 'collected' })])).not.toContain(
      'needs_bay',
    )
    expect(kinds([row({ planned: 'bay2' })])).not.toContain('needs_bay')
    const [a] = alerts([row({ planned: null, name: 'Marcus Webb', pkg: 'Family Wash + Pet Hair' })])
    expect(a).toMatchObject({
      tone: 'amber',
      glyph: '◳',
      title: 'Needs bay assignment',
      desc: 'Marcus Webb · Family Wash + Pet Hair',
      actionLabel: 'Assign bay',
    })
  })
})

describe('rule 4: arriving soon', () => {
  it('confirmed, no ETA, starting within prep_at_min; follows the arrival setting', () => {
    const soon = (start: string, o: Partial<OpsSettings> = {}) =>
      kinds([row({ start, planned: 'bay1' })], o).includes('arriving_soon')
    expect(soon('10:45')).toBe(true)
    expect(soon('10:51')).toBe(true) // 15 minutes
    expect(soon('10:52')).toBe(false)
    expect(soon('10:52', { prepAtMin: 20 })).toBe(true)
    expect(soon('10:36')).toBe(false) // not in the future
    expect(kinds([row({ start: '10:45', eta: 12 })])).not.toContain('arriving_soon')
    const x = alerts([
      row({ start: '10:45', name: 'Tom Bradley', make: 'Honda', model: 'Civic', planned: 'bay2' }),
    ]).find((a) => a.kind === 'arriving_soon')!
    expect(x).toMatchObject({
      tone: 'blue',
      glyph: '→',
      title: 'Arriving soon',
      desc: 'Tom Bradley in 9 min · Honda Civic',
      actionLabel: 'Prep bay 2',
    })
  })
})

describe('rule 5: unconfirmed', () => {
  it('a booked job; the action re-sends the reminder, it does not confirm', () => {
    const [a] = alerts([row({ status: 'booked', name: 'Grace Adeyemi', start: '11:00' })]).filter(
      (x) => x.kind === 'unconfirmed',
    )
    expect(a).toMatchObject({
      tone: 'amber',
      glyph: '?',
      title: 'Unconfirmed',
      desc: "Grace Adeyemi · 11:00 AM hasn't confirmed",
      actionLabel: 'Send reminder',
      action: { type: 'send_reminder' },
    })
  })
})

describe('rule 6: special instructions', () => {
  it('the ellipsis only when truncated at 46 characters', () => {
    const short = alerts([row({ special: 'Call on arrival' })]).find(
      (a) => a.kind === 'special_instructions',
    )!
    expect(short.desc).toBe('Maria Delgado: Call on arrival')
    const text = 'Hand-dry only — no automated equipment near paint. Owner inspects before release.'
    const long = alerts([row({ special: text, name: 'Elena Volkov' })]).find(
      (a) => a.kind === 'special_instructions',
    )!
    expect(long).toMatchObject({
      tone: 'violet',
      glyph: '★',
      title: 'Special instructions',
      actionLabel: 'View file',
    })
    expect(long.desc).toBe('Elena Volkov: Hand-dry only — no automated equipment near pa…')
    expect(text.slice(0, 46)).toBe('Hand-dry only — no automated equipment near pa')
    expect(
      alerts([row({ special: text, status: 'completed', pickup: 'collected' })]).some(
        (a) => a.kind === 'special_instructions',
      ),
    ).toBe(false)
  })
})

describe('rules 7, 8 and 8b: arrivals', () => {
  it('7: an ETA within the visible maximum; VIP wording and violet; "Bay ready" once prepped', () => {
    const [a] = alerts([
      row({ eta: 12, vip: true, name: 'Liam Chen', make: 'BMW', model: 'M340i', planned: 'bay1' }),
    ]).filter((x) => x.kind === 'arriving_eta')
    expect(a).toMatchObject({
      tone: 'violet',
      glyph: '◎',
      title: 'VIP arriving in 12 min · Liam Chen',
      desc: 'Geofence ETA · BMW M340i · Bay 1',
      actionLabel: 'Prep bay 1',
    })
    const [b] = alerts([row({ eta: 22, name: 'Grace Adeyemi', planned: 'bay2', prepped: true })]).filter(
      (x) => x.kind === 'arriving_eta',
    )
    expect(b).toMatchObject({
      tone: 'blue',
      title: 'Arriving in 22 min · Grace Adeyemi',
      actionLabel: 'Bay ready ✓',
    })
    expect(kinds([row({ eta: 45 })])).not.toContain('arriving_eta')
    expect(kinds([row({ eta: 12, status: 'arrived' })])).not.toContain('arriving_eta')
  })
  it('8: a geofence check-in of an arrived job; 8b: with auto-arrive off the job still waits to be marked arrived', () => {
    const a = alerts([row({ status: 'arrived', geo: '10:27', name: 'Sofia Marchetti' })]).find(
      (x) => x.kind === 'auto_checked_in',
    )!
    expect(a).toMatchObject({
      tone: 'green',
      glyph: '✓',
      title: 'Auto checked in · Sofia Marchetti',
      desc: 'Geofence at 10:27 AM · vehicle in the lot',
      actionLabel: 'Start cleaning',
    })
    expect(kinds([row({ status: 'confirmed', geo: '10:27' })])).not.toContain('confirm_checkin')
    const b = alerts([row({ status: 'confirmed', geo: '10:27', name: 'Sofia Marchetti' })], {
      autoArrive: false,
    }).find((x) => x.kind === 'confirm_checkin')!
    expect(b).toMatchObject({
      title: 'Checked in at the lot · Sofia Marchetti',
      actionLabel: 'Mark arrived',
      action: { type: 'mark_arrived' },
    })
  })
})

describe('rule 9: member credit', () => {
  const credit = (creditAvailable: boolean): MembershipInfo => ({
    plan: 'Premium Care',
    creditsLeft: 1,
    creditAvailable,
  })
  it('the first completed, unpaid job whose member has an unused credit (a real check, not the exact string "Premium")', () => {
    const a = alerts([
      row({
        status: 'completed',
        pickup: 'collected',
        balance: 1000,
        member: credit(true),
        name: 'Priya Nair',
        start: '09:45',
      }),
    ]).find((x) => x.kind === 'member_credit')!
    expect(a).toMatchObject({
      tone: 'blue',
      glyph: '◆',
      title: 'Member credit available',
      desc: 'Priya Nair has 1 unused Premium credit this cycle',
      actionLabel: 'Apply credit',
    })
    expect(
      kinds([row({ status: 'completed', pickup: 'collected', balance: 1000, member: credit(false) })]),
    ).not.toContain('member_credit')
    expect(
      kinds([row({ status: 'completed', pickup: 'collected', balance: 0, member: credit(true) })]),
    ).not.toContain('member_credit')
    expect(
      alerts([
        row({ status: 'completed', pickup: 'collected', balance: 1, member: credit(true) }),
        row({ status: 'completed', pickup: 'collected', balance: 1, member: credit(true) }),
      ]).filter((x) => x.kind === 'member_credit'),
    ).toHaveLength(1)
  })
})

describe('order and priority', () => {
  it('generation order (first pass, second pass, credit) then a stable sort by priority: VIP first', () => {
    const rows = [
      row({
        status: 'completed',
        pickup: 'pending',
        start: '09:45',
        name: 'Priya Nair',
        balance: 100,
        member: { plan: 'Premium', creditsLeft: 1, creditAvailable: true },
      }),
      row({ start: '10:15', name: 'Marcus Webb', planned: null }),
      row({ status: 'booked', start: '11:00', name: 'Grace Adeyemi', eta: 22, planned: 'bay2' }),
      row({
        status: 'booked',
        start: '15:00',
        name: 'Elena Volkov',
        vip: true,
        special: 'Hand-dry only — no automated equipment near paint.',
        planned: 'bay1',
      }),
      row({ status: 'arrived', start: '10:30', name: 'Sofia Marchetti', geo: '10:27', planned: 'bay2' }),
      row({ start: '10:45', name: 'Liam Chen', vip: true, eta: 12, planned: 'bay1' }),
    ]
    expect(alerts(rows).map((a) => `${a.priority}:${a.title}`)).toEqual([
      '1:Unconfirmed',
      '1:Special instructions',
      '1:VIP arriving in 12 min · Liam Chen',
      '0:Ready for pickup',
      '0:Running late · Marcus Webb',
      '0:Needs bay assignment',
      '0:Unconfirmed',
      '0:Auto checked in · Sofia Marchetti',
      '0:Arriving in 22 min · Grace Adeyemi',
      '0:Member credit available',
    ])
  })

  it('arrival alerts are boosted for a VIP only when arrival_settings.vip_first is on', () => {
    const rows = [row({ eta: 12, vip: true, planned: 'bay1' })]
    expect(alerts(rows, { vipFirst: true })[0]!.priority).toBe(1)
    expect(alerts(rows, { vipFirst: false })[0]!.priority).toBe(0)
    const other = [row({ status: 'booked', vip: true })]
    expect(alerts(other, { vipFirst: false }).find((a) => a.kind === 'unconfirmed')!.priority).toBe(1)
  })

  it('external alerts (new reply, SMS device down, card awaiting Squarespace) follow the appointment alerts', () => {
    const out = buildAlerts(
      {
        now: NOW,
        tz: TZ,
        rows: [row({ status: 'booked' })],
        ops: OPS,
        external: [
          {
            key: 'sms_device_down',
            kind: 'sms_device_down',
            tone: 'red',
            title: 'SMS device offline',
            desc: 'No heartbeat for 10 minutes',
            actionLabel: 'Open health',
            appointmentId: null,
            priority: 0,
          },
        ],
      },
      BAYS,
    )
    expect(out.map((a) => a.kind)).toEqual(['unconfirmed', 'sms_device_down'])
    expect(out[1]).toMatchObject({ key: 'sms_device_down', action: { type: 'open', appointmentId: null } })
  })

  it('keys are stable per kind and appointment', () => {
    const r = row({ status: 'booked' })
    expect(alerts([r])[0]!.key).toBe(`unconfirmed:${r.a.id}`)
  })
})
