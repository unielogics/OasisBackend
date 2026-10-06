import { describe, expect, it } from 'vitest'
import { transaction } from '../../src/platform/db.js'
import { isAppError } from '../../src/platform/errors.js'
import {
  DEFAULT_EMERGENCY_MESSAGE,
  DEFAULT_HOURS,
  EMERGENCY_REASONS,
  RecordingEmergencyNotifier,
  closeShop,
  emergencyClosureRows,
  emergencySummary,
  emergencyWindow,
  getActiveEmergency,
  getEmergencyState,
  liveCounters,
  listNeedsRebooking,
  previewEmergency,
  renderEmergencyMessage,
  reopenIfEnded,
  reopenShop,
  stripLinkSentences,
  untilText,
  type CloseShopInput,
} from '../../src/modules/settings/index.js'
import { useTestDb } from '../helpers/db.js'
import {
  edt,
  makeAppointment,
  makeBay,
  makeCustomer,
  makeService,
  makeVehicle,
  setupLocation,
} from '../domain-schema/helpers.js'

const t = useTestDb({ poolMax: 6 })
const TZ = 'America/New_York'
const NOW = new Date('2026-06-13T10:36:00-04:00') // Saturday

async function appError(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    if (isAppError(e)) return e
    throw e
  }
  throw new Error('expected an AppError')
}

describe('emergency text (pure)', () => {
  it('builds the untilText of each duration', () => {
    expect(untilText({ kind: 'today' })).toBe('for the rest of today')
    expect(untilText({ kind: 'until', untilMin: 840 })).toBe('until 2:00 PM today')
    expect(untilText({ kind: 'until', untilMin: 690 })).toBe('until 11:30 AM today')
    expect(untilText({ kind: 'days', throughDate: '2026-06-15' })).toBe('through Monday, Jun 15')
    expect(untilText({ kind: 'days', throughDate: '2026-12-25' })).toBe('through Friday, Dec 25')
  })

  it('builds the summary with the reason label and the pause suffix', () => {
    expect(emergencySummary('severe_weather', { kind: 'today' }, true)).toBe(
      'Severe weather · closed for the rest of today · online booking paused',
    )
    expect(emergencySummary('power_outage', { kind: 'until', untilMin: 900 }, false)).toBe(
      'Power outage · closed until 3:00 PM today',
    )
    expect(emergencySummary('staff_shortage', { kind: 'days', throughDate: '2026-06-15' }, true)).toBe(
      'Staff shortage · closed through Monday, Jun 15 · online booking paused',
    )
  })

  it('has the five reason phrases of the design', () => {
    expect(Object.values(EMERGENCY_REASONS).map((r) => r.phrase)).toEqual([
      'severe weather',
      'a power outage',
      'an equipment failure',
      'a staffing issue',
      'unforeseen circumstances',
    ])
  })

  it('renders the design preview exactly', () => {
    expect(
      renderEmergencyMessage(
        DEFAULT_EMERGENCY_MESSAGE,
        { first: 'Liam', reason: 'severe weather', until: 'for the rest of today', link: 'oasis.spa/r/8KQ2' },
        true,
      ),
    ).toBe(
      'Hi Liam, due to severe weather Oasis Auto Spa is closed for the rest of today. We’re sorry for the inconvenience. Pick a new time here: oasis.spa/r/8KQ2',
    )
  })

  it('replaces every occurrence of each variable', () => {
    const out = renderEmergencyMessage(
      '{first}, {first}: {reason} / {reason}, {until} {until} {link} {link}',
      { first: 'A', reason: 'r', until: 'u', link: 'L' },
      true,
    )
    expect(out).toBe('A, A: r / r, u u L L')
  })

  it('removes the sentence containing {link} when links are disabled', () => {
    expect(stripLinkSentences(DEFAULT_EMERGENCY_MESSAGE)).toBe(
      'Hi {first}, due to {reason} Oasis Auto Spa is closed {until}. We’re sorry for the inconvenience.',
    )
    expect(
      renderEmergencyMessage(
        DEFAULT_EMERGENCY_MESSAGE,
        { first: 'Liam', reason: 'severe weather', until: 'for the rest of today', link: 'x' },
        false,
      ),
    ).toBe(
      'Hi Liam, due to severe weather Oasis Auto Spa is closed for the rest of today. We’re sorry for the inconvenience.',
    )
    expect(stripLinkSentences('Closed today. Rebook at {link}. Sorry! Call us.')).toBe(
      'Closed today. Sorry! Call us.',
    )
    expect(stripLinkSentences('Rebook: {link}')).toBe('')
    expect(stripLinkSentences('Hello {first}.\nTap {link} to rebook.\nThanks.')).toBe(
      'Hello {first}. Thanks.',
    )
  })

  it('strips the link sentence when no link was supplied even if links are on', () => {
    const out = renderEmergencyMessage(
      DEFAULT_EMERGENCY_MESSAGE,
      { first: 'A', reason: 'r', until: 'u', link: null },
      true,
    )
    expect(out).not.toContain('{link}')
    expect(out).not.toContain('Pick a new time')
  })
})

