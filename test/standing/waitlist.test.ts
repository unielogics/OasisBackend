// Gap 7 (stretch): the waitlist. A client waits for a date and a time window; a canceled booking frees its slot and the slot is
// offered by text (VIPs first when the priority toggle is on), the first accept books it. Real Postgres, real app, real messaging queue.
import { describe, expect, it } from 'vitest'
import { acceptOffer, expireOffers } from '../../src/modules/standing/waitlist.js'
import { systemActor } from '../../src/modules/standing/support.js'
import { idemKey, jobRig, setFeature, setVip, useRig, type Rig } from './support.js'

const MON = '2026-06-15'
const SLOT = `${MON}T10:00:00-04:00`

interface EntryReply {
  id: string
  status: string
  isVip: boolean
  appointmentId: string | null
  openOffer: { slotStart: string; phase: string; expiresAt: string } | null
}

async function express(m: Rig): Promise<string> {
  return (
    await m.h.t.db
      .selectFrom('services')
      .select('id')
      .where('name', '=', 'Express Hand Wash')
      .executeTakeFirstOrThrow()
  ).id
}

async function join(m: Rig, who: string, over: Record<string, unknown> = {}, s = m.superS()) {
  return m.send(
    s,
    'POST',
    '/waitlist',
    {
      customerId: await m.customer(who),
      serviceId: await express(m),
      desiredDate: MON,
      windowStart: '09:00',
      windowEnd: '11:00',
      ...over,
    },
    false,
  )
}

/** Two bookings fill both bays at 10:00 on Monday; the waitlist waits for one of them to go. */
async function fullSlot(m: Rig) {
  const a = await m.book('Maria Delgado', 'Express Hand Wash', SLOT)
  const b = await m.book('David Okafor', 'Express Hand Wash', SLOT)
  const full = await m.send(
    m.superS(),
    'POST',
    '/appointments',
    { customer: { id: await m.customer('Priya Nair') }, serviceId: await express(m), start: SLOT },
    idemKey(),
  )
  expect(full.statusCode, 'the slot is really full').toBe(409)
  return { a, b }
}

const cancel = (m: Rig, id: string) =>
  m.send(m.superS(), 'POST', `/appointments/${id}/cancel`, { reason: 'Customer called' }, idemKey())
const entries = async (m: Rig): Promise<EntryReply[]> =>
  ((await m.get(m.superS(), '/waitlist')).json() as { items: EntryReply[] }).items
const offerTexts = async (m: Rig) =>
  (
    await m.h.t.db
      .selectFrom('messages')
      .select(['peer_e164', 'body'])
      .where('direction', '=', 'out')
      .where('purpose', '=', 'waitlist_offer')
      .orderBy('queued_at')
      .orderBy('id')
      .execute()
  ).map((r) => r.peer_e164)

describe('waitlist entries', () => {
  const m = useRig()

  it('needs the feature, sched.edit, a real window and a date from today on; VIP is read from the client', async () => {
    expect((await join(m, 'Liam Chen')).json()).toMatchObject({ code: 'FEATURE_DISABLED' })
    await setFeature(m, true)
    expect((await join(m, 'Liam Chen', {}, m.limited())).statusCode).toBe(403)
    expect((await join(m, 'Liam Chen', { windowStart: '11:00', windowEnd: '09:00' })).statusCode).toBe(422)
    expect((await join(m, 'Liam Chen', { desiredDate: '2026-06-01' })).statusCode).toBe(422)
    const vip = await join(m, 'Liam Chen')
    expect(vip.statusCode, vip.body).toBe(201)
    expect(vip.json()).toMatchObject({ status: 'waiting', isVip: true, openOffer: null })
    expect((await join(m, 'Priya Nair')).json()).toMatchObject({ isVip: false })
    expect((await entries(m)).map((e) => e.status)).toEqual(['waiting', 'waiting'])
    expect(
      ((await m.get(m.superS(), `/waitlist?status=offered`)).json() as { items: unknown[] }).items,
    ).toEqual([])
  })

  it('cancel withdraws the entry and its offer', async () => {
    await setFeature(m, true)
    await fullSlot(m)
    const e = (await join(m, 'Liam Chen')).json() as EntryReply
    expect((await m.send(m.superS(), 'POST', `/waitlist/${e.id}/cancel`, {}, false)).json()).toMatchObject({
      status: 'canceled',
    })
    expect((await m.send(m.superS(), 'POST', `/waitlist/${e.id}/cancel`, {}, false)).json()).toMatchObject({
      code: 'WAITLIST_NOT_WAITING',
    })
  })
})

