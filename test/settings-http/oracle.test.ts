// The ORIGINAL Settings design is the oracle. test/fixtures/golden/settings-original.json holds values read from the live
// renderVals() of the original bundle (see golden/extract-settings-oracle.mts); every assertion here compares what the API
// returns, for the same inputs, with what the original computed. Deliberate differences are asserted as such.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { WEEK_ORDER } from '../../src/modules/settings/labels.js'
import { edt, makeAppointment } from '../domain-schema/helpers.js'
import { json, useSettingsHarness } from './harness.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
const golden = JSON.parse(
  readFileSync(new URL('../fixtures/golden/settings-original.json', import.meta.url), 'utf8'),
) as any

const h = useSettingsHarness({ env: { RESCHEDULE_LINK_ENABLED: 'true' } })

const DESIGN_REMAINING: [string, string][] = [
  ['10:15', 'Marcus Webb'],
  ['10:45', 'Liam Chen'],
  ['11:00', 'Grace Adeyemi'],
  ['12:00', 'Aisha Rahman'],
  ['13:30', 'Tom Bradley'],
  ['15:00', 'Elena Volkov'],
]

/** The design's seed (hours, closures, VIP, catalog, customers) plus its Saturday: 6 to come, 3 on site. */
async function seedDesign() {
  await runSeed({ db: h.db, clock: h.clock, profile: 'design' })
  const service = await h.db
    .selectFrom('services')
    .select('id')
    .where('name', '=', 'Express Hand Wash')
    .executeTakeFirstOrThrow()
  const byName = async (name: string) => {
    const c = await h.db
      .selectFrom('customers')
      .select('id')
      .where('full_name', '=', name)
      .executeTakeFirstOrThrow()
    const v = await h.db
      .selectFrom('vehicles')
      .select('id')
      .where('customer_id', '=', c.id)
      .executeTakeFirstOrThrow()
    return { customerId: c.id, vehicleId: v.id }
  }
  for (const [time, name] of DESIGN_REMAINING)
    await makeAppointment(h.db, h.fx, {
      ...(await byName(name)),
      serviceId: service.id,
      start: edt('2026-06-13', time),
    })
  const bay = await h.db.selectFrom('bays').select('id').orderBy('number').executeTakeFirstOrThrow()
  await makeAppointment(h.db, h.fx, {
    ...(await byName('Maria Delgado')),
    serviceId: service.id,
    start: edt('2026-06-13', '08:30'),
    status: 'arrived',
  })
  await makeAppointment(h.db, h.fx, {
    ...(await byName('David Okafor')),
    serviceId: service.id,
    start: edt('2026-06-13', '09:00'),
    status: 'cleaning',
    bayId: bay.id,
  })
  await makeAppointment(h.db, h.fx, {
    ...(await byName('Priya Nair')),
    serviceId: service.id,
    start: edt('2026-06-13', '08:00'),
    status: 'completed',
    pickupState: 'pending',
  })
  return h.admin()
}