describe('emergencyWindow and closure rows (pure)', () => {
  const hours = [...DEFAULT_HOURS]
  const win = (duration: Parameters<typeof emergencyWindow>[0]['duration'], now = NOW) =>
    emergencyWindow({ duration, now, tz: TZ, hours })

  it('today: the whole business day, reopening at closing time', () => {
    const w = win({ kind: 'today' })
    expect(w).toMatchObject({ startDate: '2026-06-13', throughDate: '2026-06-13', untilMin: null })
    expect(w.endsAt.toISOString()).toBe('2026-06-13T21:00:00.000Z') // 5:00 PM EDT, Saturday closing
    expect(w.affectedFrom.toISOString()).toBe('2026-06-13T04:00:00.000Z')
    expect(w.affectedTo.toISOString()).toBe('2026-06-14T04:00:00.000Z')
  })

  it('today after closing time runs to the end of the day', () => {
    const w = win({ kind: 'today' }, new Date('2026-06-13T18:30:00-04:00'))
    expect(w.endsAt.toISOString()).toBe('2026-06-14T04:00:00.000Z')
  })

  it('until: stops before the reopening time, which must be later than now', () => {
    const w = win({ kind: 'until', untilMin: 840 })
    expect(w.endsAt.toISOString()).toBe('2026-06-13T18:00:00.000Z')
    expect(w.affectedTo).toEqual(w.endsAt)
    expect(() => win({ kind: 'until', untilMin: 600 })).toThrow(/later than now/)
    expect(() => win({ kind: 'until', untilMin: 636 })).toThrow(/later than now/)
    expect(() => win({ kind: 'until', untilMin: null })).toThrow(/Pick a time/)
    expect(() => win({ kind: 'until', untilMin: 1500 })).toThrow(/Pick a time/)
  })

  it('days: from today through the end of the last date, including future days', () => {
    const w = win({ kind: 'days', throughDate: '2026-06-15' })
    expect(w).toMatchObject({ startDate: '2026-06-13', throughDate: '2026-06-15' })
    expect(w.affectedTo.toISOString()).toBe('2026-06-16T04:00:00.000Z')
    expect(w.endsAt.toISOString()).toBe('2026-06-15T22:00:00.000Z') // Monday 6:00 PM
    expect(() => win({ kind: 'days', throughDate: '2026-06-12' })).toThrow(/from today/)
    expect(() => win({ kind: 'days', throughDate: '2026-09-30' })).toThrow(/from today/)
    expect(() => win({ kind: 'days', throughDate: 'soon' })).toThrow(/from today/)
    expect(win({ kind: 'days', throughDate: '2026-06-13' }).throughDate).toBe('2026-06-13')
  })

  it('writes one closure row per open date, shaped by the duration', () => {
    const rows = (duration: Parameters<typeof emergencyWindow>[0]['duration'], now = NOW, h = hours) =>
      emergencyClosureRows({
        duration,
        window: emergencyWindow({ duration, now, tz: TZ, hours: h }),
        hours: h,
        now,
        tz: TZ,
      })
    expect(rows({ kind: 'today' })).toEqual([
      { date: '2026-06-13', type: 'reduced', openMin: 480, closeMin: 636 },
    ])
    expect(rows({ kind: 'today' }, new Date('2026-06-13T07:00:00-04:00'))).toEqual([
      { date: '2026-06-13', type: 'closed', openMin: null, closeMin: null },
    ])
    expect(rows({ kind: 'until', untilMin: 840 })).toEqual([
      { date: '2026-06-13', type: 'reduced', openMin: 840, closeMin: 1020 },
    ])
    expect(rows({ kind: 'until', untilMin: 1020 })).toEqual([
      { date: '2026-06-13', type: 'closed', openMin: null, closeMin: null },
    ])
    expect(rows({ kind: 'days', throughDate: '2026-06-15' }).map((r) => [r.date, r.type])).toEqual([
      ['2026-06-13', 'closed'],
      ['2026-06-14', 'closed'],
      ['2026-06-15', 'closed'],
    ])
  })

  it('skips regular days off and honors the weekly hours of each date', () => {
    const sundayOff = hours.map((h) => (h.weekday === 0 ? { ...h, isOpen: false } : h))
    const d = { kind: 'days' as const, throughDate: '2026-06-15' }
    const r = emergencyClosureRows({
      duration: d,
      window: emergencyWindow({ duration: d, now: NOW, tz: TZ, hours: sundayOff }),
      hours: sundayOff,
      now: NOW,
      tz: TZ,
    })
    expect(r.map((x) => x.date)).toEqual(['2026-06-13', '2026-06-15'])
  })
})

// Database ---------------------------------------------------------------------------------------------------------------

type Fx = Awaited<ReturnType<typeof setupLocation>>

