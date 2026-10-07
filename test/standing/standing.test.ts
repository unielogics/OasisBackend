// Gap 7 (stretch): standing (recurring) appointments behind the feature switch. Real Postgres, real app; the jobs run through their
// service functions so the clock can move.
import { describe, expect, it } from 'vitest'
import { autoConfirmDue, materializeAll, updateSeries } from '../../src/modules/standing/series.js'
import { appointmentsOf, idemKey, jobRig, setFeature, setVip, useRig, type Rig } from './support.js'

interface SeriesReply {
  series: {
    id: string
    weekday: number
    timeMin: number
    generatedThrough: string | null
    status: string
    version: number
  }
  materialized: { booked: number; skipped: number; through: string | null }
}

const create = async (m: Rig, over: Record<string, unknown> = {}, key = idemKey()) =>
  m.send(
    m.superS(),
    'POST',
    '/standing-series',
    {
      customerId: await m.customer('Liam Chen'),
      serviceId: (
        await m.h.t.db
          .selectFrom('services')
          .select('id')
          .where('name', '=', 'Express Hand Wash')
          .executeTakeFirstOrThrow()
      ).id,
      cadence: 'weekly',
      startDate: '2026-06-20', // a Saturday
      time: '09:00',
      ...over,
    },
    key,
  )

describe('standing appointments, feature off (the default)', () => {
  const m = useRig()
  const jobs = jobRig(m)

  it('every endpoint answers 409 FEATURE_DISABLED, a series row is never materialized and nothing is offered', async () => {
    expect((await m.get(m.superS(), '/settings/features')).json()).toMatchObject({ standingWaitlist: false })
    for (const [method, url, body] of [
      ['POST', '/standing-series', undefined],
      ['GET', '/standing-series', undefined],
      ['GET', '/waitlist', undefined],
    ] as const) {
      const res = method === 'GET' ? await m.get(m.superS(), url) : await create(m)
      expect(res.statusCode, `${method} ${url}`).toBe(409)
      expect(res.json()).toMatchObject({ code: 'FEATURE_DISABLED' })
      void body
    }
    // an active series left in the table does nothing while the switch is off
    const customerId = await m.customer('Liam Chen')
    const svc = await m.h.t.db
      .selectFrom('services')
      .select('id')
      .where('name', '=', 'Express Hand Wash')
      .executeTakeFirstOrThrow()
    await m.h.t.db
      .insertInto('standing_series')
      .values({
        id: m.h.t.app.newId(),
        location_id: m.locationId(),
        customer_id: customerId,
        service_id: svc.id,
        cadence: 'weekly',
        weekday: 6,
        time_min: 540,
        start_date: '2026-06-20',
      })
      .execute()
    expect(await jobs.tx((tx, c) => materializeAll(tx, c))).toMatchObject({ booked: 0, series: 0 })
    expect(await jobs.tx((tx, c) => autoConfirmDue(tx, c))).toEqual({ confirmed: 0 })
    expect((await m.h.t.db.selectFrom('appointments').select('id').execute()).length).toBe(0)
  })

  it('only set.billing flips the switch, and it is audited', async () => {
    expect(
      (await m.send(m.limited(), 'PUT', '/settings/features', { standingWaitlist: true }, false)).statusCode,
    ).toBe(403)
    await setFeature(m, true)
    expect((await m.get(m.limited(), '/settings/features')).json()).toMatchObject({ standingWaitlist: true })
    expect(
      (
        await m.h.t.db
          .selectFrom('audit_log')
          .select('action')
          .where('action', '=', 'settings.update')
          .execute()
      ).length,
    ).toBeGreaterThan(0)
  })
})