describe('working hours match the original', () => {
  it('lists the week as the original does (Monday first), with the same lengths and total', async () => {
    const s = await seedDesign()
    const r = json(await h.get('settings/hours', s))
    const rows = WEEK_ORDER.map((d) => r.days.find((x: any) => x.weekday === d)).map((d: any) => ({
      day: d.day,
      open: d.open,
      closed: !d.open,
      from: d.from,
      to: d.to,
      len: d.len,
    }))
    expect(rows).toEqual(golden.initial.hourRows)
    expect(r.weekHours).toBe(golden.initial.weekHours)
  })

  it('recomputes lengths and the week total after the same edits as the original', async () => {
    const s = await seedDesign()
    const hours = json(await h.get('settings/hours', s))
    const put = async (version: number, edit: (d: any) => any) =>
      json(
        await h.put('settings/hours', s, {
          version,
          days: hours.days.map((d: any) =>
            edit({ weekday: d.weekday, open: d.open, from: d.from, to: d.to }),
          ),
        }),
      )
    const first = await put(hours.version, (d) =>
      d.weekday === 6 ? { ...d, to: '4:30 PM' } : d.weekday === 0 ? { ...d, open: false } : d,
    )
    expect(first.weekHours).toBe(golden.hoursEdited.weekHours)
    expect(
      WEEK_ORDER.map((w) => first.days.find((x: any) => x.weekday === w)).map((d: any) => ({
        day: d.day,
        open: d.open,
        closed: !d.open,
        from: d.from,
        to: d.to,
        len: d.len,
      })),
    ).toEqual(golden.hoursEdited.hourRows)
    const second = json(
      await h.put('settings/hours', s, {
        version: first.version,
        days: first.days.map((d: any) => ({
          weekday: d.weekday,
          open: d.open,
          from: d.from,
          to: d.weekday === 1 ? '5:30 PM' : d.to,
        })),
      }),
    )
    expect(second.weekHours).toBe(golden.hoursEdited2.weekHours)
  })

  it('accepts exactly the booking-rule choices the original offers', async () => {
    const s = await seedDesign()
    const key = ['slot', 'buffer', 'cutoff'] as const
    expect(golden.initial.rules.map((r: { label: string }) => r.label)).toEqual([
      'Slot length',
      'Buffer between jobs',
      'Last booking before close',
    ])
    for (const [i, rule] of golden.initial.rules.entries()) {
      const name = key[i]!
      for (const label of rule.opts as string[]) {
        const v = Number(label.split(' ')[0])
        expect((await h.put('settings/rules', s, { [name]: v })).statusCode, `${name} ${label}`).toBe(200)
      }
      expect((await h.put('settings/rules', s, { [name]: 7 })).statusCode, `${name} 7`).toBe(422)
    }
  })
})

describe('closures match the original', () => {
  it('lists upcoming and past rows with the same date parts, names and type labels in the same order', async () => {
    const s = await seedDesign()
    const r = json(await h.get('closures', s))
    const view = (c: any) => ({
      mon: c.mon,
      day: c.day,
      dow: c.dow,
      name: c.name,
      typeLabel: c.typeLabel,
      past: c.past,
    })
    expect(r.upcoming.map(view)).toEqual(golden.initial.upcoming)
    expect(r.past.map(view)).toEqual(golden.initial.past)
    expect(r.federalAuto).toBe(golden.state.federal)
  })
})