async function shop() {
  const f = await setupLocation(t)
  const service = await makeService(t.db, f)
  const bay = await makeBay(t.db, f, 1)
  const person = async (name: string, line: string, o: Parameters<typeof makeCustomer>[2] = {}) => {
    const customerId = await makeCustomer(t.db, f, { name, line, ...o })
    const vehicleId = await makeVehicle(t.db, f, customerId, { make: 'Jeep', model: 'Wrangler' })
    return { customerId, vehicleId }
  }
  const book = async (
    name: string,
    line: string,
    date: string,
    hhmm: string,
    status: Parameters<typeof makeAppointment>[2]['status'] = 'booked',
    o: Parameters<typeof makeCustomer>[2] & { pickupState?: 'pending' | 'collected' } = {},
  ) => {
    const { customerId, vehicleId } = await person(name, line, o)
    const id = await makeAppointment(t.db, f, {
      customerId,
      vehicleId,
      serviceId: service,
      start: edt(date, hhmm),
      status,
      bayId: status === 'cleaning' ? bay : null,
      pickupState: o.pickupState ?? null,
    })
    return { id, customerId }
  }
  // The design's Saturday: six upcoming, three vehicles on site (arrived, cleaning, completed awaiting pickup).
  const day = async () => {
    const remaining = [
      await book('Marcus Webb', '0108', '2026-06-13', '10:15', 'confirmed'),
      await book('Liam Chen', '0107', '2026-06-13', '10:45', 'confirmed'),
      await book('Grace Adeyemi', '0109', '2026-06-13', '11:00', 'booked'),
      await book('Aisha Rahman', '0110', '2026-06-13', '12:00', 'confirmed'),
      await book('Tom Bradley', '0111', '2026-06-13', '13:30', 'confirmed'),
      await book('Elena Volkov', '0112', '2026-06-13', '15:00', 'booked'),
    ]
    const arrived = await book('Sofia Marchetti', '0106', '2026-06-13', '10:30', 'arrived')
    const cleaning = await book('Jonathan Franco', '0105', '2026-06-13', '10:00', 'cleaning')
    const pickup = await book('Priya Nair', '0104', '2026-06-13', '09:45', 'completed', {
      pickupState: 'pending',
    })
    const done = await book('Maria Delgado', '0102', '2026-06-13', '08:30', 'completed', {
      pickupState: 'collected',
    })
    const canceled = await book('Carl Canceled', '0113', '2026-06-13', '14:00', 'canceled')
    const sunday = await book('Nathan Brooks', '0114', '2026-06-14', '09:00', 'confirmed')
    const monday = await book('Olivia Hart', '0115', '2026-06-15', '08:30', 'booked')
    return { remaining, arrived, cleaning, pickup, done, canceled, sunday, monday }
  }
  return { f, service, bay, book, day }
}

const baseInput = (f: Fx, o: Partial<CloseShopInput> = {}): CloseShopInput => ({
  locationId: f.locationId,
  reason: 'severe_weather',
  duration: { kind: 'today' },
  notify: true,
  link: true,
  credits: true,
  pause: true,
  crew: true,
  now: NOW,
  tz: TZ,
  newId: f.newId,
  linkEnabled: true,
  startedBy: '00000000-0000-7000-8000-0000000000aa',
  startedByName: 'Rafael M.',
  ...o,
})
const close = (f: Fx, o: Partial<CloseShopInput> = {}) =>
  transaction(t.db, (tx) => closeShop(tx, baseInput(f, o)))
const preview = (f: Fx, o: Partial<Parameters<typeof previewEmergency>[1]> = {}) =>
  previewEmergency(t.db, {
    locationId: f.locationId,
    reason: 'severe_weather',
    duration: { kind: 'today' },
    notify: true,
    link: true,
    credits: true,
    pause: true,
    crew: true,
    now: NOW,
    tz: TZ,
    linkEnabled: true,
    ...o,
  })

