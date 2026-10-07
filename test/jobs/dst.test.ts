// Cron schedules, reminder arithmetic and quiet hours around the US DST changes: fall back 2026-11-01 (a 25 hour day) and
// spring forward 2027-03-14 (a 23 hour day). Schedules are checked against what pg-boss really does (its prev()-based
// check, src/platform/jobs-cron.ts) and against an independent oracle that reads the cron on the local wall clock.
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { jobDefinitions } from '../../src/platform/job-registry.js'
import { cronFires, cronFiresExhaustive, dstRiskyCron, nextCronRun } from '../../src/platform/jobs-cron.js'
import { dueOffsets, offsetLabel, reminderWhen } from '../../src/modules/messaging/jobs/reminders.js'
import {
  isQuietHour,
  quietHoursEnd,
  type QuietHoursConfig,
} from '../../src/modules/messaging/policy/quietHours.js'
import { bizDayBounds, dayLengthMinutes } from '../../src/platform/time.js'

const TZ = 'America/New_York'
const FALL = '2026-11-01'
const SPRING = '2027-03-14'
const NORMAL = '2026-10-07'

/** Values a single cron field allows (supports *, n, a-b, lists and step). */
function allowed(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [range, step] = part.split('/')
    const [a, b] = (range ?? '*').split('-')
    const from = range === '*' ? lo : Number(a)
    const to = range === '*' ? hi : b === undefined ? (step === undefined ? from : hi) : Number(b)
    for (let v = from; v <= to; v += step === undefined ? 1 : Number(step)) out.add(v)
  }
  return out
}

/** The wall-clock fields at every elapsed minute of [start, end) (computed once per window). */
type Wall = { minute: number; hour: number; day: number; month: number; weekday: number }
const wallCache = new Map<string, Wall[]>()
function wall(start: Date, end: Date): Wall[] {
  const key = `${start.getTime()}-${end.getTime()}`
  let rows = wallCache.get(key)
  if (!rows) {
    rows = []
    for (let t = start.getTime(); t < end.getTime(); t += 60_000) {
      const l = DateTime.fromMillis(t, { zone: TZ })
      rows.push({ minute: l.minute, hour: l.hour, day: l.day, month: l.month, weekday: l.weekday % 7 })
    }
    wallCache.set(key, rows)
  }
  return rows
}

/** How many elapsed minutes of the window match the cron on the wall clock: the schedule as a human reads it. */
function oracle(cron: string, start: Date, end: Date): number {
  const [m, h, dom, mon, dow] = cron.split(/\s+/) as [string, string, string, string, string]
  const mins = allowed(m, 0, 59)
  const hours = allowed(h, 0, 23)
  const doms = allowed(dom, 1, 31)
  const mons = allowed(mon, 1, 12)
  const dows = new Set([...allowed(dow, 0, 7)].map((d) => d % 7))
  return wall(start, end).filter(
    (l) =>
      mins.has(l.minute) && hours.has(l.hour) && doms.has(l.day) && mons.has(l.month) && dows.has(l.weekday),
  ).length
}

/** The first seven elapsed hours of a business day: the change happens at 02:00 local, so this brackets it. */
const morning = (bizDate: string): { start: Date; end: Date } => {
  const { start } = bizDayBounds(bizDate, TZ)
  return { start, end: new Date(start.getTime() + 7 * 3_600_000) }
}

const fires = (cron: string, bizDate: string, window = bizDayBounds(bizDate, TZ)): number =>
  cronFires(cron, TZ, window.start, window.end).length

describe('the days themselves', () => {
  it('are 25 and 23 hours long', () => {
    expect(dayLengthMinutes(FALL, TZ)).toBe(25 * 60)
    expect(dayLengthMinutes(SPRING, TZ)).toBe(23 * 60)
    expect(dayLengthMinutes(NORMAL, TZ)).toBe(24 * 60)
  })
})

