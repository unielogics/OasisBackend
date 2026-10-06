// KPI definitions with a frozen clock: window = today + tomorrow in the business tz, "N booked" = upcoming booked +
// confirmed, bay time free, bounded pickup count, members through the port, cash-basis revenue through its port.
import { describe, expect, it } from 'vitest'
import { wallToInstant } from '../../src/platform/time.js'
import { bayMinutesFree, hoursLabel, loadKpis } from '../../src/modules/scheduling/kpis.js'
import type { RevenueSource } from '../../src/modules/scheduling/ports.js'
import { useOps } from './helpers.js'

const o = useOps()
const at = (hhmm: string, date = '2026-06-13'): string => `${date}T${hhmm}:00-04:00`
const TZ = 'America/New_York'
const wall = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number)
  return wallToInstant(date, h! * 60 + m!, TZ)
}

const kpis = async () => Object.fromEntries((await loadKpis(o.t.db, o.ctx)).map((k) => [k.key, k]))

describe('bayMinutesFree (pure)', () => {
  const base = { tz: TZ, openMin: 480, closeMin: 1020, activeBays: 2, bufferMin: 10 }
  const job = (
    status: string,
    from: string,
    to: string,
    extra: Partial<{ cleaningStartedAt: Date | null; durationMin: number }> = {},
  ) => ({
    status,
    start: wall('2026-06-13', from),
    end: wall('2026-06-13', to),
    cleaningStartedAt: null,
    durationMin: 60,
    ...extra,
  })

  it('an empty day is all remaining bay time: 2 bays x remaining open minutes', () => {
    expect(bayMinutesFree({ ...base, now: wall('2026-06-13', '10:36'), jobs: [] })).toBe(2 * (1020 - 636))
    expect(bayMinutesFree({ ...base, now: wall('2026-06-13', '06:00'), jobs: [] })).toBe(2 * 540) // before opening: the whole window
    expect(bayMinutesFree({ ...base, now: wall('2026-06-13', '17:00'), jobs: [] })).toBe(0)
    expect(bayMinutesFree({ ...base, now: wall('2026-06-13', '18:00'), jobs: [] })).toBe(0)
  })

  it('a closed day or no active bay has none', () => {
    expect(
      bayMinutesFree({ ...base, openMin: null, closeMin: null, now: wall('2026-06-13', '10:00'), jobs: [] }),
    ).toBe(0)
    expect(bayMinutesFree({ ...base, activeBays: 0, now: wall('2026-06-13', '10:00'), jobs: [] })).toBe(0)
  })

  it('commits duration plus buffer from the start, or from now for a job already under way', () => {
    const now = wall('2026-06-13', '10:36')
    const free = (jobs: ReturnType<typeof job>[]) => bayMinutesFree({ ...base, now, jobs })
    const all = 2 * 384
    expect(free([job('booked', '12:00', '13:00')])).toBe(all - 70) // 60 + 10
    expect(free([job('booked', '10:00', '11:00')])).toBe(all - (11 * 60 + 10 - 636)) // only from now: 34
    expect(free([job('completed', '12:00', '13:00')])).toBe(all) // finished jobs commit nothing
    expect(free([job('canceled', '12:00', '13:00')])).toBe(all)
  })

  it('a job in a bay runs from its real start and never ends before now (overrun floors at now)', () => {
    const now = wall('2026-06-13', '10:36')
    const free = (j: ReturnType<typeof job>) => bayMinutesFree({ ...base, now, jobs: [j] })
    const all = 2 * 384
    expect(
      free(
        job('cleaning', '10:00', '11:15', {
          cleaningStartedAt: wall('2026-06-13', '10:09'),
          durationMin: 75,
        }),
      ),
    ).toBe(all - (11 * 60 + 24 + 10 - 636))
    // overrunning: started 9:00 for 60 minutes, still here at 10:36: the bay stays committed through now + buffer
    expect(
      free(
        job('cleaning', '09:00', '10:00', {
          cleaningStartedAt: wall('2026-06-13', '09:00'),
          durationMin: 60,
        }),
      ),
    ).toBe(all - 10)
  })

  it('what runs past closing is clipped to the open window', () => {
    const now = wall('2026-06-13', '10:36')
    expect(bayMinutesFree({ ...base, now, jobs: [job('booked', '16:00', '18:30')] })).toBe(2 * 384 - 60)
  })

  it('never negative, and the label is tenths of an hour', () => {
    const now = wall('2026-06-13', '16:00')
    const many = Array.from({ length: 5 }, () => job('booked', '16:00', '17:30'))
    expect(bayMinutesFree({ ...base, now, jobs: many })).toBe(0)
    expect([0, 6, 60, 167, 768].map(hoursLabel)).toEqual(['0h', '0.1h', '1h', '2.8h', '12.8h'])
  })
})