describe('previewEmergency', () => {
  it('lists today’s upcoming appointments, the vehicles already on site, and the rendered message', async () => {
    const { f, day } = await shop()
    await day()
    const p = await preview(f)
    expect(p.count).toBe(6)
    expect(p.affected.map((a) => [a.time, a.customerName, a.vehicle])).toEqual([
      ['10:15 AM', 'Marcus Webb', 'Jeep Wrangler'],
      ['10:45 AM', 'Liam Chen', 'Jeep Wrangler'],
      ['11:00 AM', 'Grace Adeyemi', 'Jeep Wrangler'],
      ['12:00 PM', 'Aisha Rahman', 'Jeep Wrangler'],
      ['1:30 PM', 'Tom Bradley', 'Jeep Wrangler'],
      ['3:00 PM', 'Elena Volkov', 'Jeep Wrangler'],
    ])
    expect(p.onSite.map((a) => a.customerName).sort()).toEqual(['Jonathan Franco', 'Sofia Marchetti'])
    expect(p.summary).toBe('Severe weather · closed for the rest of today · online booking paused')
    expect(p.renderedMessage).toBe(
      'Hi Liam, due to severe weather Oasis Auto Spa is closed for the rest of today. We’re sorry for the inconvenience. Pick a new time here: oasis.spa/r/8KQ2',
    )
    expect(await t.db.selectFrom('emergency_closures').select('id').execute()).toHaveLength(0)
  })

  it('counts only appointments before the reopening time for "until"', async () => {
    const { f, day } = await shop()
    await day()
    const p = await preview(f, { duration: { kind: 'until', untilMin: 840 } })
    expect(p.affected.map((a) => a.time)).toEqual(['10:15 AM', '10:45 AM', '11:00 AM', '12:00 PM', '1:30 PM'])
    expect(p.untilText).toBe('until 2:00 PM today')
  })

  it('includes future days up to and including the last date for "days", with their dates', async () => {
    const { f, day } = await shop()
    await day()
    const p = await preview(f, { duration: { kind: 'days', throughDate: '2026-06-15' } })
    expect(p.count).toBe(8)
    expect(p.affected.slice(-2).map((a) => [a.bizDate, a.time, a.customerName])).toEqual([
      ['2026-06-14', '9:00 AM', 'Nathan Brooks'],
      ['2026-06-15', '8:30 AM', 'Olivia Hart'],
    ])
    expect((await preview(f, { duration: { kind: 'days', throughDate: '2026-06-14' } })).count).toBe(7)
  })

  it('strips the link sentence from the preview when links are off', async () => {
    const { f } = await shop()
    expect((await preview(f, { link: false })).renderedMessage).not.toContain('Pick a new time')
    expect((await preview(f, { linkEnabled: false })).renderedMessage).not.toContain('oasis.spa')
  })

  it('uses a custom message and rejects bad input', async () => {
    const { f } = await shop()
    expect(
      (await preview(f, { message: 'Closed {until} due to {reason}, {first}.', link: false }))
        .renderedMessage,
    ).toBe('Closed for the rest of today due to severe weather, Liam.')
    expect((await appError(preview(f, { reason: 'nope' as never }))).errors?.[0]?.path).toBe('reason')
    expect((await appError(preview(f, { duration: { kind: 'forever' as never } }))).errors?.[0]?.path).toBe(
      'duration',
    )
    expect((await appError(preview(f, { message: 'x'.repeat(1001) }))).errors?.[0]?.path).toBe('message')
  })
})