describe('emergency closing matches the original', () => {
  const dur = (c: any) => (c.dur === 'days' ? 'days' : c.dur)
  const query = (c: any) =>
    `emergency/preview?reason=${encodeURIComponent(c.reason)}&dur=${dur(c)}` +
    (c.until ? `&until=${encodeURIComponent(c.until)}` : '') +
    (c.through ? `&through=${c.through}` : '') +
    `&pause=${c.pause}&notify=${c.notify}`

  it("the idle strip reads exactly as the original's static line for the same day", async () => {
    const s = await seedDesign()
    const r = json(await h.get('emergency', s))
    expect(r.strip.text).toBe(golden.emergencyText.idleStrip)
    expect(r.requirement).toBe(golden.emergencyText.access.replace(' · you have access', ''))
    expect(r.options.reasons.map((x: any) => x.label)).toEqual(golden.initial.emReasons)
    expect(r.options.defaultMessage).toBe(golden.state.em.msg)
  })

  for (const [i, cfg] of (golden.emergency as any[]).entries()) {
    it(`config ${i + 1}: ${cfg.config.reason}, ${cfg.config.dur}${cfg.config.until ? ' ' + cfg.config.until : ''}${cfg.config.through ? ' ' + cfg.config.through : ''}`, async () => {
      const s = await seedDesign()
      const c = cfg.config
      const preview = await h.get(query(c), s)
      if (c.dur === 'until' && c.until === '10:30 AM') {
        // deliberate difference: the original accepts a reopening time that has already passed (the clock is 10:36)
        expect(preview.statusCode).toBe(422)
        expect(json(preview).detail).toBe('Pick a reopening time that is later than now.')
        return
      }
      if (c.dur === 'days' && c.through === '2026-12-25') {
        // deliberate difference: a closure is limited to 60 days; the original takes any date
        expect(preview.statusCode).toBe(422)
        expect(json(preview).detail).toBe('Pick a date from today to 60 days out.')
        return
      }
      expect(preview.statusCode).toBe(200)
      const p = json(preview)
      expect(p.renderedMessage).toBe(cfg.preview.emPreview)
      expect(p.count).toBe(Number(cfg.preview.emAffectedCount.split(' ')[0]))
      expect(p.affected.map((a: any) => ({ time: a.time, name: a.customerName, veh: a.vehicle }))).toEqual(
        cfg.preview.emAffected,
      )
      expect(p.summary).toBe(cfg.closed.emSummary)

      const close = await h.post(
        'emergency/close',
        s,
        {
          reason: c.reason,
          dur: c.dur,
          until: c.until,
          through: c.through,
          notify: c.notify,
          pause: c.pause,
        },
        { 'idempotency-key': `oracle-key-${i}-0001` },
      )
      expect(close.statusCode).toBe(201)
      const b = json(close)
      expect(b.summary).toBe(cfg.closed.emSummary)
      const toast = c.notify
        ? `Shop closed · ${b.notifiedCount} customers notified`
        : 'Shop closed · no messages sent'
      expect(toast).toBe(cfg.closed.toast)
      expect(b.emergency.counters.booking).toBe(c.pause ? 'Paused' : 'Open')

      const reopen = json(await h.post('emergency/reopen', s))
      // the original's history line fakes the count with the 6 remaining appointments; ours is the real notified count
      expect(reopen.detail).toBe(`Reopened by Amara O. · ${c.notify ? b.notifiedCount : 0} notified`)
      expect(cfg.reopened.toast).toBe('Shop reopened · online booking resumed')
    })
  }
})