describe('the seven tiles', () => {
  it('Appointments 24h: today and tomorrow, canceled and no-show out; sub = upcoming booked + confirmed', async () => {
    await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('08:30'),
      status: 'completed',
      completedAt: at('09:10'),
    })
    await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Express Hand Wash',
      at: at('11:00'),
      status: 'booked',
    })
    await o.insert({
      customerName: 'Priya Nair',
      serviceName: 'Express Hand Wash',
      at: at('12:00'),
      status: 'confirmed',
    })
    await o.insert({
      customerName: 'Liam Chen',
      serviceName: 'Express Hand Wash',
      at: at('13:00'),
      status: 'arrived',
    })
    await o.insert({
      customerName: 'Tom Bradley',
      serviceName: 'Express Hand Wash',
      at: at('14:00'),
      status: 'canceled',
    })
    await o.insert({
      customerName: 'Grace Adeyemi',
      serviceName: 'Express Hand Wash',
      at: at('15:00'),
      status: 'no_show',
    })
    await o.insert({
      customerName: 'Nathan Brooks',
      serviceName: 'Express Hand Wash',
      at: at('09:00', '2026-06-14'),
      status: 'confirmed',
    })
    await o.insert({
      customerName: 'Elena Volkov',
      serviceName: 'Express Hand Wash',
      at: at('09:00', '2026-06-15'),
      status: 'confirmed',
    }) // the day after tomorrow
    const k = await kpis()
    expect(k.appointments24h).toMatchObject({ value: '5', sub: '3 booked', label: 'Appointments 24h' })
  })

  it('the window is the business day, not UTC: 11:30 PM Eastern tonight is still today', async () => {
    o.clock.set(at('10:36'))
    await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: '2026-06-13T23:30:00-04:00',
      status: 'booked',
    }) // 03:30 UTC tomorrow
    await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Express Hand Wash',
      at: '2026-06-14T00:30:00-04:00',
      status: 'booked',
    })
    expect((await kpis()).appointments24h!.value).toBe('2')
    expect((await kpis()).pendingPayments!.value).toBe('1') // only the first is today
  })

  it('Active jobs, Ready for pickup (bounded) and Members today', async () => {
    await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('10:00'),
      status: 'cleaning',
      bay: 1,
      cleaningStartedAt: at('10:09'),
    })
    await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Express Hand Wash',
      at: at('09:00'),
      status: 'completed',
      completedAt: at('09:40'),
      pickup: 'pending',
    })
    await o.insert({
      customerName: 'Priya Nair',
      serviceName: 'Express Hand Wash',
      at: at('08:30'),
      status: 'completed',
      completedAt: at('09:10'),
      pickup: 'collected',
    })
    await o.insert({
      customerName: 'Liam Chen',
      serviceName: 'Express Hand Wash',
      at: at('16:00', '2026-06-12'),
      status: 'completed',
      completedAt: at('16:40', '2026-06-12'),
      pickup: 'pending',
    }) // yesterday, still waiting
    await o.insert({
      customerName: 'Tom Bradley',
      serviceName: 'Express Hand Wash',
      at: at('16:00', '2026-06-10'),
      status: 'completed',
      completedAt: at('16:40', '2026-06-10'),
      pickup: 'pending',
    }) // three days ago: not on the board
    o.memberships.byCustomer.set(o.customer('Maria Delgado'), {
      plan: 'Essential',
      creditsLeft: 1,
      creditAvailable: false,
    })
    o.memberships.byCustomer.set(o.customer('David Okafor'), {
      plan: 'Executive',
      creditsLeft: null,
      creditAvailable: false,
    })
    const k = await kpis()
    expect(k.activeJobs).toMatchObject({ value: '1', sub: 'in bays' })
    expect(k.readyForPickup).toMatchObject({ value: '2', sub: 'notify' })
    expect(k.membersToday).toMatchObject({ value: '2', sub: 'of 3' })
    await o.t.db
      .updateTable('appointments')
      .set({ pickup_state: 'collected' })
      .where('pickup_state', '=', 'pending')
      .execute()
    expect((await kpis()).readyForPickup).toMatchObject({ value: '0', sub: 'clear' })
  })

  it('Pending payments: today only, with a balance, in cents; canceled jobs are out', async () => {
    const a = await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('11:00'),
      status: 'booked',
    })
    const b = await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Executive Detail',
      at: at('12:00'),
      status: 'confirmed',
    })
    const c = await o.insert({
      customerName: 'Priya Nair',
      serviceName: 'Express Hand Wash',
      at: at('13:00'),
      status: 'confirmed',
    })
    await o.insert({
      customerName: 'Tom Bradley',
      serviceName: 'Express Hand Wash',
      at: at('09:00', '2026-06-14'),
      status: 'confirmed',
    })
    o.gateway.payInFull(c)
    o.gateway.recordPayment(b, 5000, { deposit: true })
    void a
    const k = await kpis()
    // Express 4815 + Executive 27820 - 5000 deposit = 27635
    expect(k.pendingPayments).toMatchObject({ value: '2', sub: '$276.35', raw: 4815 + 22820 })
    await o.t.db.updateTable('appointments').set({ status: 'canceled' }).where('id', '=', a).execute()
    expect((await kpis()).pendingPayments).toMatchObject({ value: '1', sub: '$228.20' })
  })

  it("Revenue today: the payments module's cash-basis figure when wired; otherwise fully paid invoices of today's jobs", async () => {
    const a = await o.insert({
      customerName: 'Maria Delgado',
      serviceName: 'Express Hand Wash',
      at: at('09:00'),
      status: 'completed',
      completedAt: at('09:40'),
    })
    const b = await o.insert({
      customerName: 'David Okafor',
      serviceName: 'Executive Detail',
      at: at('10:00'),
      status: 'booked',
    })
    o.gateway.setTip(a, 800)
    o.gateway.payInFull(a)
    o.gateway.recordPayment(b, 5000, { deposit: true })
    expect((await kpis()).revenueToday).toMatchObject({ value: '$56.15', sub: 'paid', raw: 5615 })
    let asked: [Date, Date] | null = null
    const revenue: RevenueSource = {
      revenueCents: async (_db, _loc, from, to) => {
        asked = [from, to]
        return 123_456
      },
    }
    const wired = { ...o.ctx, ports: { ...o.ctx.ports, revenue } }
    const k = Object.fromEntries((await loadKpis(o.t.db, wired)).map((x) => [x.key, x]))
    expect(k.revenueToday).toMatchObject({ value: '$1,234.56', raw: 123456 })
    // asked for today in the business tz: [midnight, next midnight)
    expect(asked![0]).toEqual(wall('2026-06-13', '00:00'))
    expect(asked![1]).toEqual(wall('2026-06-14', '00:00'))
  })

  it('Bay time free from the database: bays in maintenance take their minutes out', async () => {
    const base = (await kpis()).bayTimeFree!.raw
    expect(base).toBe(2 * 384)
    await o.t.db.updateTable('bays').set({ status: 'maintenance' }).where('number', '=', 2).execute()
    expect((await kpis()).bayTimeFree!.raw).toBe(384)
  })

  it('a closed day has no bay time (today is closed by an emergency)', async () => {
    o.clock.set(at('10:36', '2026-07-04')) // Independence Day
    expect((await kpis()).bayTimeFree).toMatchObject({ raw: 0, value: '0h' })
  })
})