describe('standing appointments, feature on', () => {
  const m = useRig()
  const jobs = jobRig(m)

  it('creates a series for a VIP, books the next four weeks as standing appointments, skips a closed day with the reason', async () => {
    await setFeature(m, true)
    const res = await create(m, { endDate: null })
    expect(res.statusCode, res.body).toBe(201)
    const b = res.json() as SeriesReply
    expect(b.series).toMatchObject({
      weekday: 6,
      timeMin: 540,
      status: 'active',
      generatedThrough: '2026-07-11',
    })
    // Jun 20, Jun 27 and Jul 11 booked; Jul 4 (Independence Day) is closed
    expect(b.materialized).toEqual({ booked: 3, skipped: 1, through: '2026-07-11' })
    const appts = await appointmentsOf(m, b.series.id)
    expect(appts.map((a) => [a.start.toISOString(), a.status, a.source])).toEqual([
      ['2026-06-20T13:00:00.000Z', 'booked', 'standing'],
      ['2026-06-27T13:00:00.000Z', 'booked', 'standing'],
      ['2026-07-11T13:00:00.000Z', 'booked', 'standing'],
    ])
    const detail = (await m.get(m.superS(), `/standing-series/${b.series.id}`)).json() as {
      occurrences: { date: string; status: string; reason: string | null; appointmentId: string | null }[]
    }
    expect(detail.occurrences.map((o) => [o.date, o.status, o.reason])).toEqual([
      ['2026-06-20', 'booked', null],
      ['2026-06-27', 'booked', null],
      ['2026-07-04', 'skipped', 'SLOT_CLOSED'],
      ['2026-07-11', 'booked', null],
    ])
    // each one has its invoice, and no "thanks for booking" text goes out for a recurring visit
    const invoices = await m.h.t.db.selectFrom('invoices').select('appointment_id').execute()
    expect(invoices).toHaveLength(3)
    const texts = await m.h.t.db
      .selectFrom('messages')
      .select('body')
      .where('direction', '=', 'out')
      .execute()
    expect(texts.filter((t) => t.body.includes('thanks for booking'))).toHaveLength(0)
  })

  it('is idempotent: a repeated request returns the stored answer and a second run books nothing new', async () => {
    await setFeature(m, true)
    const key = idemKey()
    const one = await create(m, {}, key)
    const replay = await create(m, {}, key)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(replay.json()).toEqual(one.json())
    expect((await m.h.t.db.selectFrom('standing_series').select('id').execute()).length).toBe(1)
    const again = await jobs.tx((tx, c) => materializeAll(tx, c))
    expect(again).toMatchObject({ booked: 0, skipped: 0, series: 1 })
    expect((await m.h.t.db.selectFrom('appointments').select('id').execute()).length).toBe(3)
    const noKey = await m.send(
      m.superS(),
      'POST',
      '/standing-series',
      {
        customerId: await m.customer('Liam Chen'),
        serviceId: (
          await m.h.t.db
            .selectFrom('services')
            .select('id')
            .where('name', '=', 'Express Hand Wash')
            .executeTakeFirstOrThrow()
        ).id,
        cadence: 'weekly',
        startDate: '2026-06-20',
        time: '09:00',
      },
      false,
    )
    expect(noKey.statusCode, noKey.body).toBe(400)
    expect(noKey.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
  })

  it('the daily job books the next window as the clock moves, and never double books a date', async () => {
    await setFeature(m, true)
    const b = (await create(m)).json() as SeriesReply
    m.h.clock.set('2026-06-27T04:00:00-04:00')
    const next = await jobs.tx((tx, c) => materializeAll(tx, c))
    expect(next).toMatchObject({ booked: 2, series: 1 }) // Jul 18 and Jul 25 enter the window; Jun 20-Jul 11 are already decided
    expect((await appointmentsOf(m, b.series.id)).map((a) => a.start.toISOString().slice(0, 10))).toEqual([
      '2026-06-20',
      '2026-06-27',
      '2026-07-11',
      '2026-07-18',
      '2026-07-25',
    ])
    const rerun = await jobs.tx((tx, c) => materializeAll(tx, c))
    expect(rerun.booked).toBe(0)
  })

  it('every cadence materializes by its own rule: every 2 weeks and monthly (2nd Saturday)', async () => {
    await setFeature(m, true)
    await setVip(m, { cadences: ['weekly', 'biweekly', 'monthly'] })
    const bi = (
      await create(m, { cadence: 'biweekly', startDate: '2026-06-13', time: '15:00' })
    ).json() as SeriesReply
    expect((await appointmentsOf(m, bi.series.id)).map((a) => a.start.toISOString().slice(0, 10))).toEqual([
      '2026-06-13',
      '2026-06-27',
      '2026-07-11',
    ])
    const monthly = (
      await create(m, {
        cadence: 'monthly',
        startDate: '2026-06-13',
        time: '14:00',
        customerId: await m.customer('Aisha Rahman'),
      })
    ).json() as SeriesReply
    expect(
      (await appointmentsOf(m, monthly.series.id)).map((a) => a.start.toISOString().slice(0, 10)),
    ).toEqual(['2026-06-13', '2026-07-11'])
  })

  it('refuses what the VIP settings and the client do not allow', async () => {
    await setFeature(m, true)
    const notVip = await create(m, { customerId: await m.customer('Maria Delgado') })
    expect(notVip.statusCode).toBe(422)
    expect(notVip.json()).toMatchObject({ code: 'STANDING_VIP_ONLY' })
    const cadence = await create(m, { cadence: 'triweekly' })
    expect(cadence.json()).toMatchObject({ code: 'STANDING_CADENCE_NOT_OFFERED' })
    expect((await create(m, { startDate: '2026-06-01' })).statusCode).toBe(422)
    expect((await create(m, { startDate: '2026-06-20', endDate: '2026-06-01' })).statusCode).toBe(422)
    await setVip(m, { standing: false })
    expect((await create(m)).json()).toMatchObject({ code: 'STANDING_OFF' })
    expect((await m.send(m.limited(), 'POST', '/standing-series', {}, idemKey())).statusCode).toBe(403)
  })

  it('auto-confirms booked standing visits 48 hours ahead, only when the series and the VIP settings both say so', async () => {
    await setFeature(m, true)
    const b = (await create(m)).json() as SeriesReply
    const [first] = await appointmentsOf(m, b.series.id)
    const plain = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-20T13:00:00-04:00')
    m.h.clock.set('2026-06-18T08:30:00-04:00') // 48.5 hours before Jun 20 9:00
    expect(await jobs.tx((tx, c) => autoConfirmDue(tx, c))).toEqual({ confirmed: 0 })
    m.h.clock.set('2026-06-18T09:30:00-04:00')
    expect(await jobs.tx((tx, c) => autoConfirmDue(tx, c))).toEqual({ confirmed: 1 })
    const rows = await m.h.t.db
      .selectFrom('appointments')
      .select(['id', 'status'])
      .where('id', 'in', [first!.id, plain.appointmentId])
      .execute()
    expect(rows.find((r) => r.id === first!.id)!.status).toBe('confirmed')
    expect(rows.find((r) => r.id === plain.appointmentId)!.status).toBe('booked') // not a standing visit
    expect(jobs.queue.keys()).toEqual(['confirmed'])
    expect(await jobs.tx((tx, c) => autoConfirmDue(tx, c))).toEqual({ confirmed: 0 })

    // series flag off: the Jun 27 visit stays booked (the session lives on the frozen clock, so these use the service)
    m.h.clock.set('2026-06-25T09:30:00-04:00')
    await jobs.tx((tx, c) => updateSeries(tx, c, b.series.id, { autoConfirm: false }))
    expect(await jobs.tx((tx, c) => autoConfirmDue(tx, c))).toEqual({ confirmed: 0 })
    // and the VIP-level switch
    await jobs.tx((tx, c) => updateSeries(tx, c, b.series.id, { autoConfirm: true }))
    await jobs.tx((tx) => tx.updateTable('vip_settings').set({ auto_confirm: false }).execute())
    expect(await jobs.tx((tx, c) => autoConfirmDue(tx, c))).toEqual({ confirmed: 0 })
    await jobs.tx((tx) => tx.updateTable('vip_settings').set({ auto_confirm: true }).execute())
    expect(await jobs.tx((tx, c) => autoConfirmDue(tx, c))).toEqual({ confirmed: 1 })
  })

  it('pausing stops materializing, resuming picks up, ending with cancelUpcoming takes the visits off the books, ended is final', async () => {
    await setFeature(m, true)
    const b = (await create(m)).json() as SeriesReply
    const patch = (body: Record<string, unknown>) =>
      m.send(m.superS(), 'PATCH', `/standing-series/${b.series.id}`, body, idemKey())
    const NOW = '2026-06-13T10:36:00-04:00' // the session lives on the frozen clock; go back to it for HTTP calls
    expect((await patch({ status: 'paused' })).json()).toMatchObject({
      series: { status: 'paused' },
      canceled: 0,
    })
    m.h.clock.set('2026-06-27T04:00:00-04:00')
    expect((await jobs.tx((tx, c) => materializeAll(tx, c))).booked).toBe(0)
    m.h.clock.set(NOW)
    expect((await patch({ status: 'active' })).json()).toMatchObject({ series: { status: 'active' } })
    m.h.clock.set('2026-06-27T04:00:00-04:00')
    expect((await jobs.tx((tx, c) => materializeAll(tx, c))).booked).toBe(2)
    m.h.clock.set(NOW)
    const ended = await patch({ status: 'ended', cancelUpcoming: true })
    expect(ended.statusCode, ended.body).toBe(200)
    expect((ended.json() as { canceled: number }).canceled).toBe(5) // Jun 20, Jun 27, Jul 11, Jul 18, Jul 25
    const left = (await appointmentsOf(m, b.series.id)).filter(
      (a) => a.status === 'booked' && a.start > m.h.clock.now(),
    )
    expect(left).toHaveLength(0)
    expect((await patch({ status: 'active' })).statusCode).toBe(422)
    expect((await m.get(m.superS(), '/standing-series')).json()).toMatchObject({ items: [] })
    expect(
      ((await m.get(m.superS(), '/standing-series?includeEnded=true')).json() as { items: unknown[] }).items,
    ).toHaveLength(1)
  })

  it('a stale version is refused', async () => {
    await setFeature(m, true)
    const b = (await create(m)).json() as SeriesReply
    const res = await m.send(
      m.superS(),
      'PATCH',
      `/standing-series/${b.series.id}`,
      { notes: 'x', version: b.series.version + 5 },
      idemKey(),
    )
    expect(res.statusCode).toBe(412)
  })
})