describe('cron schedules around DST', () => {
  const crons = jobDefinitions.filter((d) => d.cron).map((d) => ({ name: d.name, cron: d.cron! }))
  const distinct = [...new Set(crons.map((c) => c.cron))]

  it('has scheduled jobs to check', () => {
    expect(crons.length).toBeGreaterThanOrEqual(18)
  })

  it('no registered job fires at a fixed local time inside the hour DST skips or repeats (01:00-02:59)', () => {
    expect(crons.filter((c) => dstRiskyCron(c.cron)).map((c) => `${c.name} ${c.cron}`)).toEqual([])
  })

  it.each([
    ['fall back', FALL],
    ['spring forward', SPRING],
  ])(
    'every registered schedule fires as often as its wall-clock reading says in the hours around the change on %s',
    (_what, day) => {
      const w = morning(day)
      for (const cron of distinct)
        expect(
          fires(cron, day, w),
          `${crons
            .filter((c) => c.cron === cron)
            .map((c) => c.name)
            .join(', ')} ${cron}`,
        ).toBe(oracle(cron, w.start, w.end))
    },
    120_000,
  )

  it('the fire times collected from prev() are the ones the literal 5-seconds-into-every-minute rule gives', () => {
    const windows: Array<[string, string, string]> = [
      ['30 2 * * *', '2027-03-14T06:00:00Z', '2027-03-14T08:30:00Z'],
      ['30 1 * * *', '2026-11-01T05:00:00Z', '2026-11-01T07:30:00Z'],
      ['*/30 * * * *', '2026-11-01T05:00:00Z', '2026-11-01T07:30:00Z'],
    ]
    for (const [cron, a, b] of windows)
      expect(cronFires(cron, TZ, new Date(a), new Date(b)), cron).toEqual(
        cronFiresExhaustive(cron, TZ, new Date(a), new Date(b)),
      )
  }, 120_000)

  it('interval jobs run 23 hours worth of times on the short day and 25 on the long day', () => {
    expect(fires('*/15 * * * *', SPRING)).toBe(23 * 4)
    expect(fires('*/15 * * * *', FALL)).toBe(25 * 4)
    expect(fires('0 * * * *', SPRING)).toBe(23)
    expect(fires('0 * * * *', FALL)).toBe(25)
    expect(fires('0 * * * *', NORMAL)).toBe(24)
  })

  it('a daily job outside 01:00-02:59 runs exactly once on both transition days', () => {
    for (const cron of ['10 0 * * *', '0 3 * * *', '30 3 * * *', '40 3 * * *', '20 4 * * *'])
      for (const day of [FALL, SPRING]) expect(fires(cron, day), `${cron} ${day}`).toBe(1)
  })

  it('shows why the hour is avoided: a time inside it is skipped in spring and runs twice in fall', () => {
    expect(fires('30 2 * * *', SPRING)).toBe(0) // pg-boss never sees the 02:30 that does not exist
    expect(fires('30 1 * * *', FALL)).toBe(2) // 01:30 happens twice
    expect(dstRiskyCron('30 2 * * *')).toBe(true)
    expect(dstRiskyCron('30 1 * * *')).toBe(true)
    expect(dstRiskyCron('0 3 * * *')).toBe(false)
    expect(dstRiskyCron('*/5 * * * *')).toBe(false)
  })

  it('the 03:00 jobs keep their wall time: 03:00 EDT on the short day, 03:00 EST on the long day', () => {
    const at = (cron: string, day: string) => {
      const { start, end } = bizDayBounds(day, TZ)
      return cronFires(cron, TZ, start, end).map((d) =>
        DateTime.fromJSDate(d, { zone: TZ }).toFormat('HH:mm ZZZZ'),
      )
    }
    expect(at('0 3 * * *', SPRING)).toEqual(['03:00 EDT'])
    expect(at('0 3 * * *', FALL)).toEqual(['03:00 EST'])
    expect(at('10 0 * * *', FALL)).toEqual(['00:10 EDT'])
  })

  it('the next fire (what the status endpoint shows) follows the wall clock across the change', () => {
    const next = (cron: string, after: string) =>
      DateTime.fromJSDate(nextCronRun(cron, TZ, new Date(after)), { zone: TZ }).toFormat(
        'yyyy-LL-dd HH:mm ZZZZ',
      )
    expect(next('0 3 * * *', '2027-03-13T12:00:00Z')).toBe('2027-03-14 03:00 EDT')
    expect(next('40 3 * * *', '2026-10-31T12:00:00Z')).toBe('2026-11-01 03:40 EST')
    expect(next('5 0 1 1 *', '2026-06-13T12:00:00Z')).toBe('2027-01-01 00:05 EST')
  })
})