describe('closeShop', () => {
  it('closes the shop for the rest of today and does everything the design promises, in one transaction', async () => {
    const { f, day } = await shop()
    const d = await day()
    const notifier = new RecordingEmergencyNotifier()
    const calls: string[] = []
    const r = await close(f, {
      notifier,
      effects: {
        protectCredits: async (_tx, ctx) => void calls.push(`credits:${ctx.appointmentIds.length}`),
        alertCrew: async (_tx, ctx) => void calls.push(`crew:${ctx.summary}`),
      },
    })
    expect(r.summary).toBe('Severe weather · closed for the rest of today · online booking paused')
    expect(r.notifiedCount).toBe(6)
    expect(r.skipped).toBe(0)
    expect(r.affected.map((a) => a.customerName)).toEqual([
      'Marcus Webb',
      'Liam Chen',
      'Grace Adeyemi',
      'Aisha Rahman',
      'Tom Bradley',
      'Elena Volkov',
    ])
    expect(r.onSite.map((a) => a.customerName).sort()).toEqual(['Jonathan Franco', 'Sofia Marchetti'])
    expect(calls).toEqual([
      'credits:6',
      'crew:Severe weather · closed for the rest of today · online booking paused',
    ])

    const row = (await getActiveEmergency(t.db, f.locationId))!
    expect(row).toMatchObject({
      active: true,
      reason: 'severe_weather',
      durationKind: 'today',
      pause: true,
      affectedCount: 6,
      notifiedCount: 6,
      rebookedCount: 0,
      startedByName: 'Rafael M.',
      summary: r.summary,
    })
    expect(row.endsAt?.toISOString()).toBe('2026-06-13T21:00:00.000Z')
    expect(row.message).toBe(DEFAULT_EMERGENCY_MESSAGE)

    const flagged = await t.db
      .selectFrom('appointments')
      .select(['id', 'status', 'emergency_closure_id'])
      .where('emergency_closure_id', 'is not', null)
      .execute()
    expect(flagged.map((a) => a.id).sort()).toEqual(d.remaining.map((a) => a.id).sort())
    expect(flagged.every((a) => a.status === 'confirmed' || a.status === 'booked')).toBe(true)
    const untouched = await t.db
      .selectFrom('appointments')
      .select('status')
      .where('id', 'in', [d.arrived.id, d.cleaning.id, d.pickup.id, d.canceled.id])
      .execute()
    expect(untouched.map((a) => a.status).sort()).toEqual(['arrived', 'canceled', 'cleaning', 'completed'])

    const closures = await t.db.selectFrom('closures').selectAll().execute()
    expect(closures).toHaveLength(1)
    expect(closures[0]).toMatchObject({
      date: '2026-06-13',
      name: 'Weather closure',
      type: 'reduced',
      open_min: 480,
      close_min: 636,
      source: 'emergency',
      notify: false,
      emergency_closure_id: row.id,
    })

    const notes = await t.db.selectFrom('emergency_notifications').selectAll().execute()
    expect(notes).toHaveLength(6)
    expect(
      notes.every((n) => n.channel === 'sms' && n.state === 'queued' && n.reschedule_link_id !== null),
    ).toBe(true)
    const links = await t.db.selectFrom('reschedule_links').selectAll().execute()
    expect(links).toHaveLength(6)
    expect(new Set(links.map((l) => l.code)).size).toBe(6)
    expect(
      links.every(
        (l) => l.code.length === 12 && l.emergency_closure_id === row.id && l.expires_at > row.endsAt!,
      ),
    ).toBe(true)

    expect(notifier.sent).toHaveLength(6)
    const first = notifier.sent[0]!
    expect(first).toMatchObject({ channel: 'sms', priority: 0, emergencyClosureId: row.id })
    expect(first.message).toMatch(
      /^Hi Marcus, due to severe weather Oasis Auto Spa is closed for the rest of today\. We’re sorry for the inconvenience\. Pick a new time here: oasis\.spa\/r\/[0-9A-Z]{12}$/,
    )
    expect(first.message).toContain(first.rescheduleCode!)
    expect(notifier.sent.map((s) => s.appointment.firstName)).toEqual([
      'Marcus',
      'Liam',
      'Grace',
      'Aisha',
      'Tom',
      'Elena',
    ])

    const audit = await t.db
      .selectFrom('audit_log')
      .select(['action', 'entity_id'])
      .where('action', '=', 'emergency.close')
      .execute()
    expect(audit).toEqual([{ action: 'emergency.close', entity_id: row.id }])
    const events = await t.db
      .selectFrom('realtime_events')
      .select(['channel', 'type'])
      .orderBy('id')
      .execute()
    expect(events).toEqual([
      { channel: 'ops', type: 'emergency.started' },
      { channel: 'settings', type: 'settings.changed' },
    ])
  })

  it('rejects a second active emergency, and only one of two concurrent closes wins', async () => {
    const { f } = await shop()
    const results = await Promise.allSettled([close(f), close(f, { reason: 'power_outage' })])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!
    expect(rejected.reason).toMatchObject({ code: 'EMERGENCY_ACTIVE', status: 409 })
    expect((await appError(close(f))).code).toBe('EMERGENCY_ACTIVE')
    expect(await t.db.selectFrom('emergency_closures').select('id').execute()).toHaveLength(1)
  })

  it('closes until a time: only earlier appointments are affected and the rest of the day reopens', async () => {
    const { f, day } = await shop()
    const d = await day()
    const r = await close(f, { duration: { kind: 'until', untilMin: 840 }, pause: false })
    expect(r.summary).toBe('Severe weather · closed until 2:00 PM today')
    expect(r.affected).toHaveLength(5)
    const closure = await t.db
      .selectFrom('closures')
      .select(['type', 'open_min', 'close_min'])
      .executeTakeFirstOrThrow()
    expect(closure).toEqual({ type: 'reduced', open_min: 840, close_min: 1020 })
    const later = await t.db
      .selectFrom('appointments')
      .select('emergency_closure_id')
      .where('id', '=', d.remaining[5]!.id)
      .executeTakeFirstOrThrow()
    expect(later.emergency_closure_id).toBeNull()
  })

  it('closes for several days, including future appointments, replacing planned closures it will restore', async () => {
    const { f, day } = await shop()
    const d = await day()
    const planned = f.newId()
    await t.db
      .insertInto('closures')
      .values({
        id: planned,
        location_id: f.locationId,
        date: '2026-06-15',
        name: 'Staff training',
        type: 'reduced',
        open_min: 600,
        close_min: 840,
        federal_key: null,
        federal_year: null,
        emergency_closure_id: null,
        created_by: null,
        deleted_at: null,
      })
      .execute()
    const r = await close(f, { duration: { kind: 'days', throughDate: '2026-06-15' } })
    expect(r.affected).toHaveLength(8)
    expect(r.summary).toBe('Severe weather · closed through Monday, Jun 15 · online booking paused')
    const rows = await t.db
      .selectFrom('closures')
      .select(['date', 'type', 'source', 'deleted_at'])
      .orderBy('date')
      .orderBy('source')
      .execute()
    expect(rows.map((x) => [x.date, x.type, x.source, x.deleted_at !== null])).toEqual([
      ['2026-06-13', 'closed', 'emergency', false],
      ['2026-06-14', 'closed', 'emergency', false],
      ['2026-06-15', 'closed', 'emergency', false],
      ['2026-06-15', 'reduced', 'manual', true],
    ])
    expect((await getActiveEmergency(t.db, f.locationId))!.replacedClosureIds).toEqual([planned])
    const flagged = await t.db
      .selectFrom('appointments')
      .select('id')
      .where('emergency_closure_id', 'is not', null)
      .execute()
    expect(flagged.map((x) => x.id)).toEqual(expect.arrayContaining([d.sunday.id, d.monday.id]))
  })

  it('records customers it cannot text: opted out (email fallback or skipped) and no contact at all', async () => {
    const { f, book } = await shop()
    await book('Opt Out', '0120', '2026-06-13', '11:00', 'booked', { optedOut: true })
    await book('Opt Email', '0121', '2026-06-13', '12:00', 'booked', {
      optedOut: true,
      email: 'oe@example.com',
    })
    await book('No Phone', '0122', '2026-06-13', '13:00', 'booked', {
      noPhone: true,
      email: 'np@example.com',
    })
    await book('Nobody', '0123', '2026-06-13', '14:00', 'booked', { noPhone: true })
    await book('Reachable', '0124', '2026-06-13', '15:00', 'booked')
    const notifier = new RecordingEmergencyNotifier()
    const r = await close(f, { notifier })
    const by = Object.fromEntries(r.affected.map((a) => [a.customerName, a.notification]))
    expect(by).toEqual({
      'Opt Out': { channel: 'none', state: 'skipped_opt_out' },
      'Opt Email': { channel: 'email', state: 'queued' },
      'No Phone': { channel: 'email', state: 'queued' },
      Nobody: { channel: 'none', state: 'no_contact' },
      Reachable: { channel: 'sms', state: 'queued' },
    })
    expect(r.notifiedCount).toBe(3)
    expect(r.skipped).toBe(2)
    expect(notifier.sent.map((s) => [s.appointment.customerName, s.channel])).toEqual([
      ['Opt Email', 'email'],
      ['No Phone', 'email'],
      ['Reachable', 'sms'],
    ])
    expect(await liveCounters(t.db, r.emergency.id)).toEqual({
      affected: 5,
      notified: 3,
      skipped: 2,
      rebooked: 0,
    })
  })

  it('lets the notifier refine the state (for example a failed send) and counts only real notifications', async () => {
    const { f, book } = await shop()
    await book('A', '0130', '2026-06-13', '11:00')
    await book('B', '0131', '2026-06-13', '12:00')
    const notifier = new RecordingEmergencyNotifier((req) => ({
      state: req.appointment.customerName === 'A' ? 'failed' : 'sent',
      messageId: null,
    }))
    const r = await close(f, { notifier })
    expect(r.notifiedCount).toBe(1)
    expect(r.skipped).toBe(1)
    const states = await t.db.selectFrom('emergency_notifications').select('state').execute()
    expect(states.map((s) => s.state).sort()).toEqual(['failed', 'sent'])
  })

  it('flags appointments but sends nothing when "notify" is off', async () => {
    const { f, day } = await shop()
    await day()
    const notifier = new RecordingEmergencyNotifier()
    const r = await close(f, { notify: false, notifier })
    expect(notifier.sent).toEqual([])
    expect(r.notifiedCount).toBe(0)
    expect(await t.db.selectFrom('emergency_notifications').select('id').execute()).toHaveLength(0)
    expect(
      await t.db
        .selectFrom('appointments')
        .select('id')
        .where('emergency_closure_id', 'is not', null)
        .execute(),
    ).toHaveLength(6)
    expect((await getActiveEmergency(t.db, f.locationId))!.affectedCount).toBe(6)
  })

  it('strips the link sentence and creates no links while links are disabled', async () => {
    const { f, day } = await shop()
    await day()
    for (const o of [{ linkEnabled: false }, { link: false }]) {
      const notifier = new RecordingEmergencyNotifier()
      await close(f, { ...o, notifier })
      expect(notifier.sent).toHaveLength(6)
      for (const s of notifier.sent) {
        expect(s.message).toBe(
          `Hi ${s.appointment.firstName}, due to severe weather Oasis Auto Spa is closed for the rest of today. We’re sorry for the inconvenience.`,
        )
        expect(s.rescheduleCode).toBeNull()
      }
      expect(await t.db.selectFrom('reschedule_links').select('id').execute()).toHaveLength(0)
      await transaction(t.db, (tx) =>
        reopenShop(tx, { locationId: f.locationId, now: NOW, tz: TZ, reopenedByName: 'Rafael M.' }),
      )
    }
  })

  it('skips the optional effects when credits and crew are off', async () => {
    const { f, day } = await shop()
    await day()
    const calls: string[] = []
    await close(f, {
      credits: false,
      crew: false,
      effects: {
        protectCredits: async () => void calls.push('c'),
        alertCrew: async () => void calls.push('k'),
      },
    })
    expect(calls).toEqual([])
  })

  it('rejects an invalid window without writing anything', async () => {
    const { f, day } = await shop()
    await day()
    expect((await appError(close(f, { duration: { kind: 'until', untilMin: 600 } }))).errors?.[0]?.path).toBe(
      'until',
    )
    expect(
      (await appError(close(f, { duration: { kind: 'days', throughDate: '2026-06-01' } }))).errors?.[0]?.path,
    ).toBe('through')
    expect(await t.db.selectFrom('emergency_closures').select('id').execute()).toHaveLength(0)
    expect(await t.db.selectFrom('closures').select('id').execute()).toHaveLength(0)
  })

  it('rolls back the whole closure when the notifier throws', async () => {
    const { f, day } = await shop()
    await day()
    const boom = { send: async () => Promise.reject(new Error('sms down')) }
    await expect(close(f, { notifier: boom })).rejects.toThrow('sms down')
    expect(await t.db.selectFrom('emergency_closures').select('id').execute()).toHaveLength(0)
    expect(
      await t.db
        .selectFrom('appointments')
        .select('id')
        .where('emergency_closure_id', 'is not', null)
        .execute(),
    ).toHaveLength(0)
  })
})