describe('a freed slot is offered', () => {
  const m = useRig()
  const jobs = jobRig(m)

  it('to VIP entries first for the claim window; the others wait; the text says how long it is held', async () => {
    await setFeature(m, true)
    const { a } = await fullSlot(m)
    const liam = (await join(m, 'Liam Chen')).json() as EntryReply
    const priya = (await join(m, 'Priya Nair')).json() as EntryReply
    expect((await cancel(m, a.appointmentId)).statusCode).toBe(200)
    const list = await entries(m)
    const byId = new Map(list.map((e) => [e.id, e]))
    expect(byId.get(liam.id)).toMatchObject({ status: 'offered', openOffer: { phase: 'vip' } })
    expect(byId.get(priya.id)).toMatchObject({ status: 'waiting', openOffer: null })
    const offer = byId.get(liam.id)!.openOffer!
    expect(new Date(offer.slotStart).toISOString()).toBe('2026-06-15T14:00:00.000Z')
    expect(new Date(offer.expiresAt).getTime() - m.h.clock.now().getTime()).toBe(15 * 60_000)
    expect(await offerTexts(m)).toEqual(['+13055550108'].map(() => expect.any(String)))
    const sms = await m.h.t.db
      .selectFrom('messages')
      .select('body')
      .where('purpose', '=', 'waitlist_offer')
      .executeTakeFirstOrThrow()
    expect(sms.body).toContain('Hi Liam, a spot just opened at Oasis Auto Spa')
    expect(sms.body).toContain('holding it for you for 15 minutes')
  })

  it('the VIP accepts inside the window: booked, the slot is full again, nobody else is ever offered it, a second accept is refused', async () => {
    await setFeature(m, true)
    const { a } = await fullSlot(m)
    const liam = (await join(m, 'Liam Chen')).json() as EntryReply
    const priya = (await join(m, 'Priya Nair')).json() as EntryReply
    await cancel(m, a.appointmentId)
    const accepted = await m.send(m.superS(), 'POST', `/waitlist/${liam.id}/accept`, {}, idemKey())
    expect(accepted.statusCode, accepted.body).toBe(201)
    const b = accepted.json() as {
      entry: EntryReply
      booking: { appointment: { id: string; status: string } }
    }
    expect(b.entry).toMatchObject({ status: 'booked', openOffer: null })
    expect(b.entry.appointmentId).toBe(b.booking.appointment.id)
    expect(b.booking.appointment.status).toBe('booked')
    const again = await m.send(m.superS(), 'POST', `/waitlist/${liam.id}/accept`, {}, idemKey())
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'WAITLIST_NO_OFFER' })
    m.h.clock.advance(20 * 60_000)
    const r = await jobs.tx((tx, c) => expireOffers(tx, c))
    expect(r.reOffered).toBe(0)
    expect((await entries(m)).find((e) => e.id === priya.id)).toMatchObject({
      status: 'waiting',
      openOffer: null,
    })
  })

  it('if the VIPs let it lapse, everyone left is offered the slot for the same time; the first accept wins', async () => {
    await setFeature(m, true)
    const { a } = await fullSlot(m)
    const liam = (await join(m, 'Liam Chen')).json() as EntryReply
    const priya = (await join(m, 'Priya Nair')).json() as EntryReply
    await cancel(m, a.appointmentId)
    m.h.clock.advance(16 * 60_000)
    const r = await jobs.tx((tx, c) => expireOffers(tx, c))
    expect(r).toMatchObject({ expiredOffers: 1, reOffered: 1 })
    const list = new Map((await entries(m)).map((e) => [e.id, e]))
    expect(list.get(liam.id)).toMatchObject({ status: 'waiting', openOffer: null })
    expect(list.get(priya.id)).toMatchObject({ status: 'offered', openOffer: { phase: 'everyone' } })
    // Liam's text went out through the API's queue, Priya's through the job's (an in-memory queue in this test)
    expect((await offerTexts(m)).length).toBe(1)
    expect(jobs.queue.messages.map((x) => x.purpose)).toEqual(['waitlist_offer'])
    // an expired offer cannot be accepted any more, the live one can
    const late = await jobs
      .tx((tx, c) => acceptOffer(tx, c, systemActor(m.locationId()), liam.id))
      .catch((e: unknown) => e)
    expect((late as { code: string }).code).toBe('WAITLIST_NO_OFFER')
    const won = await jobs.tx((tx, c) => acceptOffer(tx, c, systemActor(m.locationId()), priya.id))
    expect(won.entry).toMatchObject({ status: 'booked' })
  })

  it('with the VIP priority toggle off everyone is offered at once; the first accept withdraws the other offers', async () => {
    await setFeature(m, true)
    await setVip(m, { waitlist: false })
    const { a } = await fullSlot(m)
    const liam = (await join(m, 'Liam Chen')).json() as EntryReply
    const priya = (await join(m, 'Priya Nair')).json() as EntryReply
    await cancel(m, a.appointmentId)
    const list = await entries(m)
    expect(list.map((e) => [e.status, e.openOffer?.phase])).toEqual([
      ['offered', 'everyone'],
      ['offered', 'everyone'],
    ])
    const won = await m.send(m.superS(), 'POST', `/waitlist/${priya.id}/accept`, {}, idemKey())
    expect(won.statusCode, won.body).toBe(201)
    const after = new Map((await entries(m)).map((e) => [e.id, e]))
    expect(after.get(priya.id)).toMatchObject({ status: 'booked' })
    expect(after.get(liam.id)).toMatchObject({ status: 'waiting', openOffer: null })
    expect(
      (await m.send(m.superS(), 'POST', `/waitlist/${liam.id}/accept`, {}, idemKey())).json(),
    ).toMatchObject({ code: 'WAITLIST_NO_OFFER' })
  })

  it('does not offer a slot to the client who canceled it, outside the window, on another date, or too short for the package', async () => {
    await setFeature(m, true)
    const { a } = await fullSlot(m)
    await join(m, 'Maria Delgado') // the canceler
    await join(m, 'Liam Chen', { windowStart: '12:00', windowEnd: '14:00' })
    await join(m, 'Aisha Rahman', { desiredDate: '2026-06-16' })
    const long = await m.h.t.db
      .selectFrom('services')
      .select(['id', 'name', 'duration_min'])
      .where('kind', '=', 'package')
      .orderBy('duration_min', 'desc')
      .executeTakeFirstOrThrow()
    const slot = (
      await m.h.t.db
        .selectFrom('appointments')
        .select('duration_min')
        .where('id', '=', a.appointmentId)
        .executeTakeFirstOrThrow()
    ).duration_min
    expect(long.duration_min).toBeGreaterThan(slot)
    await join(m, 'Elena Volkov', { serviceId: long.id })
    await cancel(m, a.appointmentId)
    expect((await entries(m)).map((e) => e.status)).toEqual(['waiting', 'waiting', 'waiting', 'waiting'])
    expect(await offerTexts(m)).toEqual([])
  })

  it('a slot that was taken before the accept is refused, and the offer lapses back to waiting', async () => {
    await setFeature(m, true)
    const { a } = await fullSlot(m)
    const liam = (await join(m, 'Liam Chen')).json() as EntryReply
    await cancel(m, a.appointmentId)
    await m.book('Aisha Rahman', 'Express Hand Wash', SLOT) // someone else takes it
    const res = await m.send(m.superS(), 'POST', `/waitlist/${liam.id}/accept`, {}, idemKey())
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'SLOT_UNAVAILABLE' })
    expect((await entries(m))[0]).toMatchObject({ status: 'offered' })
    m.h.clock.advance(16 * 60_000)
    await jobs.tx((tx, c) => expireOffers(tx, c))
    expect((await entries(m))[0]).toMatchObject({ status: 'waiting' })
  })

  it('an entry whose date has passed expires; with the feature off nothing is offered or expired', async () => {
    await setFeature(m, true)
    const e = (
      await join(m, 'Liam Chen', { desiredDate: '2026-06-13', windowStart: '14:00', windowEnd: '16:00' })
    ).json() as EntryReply
    m.h.clock.set('2026-06-14T08:00:00-04:00')
    await jobs.tx((tx) =>
      tx
        .updateTable('settings')
        .set({ value: JSON.stringify(false) })
        .where('key', '=', 'features.standing_waitlist')
        .execute(),
    )
    expect(await jobs.tx((tx, c) => expireOffers(tx, c))).toEqual({
      expiredOffers: 0,
      reOffered: 0,
      expiredEntries: 0,
    })
    await jobs.tx((tx) =>
      tx
        .updateTable('settings')
        .set({ value: JSON.stringify(true) })
        .where('key', '=', 'features.standing_waitlist')
        .execute(),
    )
    expect(await jobs.tx((tx, c) => expireOffers(tx, c))).toMatchObject({ expiredEntries: 1 })
    m.h.clock.set('2026-06-13T10:36:00-04:00')
    expect((await entries(m)).find((x) => x.id === e.id)).toMatchObject({ status: 'expired' })
  })

  it('with the feature turned off after joining, a cancellation offers nothing', async () => {
    await setFeature(m, true)
    const { a } = await fullSlot(m)
    await join(m, 'Liam Chen')
    await setFeature(m, false)
    await cancel(m, a.appointmentId)
    expect(await offerTexts(m)).toEqual([])
    expect(
      (await m.h.t.db.selectFrom('waitlist_entries').select('status').execute()).map((r) => r.status),
    ).toEqual(['waiting'])
  })
})