describe('VIP and arrival match the original', () => {
  it('has the same holds (Monday first), settings, option sets and clients', async () => {
    const s = await seedDesign()
    const v = json(await h.get('vip', s))
    expect(v.holds.map((x: any) => x.label)).toEqual(golden.initial.vipHolds)
    expect(golden.initial.vipSteppers.map((x: any) => x.val)).toEqual([
      `${v.windowVip} days`,
      `${v.windowStd} days`,
      `${v.sameDay} / mo`,
    ])
    expect(golden.initial.cadenceOpts).toEqual(v.cadenceOptions.map((x: any) => x.label))
    expect(v.cadences.map((k: string) => v.cadenceOptions.find((o: any) => o.key === k).label)).toEqual(
      golden.state.vip.cadences,
    )
    expect({
      release: v.release,
      offerMin: v.offerMin,
      waitlist: v.waitlist,
      standing: v.standing,
      autoConfirm: v.autoConfirm,
    }).toEqual({
      release: golden.state.vip.release,
      offerMin: golden.state.vip.offerMin,
      waitlist: golden.state.vip.waitlist,
      standing: golden.state.vip.standing,
      autoConfirm: golden.state.vip.autoConfirm,
    })
    expect(golden.initial.vipCount).toBe(`${v.counts.clients} clients`)
    const clients = json(await h.get('vip/clients', s)).items.map((c: any) => c.fullName)
    // same people; the seed adds all four at one instant, so the list falls back to name order instead of insertion order
    expect([...clients].sort()).toEqual([...golden.initial.vipClients].sort())
    const arrival = json(await h.get('arrival-settings', s))
    expect({
      on: arrival.on,
      radius: arrival.radius,
      prepAt: arrival.prepAt,
      autoArrive: arrival.autoArrive,
      welcome: arrival.welcome,
      crew: arrival.crew,
      vipFirst: arrival.vipFirst,
    }).toEqual(golden.state.arrival)
  })

  it('accepts exactly the choices the original offers (release, claim window, radius, prep)', async () => {
    const s = await seedDesign()
    const nums = (labels: string[]) => labels.map((l) => Number(l.split(/[ h]/)[0]))
    for (const [field, labels] of [
      ['release', golden.initial.releaseOpts],
      ['offerMin', golden.initial.offerOpts],
    ] as const)
      for (const n of nums(labels))
        expect((await h.put('vip', s, { [field]: n })).statusCode, `${field} ${n}`).toBe(200)
    expect((await h.put('vip', s, { release: 36 })).statusCode).toBe(422)
    for (const [field, labels] of [
      ['radius', golden.initial.radiusOpts],
      ['prepAt', golden.initial.prepOpts],
    ] as const)
      for (const n of nums(labels))
        expect((await h.put('arrival-settings', s, { [field]: n })).statusCode, `${field} ${n}`).toBe(200)
    expect((await h.put('arrival-settings', s, { radius: 200 })).statusCode).toBe(422)
    // the steppers' bounds in the original: 7-90, 7-60, 0-8
    expect((await h.put('vip', s, { windowVip: 7, windowStd: 7, sameDay: 0 })).statusCode).toBe(200)
    expect((await h.put('vip', s, { windowVip: 90, windowStd: 60, sameDay: 8 })).statusCode).toBe(200)
    expect((await h.put('vip', s, { windowVip: 91 })).statusCode).toBe(422)
    expect((await h.put('vip', s, { windowStd: 61 })).statusCode).toBe(422)
    expect((await h.put('vip', s, { sameDay: 9 })).statusCode).toBe(422)
  })

  it("answers the original's toasts for a held slot, a duplicate and a new VIP", async () => {
    const s = await seedDesign()
    const added = await h.post('vip/holds', s, { weekday: golden.state.holdDay, time: golden.state.holdTime })
    expect(json(added).toast).toBe(golden.holdAdded.toast)
    const dup = await h.post('vip/holds', s, { weekday: golden.state.holdDay, time: golden.state.holdTime })
    expect(dup.statusCode).toBe(409)
    expect(json(dup).title).toBe(golden.holdDuplicate.toast)
    expect(json(dup).detail).toBe(golden.holdDuplicate.toast)
    expect(json(await h.get('vip', s)).holds.map((x: any) => x.label)).toEqual(golden.holdAdded.vipHolds)

    await h.db
      .insertInto('customers')
      .values({
        id: h.identity.newId(),
        full_name: 'Test Person',
        phone_e164: '+13055550150',
        phone_display: '(305) 555-0150',
        synthetic: true,
      })
      .execute()
    const vip = await h.post('vip/clients', s, { name: '  Test Person ' })
    expect(json(vip).toast).toBe(golden.vipAdded.toast)
  })
})

describe('services match the original', () => {
  it('lists the same packages and add-ons, prices, durations and checklist tasks (inspection tasks dropped at seed time)', async () => {
    const s = await seedDesign()
    const r = json(await h.get('services', s))
    const strip = (tasks: string[]) => tasks.filter((t) => !/inspection/i.test(t))
    const pkgs = Object.entries(golden.state.packages) as [string, any][]
    expect(r.packages.map((p: any) => p.name)).toEqual(pkgs.map(([n]) => n))
    for (const [name, p] of pkgs) {
      const mine = r.packages.find((x: any) => x.name === name)
      expect(mine, name).toMatchObject({ priceCents: p.price * 100, durationMin: p.dur })
      expect(
        mine.tasks.map((t: any) => t.label),
        name,
      ).toEqual(strip(p.tasks))
    }
    const addons = Object.entries(golden.state.addons) as [string, any][]
    expect(r.addons.map((p: any) => p.name)).toEqual(addons.map(([n]) => n))
    for (const [name, a] of addons) {
      const mine = r.addons.find((x: any) => x.name === name)
      expect(mine, name).toMatchObject({ priceCents: a.price * 100, durationMin: 0 })
      expect(
        mine.tasks.map((t: any) => t.label),
        name,
      ).toEqual(strip(a.tasks))
    }
  })
})