describe('getEmergencyState', () => {
  it('reports the idle strip from real rows: open now, today’s hours, appointments left, vehicles on site', async () => {
    const { f, day } = await shop()
    await day()
    const s = await getEmergencyState(t.db, { locationId: f.locationId, now: NOW, tz: TZ })
    expect(s.active).toBe(false)
    expect(s.current).toBeNull()
    expect(s.strip).toMatchObject({ openNow: true, appointmentsRemaining: 6, vehiclesOnSite: 3 })
    expect(s.strip.today).toMatchObject({ closed: false, openMin: 480, closeMin: 1020 })
  })

  it('is closed outside opening hours and on closure days', async () => {
    const { f } = await shop()
    expect(
      (
        await getEmergencyState(t.db, {
          locationId: f.locationId,
          now: new Date('2026-06-13T07:00:00-04:00'),
          tz: TZ,
        })
      ).strip.openNow,
    ).toBe(false)
    expect(
      (
        await getEmergencyState(t.db, {
          locationId: f.locationId,
          now: new Date('2026-06-13T17:00:00-04:00'),
          tz: TZ,
        })
      ).strip.openNow,
    ).toBe(false)
    await t.db
      .insertInto('closures')
      .values({
        id: f.newId(),
        location_id: f.locationId,
        date: '2026-06-13',
        name: 'Training',
        type: 'closed',
        open_min: null,
        close_min: null,
        federal_key: null,
        federal_year: null,
        emergency_closure_id: null,
        created_by: null,
        deleted_at: null,
      })
      .execute()
    const s = await getEmergencyState(t.db, { locationId: f.locationId, now: NOW, tz: TZ })
    expect(s.strip).toMatchObject({ openNow: false })
    expect(s.strip.today).toMatchObject({ closed: true, reason: 'Training' })
  })

  it('shows the active emergency with live counters and Paused/Open', async () => {
    const { f, day } = await shop()
    const d = await day()
    await close(f)
    await t.db
      .updateTable('emergency_notifications')
      .set({ rebooked_at: NOW })
      .where('appointment_id', 'in', [d.remaining[0]!.id, d.remaining[1]!.id])
      .execute()
    await t.db
      .updateTable('reschedule_links')
      .set({ used_at: NOW })
      .where('appointment_id', 'in', [d.remaining[1]!.id, d.remaining[2]!.id])
      .execute()
    const s = await getEmergencyState(t.db, { locationId: f.locationId, now: NOW, tz: TZ })
    expect(s.active).toBe(true)
    expect(s.current).toMatchObject({
      summary: 'Severe weather · closed for the rest of today · online booking paused',
      reasonLabel: 'Severe weather',
      counters: { affected: 6, notified: 6, rebooked: 3, booking: 'Paused' },
    })
    expect(s.strip.today).toMatchObject({ emergency: true, onlinePaused: true })
    expect(s.strip.openNow).toBe(false)
  })

  it('reports booking as Open when pause was off', async () => {
    const { f } = await shop()
    await close(f, { pause: false })
    const s = await getEmergencyState(t.db, { locationId: f.locationId, now: NOW, tz: TZ })
    expect(s.current!.counters.booking).toBe('Open')
    expect(s.strip.today.onlinePaused).toBe(false)
  })

  it('lists the needs-rebooking queue: flagged, still upcoming, not yet rebooked', async () => {
    const { f, day } = await shop()
    const d = await day()
    const r = await close(f)
    await t.db
      .updateTable('emergency_notifications')
      .set({ rebooked_at: NOW })
      .where('appointment_id', '=', d.remaining[0]!.id)
      .execute()
    await t.db
      .updateTable('reschedule_links')
      .set({ used_at: NOW })
      .where('appointment_id', '=', d.remaining[1]!.id)
      .execute()
    await t.db
      .updateTable('appointments')
      .set({ status: 'canceled' })
      .where('id', '=', d.remaining[2]!.id)
      .execute()
    const queue = await listNeedsRebooking(t.db, {
      locationId: f.locationId,
      emergencyClosureId: r.emergency.id,
      tz: TZ,
    })
    expect(queue.map((a) => a.customerName)).toEqual(['Aisha Rahman', 'Tom Bradley', 'Elena Volkov'])
  })
})