describe('reminder moments are elapsed time, their words are local', () => {
  const at = (iso: string): Date => new Date(iso)

  it('"24 h before" an appointment on spring-forward day is one wall-clock hour earlier than the visit time, 23 elapsed hours after midnight', () => {
    // 09:00 EDT on 2027-03-14 = 13:00Z; 24 h earlier is 13:00Z on 03-13 = 08:00 EST
    const start = at('2027-03-14T13:00:00Z')
    const booked = at('2027-03-01T15:00:00Z')
    expect(dueOffsets([1440, 120], start, booked, at('2027-03-13T12:59:00Z'))).toEqual([])
    expect(dueOffsets([1440, 120], start, booked, at('2027-03-13T13:00:00Z'))).toEqual([1440])
    expect(DateTime.fromISO('2027-03-13T13:00:00Z', { zone: TZ }).toFormat('HH:mm ZZZZ')).toBe('08:00 EST')
    // 2 h before is 07:00 EDT
    expect(dueOffsets([1440, 120], start, booked, at('2027-03-14T11:00:00Z'))).toEqual([120])
    expect(DateTime.fromISO('2027-03-14T11:00:00Z', { zone: TZ }).toFormat('HH:mm ZZZZ')).toBe('07:00 EDT')
  })

  it('on fall-back day the 24 h reminder for a 09:00 EST visit leaves at 10:00 EDT the day before', () => {
    const start = at('2026-11-01T14:00:00Z') // 09:00 EST
    const booked = at('2026-10-20T15:00:00Z')
    expect(dueOffsets([1440], start, booked, at('2026-10-31T14:00:00Z'))).toEqual([1440])
    expect(DateTime.fromISO('2026-10-31T14:00:00Z', { zone: TZ }).toFormat('HH:mm ZZZZ')).toBe('10:00 EDT')
  })

  it('does not send a stale reminder (worker was down) and not one for a booking made after its moment', () => {
    const start = at('2026-10-08T14:00:00Z')
    const booked = at('2026-10-01T12:00:00Z')
    // 24 h moment is 10-07T14:00Z; 61 minutes later it is stale, 59 minutes later it is still sent
    expect(dueOffsets([1440], start, booked, at('2026-10-07T15:01:00Z'))).toEqual([])
    expect(dueOffsets([1440], start, booked, at('2026-10-07T14:59:00Z'))).toEqual([1440])
    // booked 5 hours before the visit: the 24 h reminder never applies, the 2 h one does
    const late = at('2026-10-08T09:00:00Z')
    expect(dueOffsets([1440, 120], start, late, at('2026-10-08T12:00:00Z'))).toEqual([120])
    expect(dueOffsets([1440, 120], start, late, at('2026-10-07T14:30:00Z'))).toEqual([])
  })

  it('the words use calendar dates, so "tomorrow" is right on the 23 and 25 hour days', () => {
    // 23:30 EST the evening before spring-forward: a visit on 03-14 is tomorrow, one on 03-15 is not
    const now = at('2027-03-14T04:30:00Z')
    expect(DateTime.fromJSDate(now, { zone: TZ }).toFormat('yyyy-LL-dd HH:mm')).toBe('2027-03-13 23:30')
    expect(reminderWhen(at('2027-03-14T13:00:00Z'), now, TZ)).toBe('tomorrow')
    expect(reminderWhen(at('2027-03-15T13:00:00Z'), now, TZ)).toBe('on Mon, Mar 15')
    // 00:30 EDT on the long day: 24 elapsed hours later is still 11-01, so an hour-based "tomorrow" would be wrong
    const longDay = at('2026-11-01T04:30:00Z')
    expect(DateTime.fromJSDate(longDay, { zone: TZ }).toFormat('yyyy-LL-dd HH:mm')).toBe('2026-11-01 00:30')
    expect(reminderWhen(at('2026-11-02T15:00:00Z'), longDay, TZ)).toBe('tomorrow')
    expect(reminderWhen(at('2026-11-01T18:00:00Z'), longDay, TZ)).toBe('today')
    expect(offsetLabel(1440)).toBe('24 h')
    expect(offsetLabel(90)).toBe('90 min')
  })
})

describe('quiet hours across DST (21:00-08:00)', () => {
  const cfg: QuietHoursConfig = { enabled: true, startMinute: 21 * 60, endMinute: 8 * 60, timeZone: TZ }
  const local = (d: Date): string => DateTime.fromJSDate(d, { zone: TZ }).toFormat('yyyy-LL-dd HH:mm ZZZZ')

  it('holds until 08:00 local on the night the clocks go forward', () => {
    const evening = new Date('2027-03-14T02:30:00Z') // 21:30 EST on 03-13
    expect(isQuietHour(evening, cfg)).toBe(true)
    expect(local(quietHoursEnd(evening, cfg))).toBe('2027-03-14 08:00 EDT')
    const afterGap = new Date('2027-03-14T07:30:00Z') // 03:30 EDT, the first minutes after the missing hour
    expect(isQuietHour(afterGap, cfg)).toBe(true)
    expect(local(quietHoursEnd(afterGap, cfg))).toBe('2027-03-14 08:00 EDT')
  })

  it('holds until 08:00 local on the night the clocks go back, from either 01:30', () => {
    const first = new Date('2026-11-01T05:30:00Z') // 01:30 EDT
    const second = new Date('2026-11-01T06:30:00Z') // 01:30 EST
    for (const d of [first, second]) {
      expect(isQuietHour(d, cfg)).toBe(true)
      expect(local(quietHoursEnd(d, cfg))).toBe('2026-11-01 08:00 EST')
    }
    expect(local(quietHoursEnd(new Date('2026-11-01T01:30:00Z'), cfg))).toBe('2026-11-01 08:00 EST') // 21:30 EDT the evening before
  })

  it('the window edges stay at 21:00 and 08:00 local on both days', () => {
    expect(isQuietHour(new Date('2027-03-14T11:59:00Z'), cfg)).toBe(true) // 07:59 EDT
    expect(isQuietHour(new Date('2027-03-14T12:00:00Z'), cfg)).toBe(false) // 08:00 EDT
    expect(isQuietHour(new Date('2026-11-01T12:59:00Z'), cfg)).toBe(true) // 07:59 EST
    expect(isQuietHour(new Date('2026-11-01T13:00:00Z'), cfg)).toBe(false) // 08:00 EST
    expect(isQuietHour(new Date('2026-11-02T01:59:00Z'), cfg)).toBe(false) // 20:59 EST
    expect(isQuietHour(new Date('2026-11-02T02:00:00Z'), cfg)).toBe(true) // 21:00 EST
  })
})