describe('reopenShop', () => {
  it('reopens, freezes real counters into the history row and writes the "Reopened by" detail', async () => {
    const { f, day } = await shop()
    const d = await day()
    const closed = await close(f)
    await t.db
      .updateTable('reschedule_links')
      .set({ used_at: NOW })
      .where('appointment_id', 'in', [d.remaining[0]!.id, d.remaining[1]!.id])
      .execute()
    const later = new Date('2026-06-13T12:00:00-04:00')
    const r = await transaction(t.db, (tx) =>
      reopenShop(tx, {
        locationId: f.locationId,
        now: later,
        tz: TZ,
        reopenedBy: '00000000-0000-7000-8000-0000000000aa',
        reopenedByName: 'Rafael M.',
      }),
    )
    expect(r.detail).toBe('Reopened by Rafael M. · 6 notified')
    expect(r.emergency).toMatchObject({
      active: false,
      reopenedByName: 'Rafael M.',
      autoReopened: false,
      affectedCount: 6,
      notifiedCount: 6,
      rebookedCount: 2,
    })
    expect(r.emergency.reopenedAt?.toISOString()).toBe(later.toISOString())
    expect(r.removedClosureIds).toHaveLength(1)
    const live = await t.db.selectFrom('closures').select('id').where('deleted_at', 'is', null).execute()
    expect(live).toEqual([])
    expect(await getActiveEmergency(t.db, f.locationId)).toBeUndefined()
    const state = await getEmergencyState(t.db, { locationId: f.locationId, now: later, tz: TZ })
    expect(state.strip.today.onlinePaused).toBe(false)
    expect(state.history).toEqual([
      {
        id: closed.emergency.id,
        date: 'Jun 13, 2026',
        reason: 'Severe weather',
        detail: 'Reopened by Rafael M. · 6 notified',
        affectedCount: 6,
        notifiedCount: 6,
        rebookedCount: 2,
      },
    ])
    expect(
      await t.db.selectFrom('appointments').select('id').where('status', '=', 'canceled').execute(),
    ).toEqual([{ id: d.canceled.id }])
    const events = await t.db.selectFrom('realtime_events').select('type').orderBy('id').execute()
    expect(events.map((e) => e.type)).toEqual([
      'emergency.started',
      'settings.changed',
      'emergency.ended',
      'settings.changed',
    ])
  })

  it('removes today’s and future emergency rows, keeps past ones, and restores replaced planned closures from today on', async () => {
    const { f, day } = await shop()
    await day()
    const insertPlanned = async (date: string, name: string) => {
      const id = f.newId()
      await t.db
        .insertInto('closures')
        .values({
          id,
          location_id: f.locationId,
          date,
          name,
          type: 'closed',
          open_min: null,
          close_min: null,
          federal_key: null,
          federal_year: null,
          emergency_closure_id: null,
          created_by: null,
          deleted_at: null,
        })
        .execute()
      return id
    }
    const satPlanned = await insertPlanned('2026-06-13', 'Saturday event')
    const monPlanned = await insertPlanned('2026-06-15', 'Monday event')
    await close(f, { duration: { kind: 'days', throughDate: '2026-06-15' } })
    const sunday = new Date('2026-06-14T09:00:00-04:00')
    const r = await transaction(t.db, (tx) =>
      reopenShop(tx, { locationId: f.locationId, now: sunday, tz: TZ, reopenedByName: 'Rafael M.' }),
    )
    expect(r.restoredClosureIds).toEqual([monPlanned])
    const rows = await t.db
      .selectFrom('closures')
      .select(['id', 'date', 'source', 'deleted_at'])
      .orderBy('date')
      .orderBy('source')
      .execute()
    const live = rows.filter((x) => x.deleted_at === null).map((x) => [x.date, x.source])
    expect(live).toEqual([
      ['2026-06-13', 'emergency'],
      ['2026-06-15', 'manual'],
    ])
    expect(rows.find((x) => x.id === satPlanned)!.deleted_at).not.toBeNull()
    expect(rows.find((x) => x.id === monPlanned)!.deleted_at).toBeNull()
  })

  it('rejects reopening when nothing is active', async () => {
    const { f } = await shop()
    const e = await appError(
      transaction(t.db, (tx) => reopenShop(tx, { locationId: f.locationId, now: NOW, tz: TZ })),
    )
    expect(e).toMatchObject({ code: 'EMERGENCY_NOT_ACTIVE', status: 409 })
  })

  it('allows a new emergency after reopening, and keeps the earlier one as history', async () => {
    const { f } = await shop()
    await close(f)
    await transaction(t.db, (tx) =>
      reopenShop(tx, { locationId: f.locationId, now: NOW, tz: TZ, reopenedByName: 'Rafael M.' }),
    )
    await close(f, { reason: 'power_outage' })
    expect((await getActiveEmergency(t.db, f.locationId))!.reason).toBe('power_outage')
    const state = await getEmergencyState(t.db, { locationId: f.locationId, now: NOW, tz: TZ })
    expect(state.history).toHaveLength(1)
  })

  it('reopens automatically once the end time has passed, and not before', async () => {
    const { f, day } = await shop()
    await day()
    await close(f, { duration: { kind: 'until', untilMin: 840 } })
    const before = await transaction(t.db, (tx) =>
      reopenIfEnded(tx, { locationId: f.locationId, now: new Date('2026-06-13T13:59:00-04:00'), tz: TZ }),
    )
    expect(before).toBeUndefined()
    const after = await transaction(t.db, (tx) =>
      reopenIfEnded(tx, { locationId: f.locationId, now: new Date('2026-06-13T14:00:00-04:00'), tz: TZ }),
    )
    expect(after!.detail).toBe('Reopened automatically · 5 notified')
    expect(after!.emergency).toMatchObject({ active: false, autoReopened: true, reopenedByName: null })
    expect(
      await transaction(t.db, (tx) => reopenIfEnded(tx, { locationId: f.locationId, now: NOW, tz: TZ })),
    ).toBeUndefined()
  })
})
