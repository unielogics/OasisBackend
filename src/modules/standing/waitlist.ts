// The waitlist (ADR 0086): a client who could not get a slot joins for a date and a time window; when a booked job is canceled the
// freed slot is offered to the entries it fits. With the VIP "Waitlist priority" toggle on, VIP entries get the first claim for
// the configured number of minutes, then everyone left is offered the slot for the same time; without it everyone is offered at once.
// The first accepted offer wins (accepting re-checks capacity and withdraws the other offers). No UI: staff accept for the client.
import { sql } from 'kysely'
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { isUuid } from '../../platform/ids.js'
import { minutesOfDay, toBizDate } from '../../platform/time.js'
import { requireService } from '../catalog/service.js'
import { isVipCustomer, requireCustomer } from '../customers/service.js'
import { whenLabel, type AppointmentRecord } from '../scheduling/appointments.js'
import { createAppointment, type BookingResult } from '../scheduling/booking.js'
import type { Actor, SchedulingCtx } from '../scheduling/context.js'
import { loadSettingsBundle } from '../scheduling/context.js'
import { checkSlot } from '../scheduling/slots.js'
import type { WaitlistPort } from '../scheduling/ports.js'
import './problems.js'
import type { EntryStatus, OfferPhase } from './schema.js'
import { attempt, featureEnabled, requireFeature, systemActor } from './support.js'

export interface EntryRecord {
  id: string
  customerId: string
  vehicleId: string | null
  serviceId: string
  desiredDate: string
  windowStartMin: number
  windowEndMin: number
  isVip: boolean
  status: EntryStatus
  appointmentId: string | null
  notes: string | null
  version: number
  /** The offer waiting for an answer, when status is offered. */
  openOffer: { slotStart: string; slotEnd: string; phase: OfferPhase; expiresAt: string } | null
}

const bad = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

async function entryOf(tx: Tx, locationId: string, id: string, lock = false): Promise<EntryRecord> {
  let q = tx
    .selectFrom('waitlist_entries')
    .selectAll()
    .where('id', '=', id)
    .where('location_id', '=', locationId)
  if (lock) q = q.forUpdate()
  const r = await q.executeTakeFirst()
  if (!r) throw new AppError('WAITLIST_NOT_FOUND')
  const offer = await tx
    .selectFrom('waitlist_offers')
    .select(['slot_start', 'slot_end', 'phase', 'expires_at'])
    .where('entry_id', '=', id)
    .where('status', '=', 'open')
    .executeTakeFirst()
  return {
    id: r.id,
    customerId: r.customer_id,
    vehicleId: r.vehicle_id,
    serviceId: r.service_id,
    desiredDate: r.desired_date,
    windowStartMin: r.window_start_min,
    windowEndMin: r.window_end_min,
    isVip: r.is_vip,
    status: r.status,
    appointmentId: r.appointment_id,
    notes: r.notes,
    version: r.version,
    openOffer: offer
      ? {
          slotStart: offer.slot_start.toISOString(),
          slotEnd: offer.slot_end.toISOString(),
          phase: offer.phase,
          expiresAt: offer.expires_at.toISOString(),
        }
      : null,
  }
}

export interface JoinInput {
  customerId: string
  vehicleId?: string | null
  serviceId: string
  desiredDate: string
  windowStartMin: number
  windowEndMin: number
  notes?: string | null
}

export async function joinWaitlist(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  input: JoinInput,
): Promise<EntryRecord> {
  await requireFeature(tx, c.locationId)
  const customer = await requireCustomer(tx, input.customerId)
  if (customer.deletedAt || customer.mergedInto)
    throw new AppError('NOT_FOUND', { detail: 'That customer does not exist' })
  const svc = await requireService(tx, c.locationId, input.serviceId)
  if (svc.kind !== 'package' || !svc.active) throw bad('serviceId', 'Pick an available package.')
  if (input.desiredDate < toBizDate(c.clock.now(), c.tz))
    throw bad('desiredDate', 'Pick a date from today on.')
  if (
    !Number.isInteger(input.windowStartMin) ||
    !Number.isInteger(input.windowEndMin) ||
    input.windowStartMin < 0 ||
    input.windowEndMin > 1440 ||
    input.windowStartMin >= input.windowEndMin
  )
    throw bad('windowEndMin', 'The window must end after it starts.')
  const id = c.newId()
  await tx
    .insertInto('waitlist_entries')
    .values({
      id,
      location_id: c.locationId,
      customer_id: customer.id,
      vehicle_id: input.vehicleId ?? null,
      service_id: svc.id,
      desired_date: input.desiredDate,
      window_start_min: input.windowStartMin,
      window_end_min: input.windowEndMin,
      is_vip: await isVipCustomer(tx, c.locationId, customer.id),
      notes: input.notes?.trim() || null,
      created_by: isUuid(actor.auth.userId) ? actor.auth.userId : null,
    })
    .execute()
  return entryOf(tx, c.locationId, id)
}

export async function listWaitlist(
  tx: Tx,
  locationId: string,
  o: { status?: EntryStatus; date?: string } = {},
): Promise<EntryRecord[]> {
  let q = tx.selectFrom('waitlist_entries').select('id').where('location_id', '=', locationId)
  if (o.status) q = q.where('status', '=', o.status)
  if (o.date) q = q.where('desired_date', '=', o.date)
  const ids = await q.orderBy('desired_date').orderBy('created_at').orderBy('id').execute()
  return Promise.all(ids.map((r) => entryOf(tx, locationId, r.id)))
}

export async function cancelEntry(tx: Tx, c: SchedulingCtx, id: string): Promise<EntryRecord> {
  await requireFeature(tx, c.locationId)
  const e = await entryOf(tx, c.locationId, id, true)
  if (e.status !== 'waiting' && e.status !== 'offered') throw new AppError('WAITLIST_NOT_WAITING')
  const now = c.clock.now()
  await tx
    .updateTable('waitlist_offers')
    .set({ status: 'canceled', resolved_at: now })
    .where('entry_id', '=', id)
    .where('status', '=', 'open')
    .execute()
  await tx
    .updateTable('waitlist_entries')
    .set((eb) => ({ status: 'canceled', updated_at: eb.fn('app_now', []), version: eb('version', '+', 1) }))
    .where('id', '=', id)
    .execute()
  return entryOf(tx, c.locationId, id)
}

// Offers ------------------------------------------------------------------------------------------------------------

interface Slot {
  start: Date
  end: Date
  /** The client whose cancellation freed it; never offered their own slot. */
  excludeCustomerId?: string
}

async function offerSlot(tx: Tx, c: SchedulingCtx, slot: Slot, phase: OfferPhase): Promise<number> {
  const { vip } = await loadSettingsBundle(tx, c.locationId)
  const now = c.clock.now()
  const date = toBizDate(slot.start, c.tz)
  const startMin = minutesOfDay(slot.start, c.tz)
  const slotMin = Math.round((slot.end.getTime() - slot.start.getTime()) / 60_000)
  const rows = await sql<{ id: string; customer_id: string; service_id: string; duration_min: number }>`
    select e.id, e.customer_id, e.service_id, s.duration_min
    from waitlist_entries e join services s on s.id = e.service_id
    where e.location_id = ${c.locationId} and e.status = 'waiting' and e.desired_date = ${date}
      and e.window_start_min <= ${startMin} and e.window_end_min >= ${startMin}
      and s.duration_min <= ${slotMin}
      and (${phase} = 'everyone' or e.is_vip)
      and ${slot.excludeCustomerId ?? null}::uuid is distinct from e.customer_id
      and not exists (select 1 from waitlist_offers o where o.entry_id = e.id and o.slot_start = ${slot.start})
    order by e.is_vip desc, e.created_at, e.id`.execute(tx)
  const expires = new Date(now.getTime() + vip.offerMinutes * 60_000)
  const actor = systemActor(c.locationId)
  let offered = 0
  for (const e of rows.rows) {
    const fits = await attempt(tx, () =>
      checkSlot(tx, c, actor, { start: slot.start, durationMin: e.duration_min, customerId: e.customer_id }),
    )
    if (!fits.ok) continue
    const customer = await requireCustomer(tx, e.customer_id)
    const first = customer.fullName.trim().split(/\s+/)[0]
    const sent = await c.ports.messages.enqueue(tx, {
      customerId: e.customer_id,
      appointmentId: null,
      text: `Hi ${first}, a spot just opened at Oasis Auto Spa ${whenLabel(slot.start, now, c.tz)}. We are holding it for you for ${vip.offerMinutes} minutes. Call or reply here to claim it.`,
      purpose: 'waitlist_offer',
      dedupeKey: `waitlist:${e.id}:${slot.start.toISOString()}`,
    })
    await tx
      .insertInto('waitlist_offers')
      .values({
        id: c.newId(),
        location_id: c.locationId,
        entry_id: e.id,
        slot_start: slot.start,
        slot_end: slot.end,
        phase,
        expires_at: expires,
        resolved_at: null,
        message_id: sent.messageId && isUuid(sent.messageId) ? sent.messageId : null,
      })
      .execute()
    await tx
      .updateTable('waitlist_entries')
      .set((eb) => ({ status: 'offered', updated_at: eb.fn('app_now', []), version: eb('version', '+', 1) }))
      .where('id', '=', e.id)
      .execute()
    offered++
  }
  return offered
}

/** A canceled job freed its slot: offer it (VIPs first when the priority toggle is on). Never throws a business error. */
export async function slotFreed(tx: Tx, c: SchedulingCtx, appt: AppointmentRecord): Promise<void> {
  if (!(await featureEnabled(tx, c.locationId))) return
  if (appt.scheduledStart.getTime() <= c.clock.now().getTime()) return
  const { vip } = await loadSettingsBundle(tx, c.locationId)
  await attempt(tx, async () => {
    const slot: Slot = {
      start: appt.scheduledStart,
      end: appt.scheduledEnd,
      excludeCustomerId: appt.customerId,
    }
    const vipOffers = vip.waitlist ? await offerSlot(tx, c, slot, 'vip') : 0
    if (vipOffers === 0) await offerSlot(tx, c, slot, 'everyone')
  })
}

export const dbWaitlistPort: WaitlistPort = { slotFreed }

export interface ExpiryReport {
  expiredOffers: number
  reOffered: number
  expiredEntries: number
}

/** The job: lapse offers whose time is up (the entry waits again), start the "everyone" phase of a VIP-only slot, expire past-dated entries. */
export async function expireOffers(tx: Tx, c: SchedulingCtx): Promise<ExpiryReport> {
  const out: ExpiryReport = { expiredOffers: 0, reOffered: 0, expiredEntries: 0 }
  if (!(await featureEnabled(tx, c.locationId))) return out
  const now = c.clock.now()
  const lapsed = await tx
    .selectFrom('waitlist_offers')
    .select(['id', 'entry_id', 'slot_start', 'slot_end', 'phase'])
    .where('location_id', '=', c.locationId)
    .where('status', '=', 'open')
    .where('expires_at', '<=', now)
    .orderBy('slot_start')
    .orderBy('id')
    .forUpdate()
    .execute()
  const vipSlots = new Map<number, { start: Date; end: Date }>()
  for (const o of lapsed) {
    await tx
      .updateTable('waitlist_offers')
      .set({ status: 'expired', resolved_at: now })
      .where('id', '=', o.id)
      .execute()
    const stillOpen = await tx
      .selectFrom('waitlist_offers')
      .select('id')
      .where('entry_id', '=', o.entry_id)
      .where('status', '=', 'open')
      .executeTakeFirst()
    if (!stillOpen)
      await tx
        .updateTable('waitlist_entries')
        .set((eb) => ({
          status: 'waiting',
          updated_at: eb.fn('app_now', []),
          version: eb('version', '+', 1),
        }))
        .where('id', '=', o.entry_id)
        .where('status', '=', 'offered')
        .execute()
    out.expiredOffers++
    if (o.phase === 'vip') vipSlots.set(o.slot_start.getTime(), { start: o.slot_start, end: o.slot_end })
  }
  for (const slot of vipSlots.values()) {
    if (slot.start.getTime() <= now.getTime()) continue
    const open = await tx
      .selectFrom('waitlist_offers')
      .select('id')
      .where('location_id', '=', c.locationId)
      .where('slot_start', '=', slot.start)
      .where('status', 'in', ['open', 'accepted'])
      .executeTakeFirst()
    if (open) continue
    const r = await attempt(tx, () => offerSlot(tx, c, slot, 'everyone'))
    if (r.ok) out.reOffered += r.value
  }
  const today = toBizDate(now, c.tz)
  const old = await tx
    .updateTable('waitlist_entries')
    .set((eb) => ({ status: 'expired', updated_at: eb.fn('app_now', []), version: eb('version', '+', 1) }))
    .where('location_id', '=', c.locationId)
    .where('status', 'in', ['waiting', 'offered'])
    .where('desired_date', '<', today)
    .returning('id')
    .execute()
  out.expiredEntries = old.length
  return out
}

export interface AcceptResult {
  entry: EntryRecord
  booking: BookingResult
}

/** Books the offered slot for the entry. The first accept wins: capacity is checked again and the other offers on the slot are withdrawn. */
export async function acceptOffer(tx: Tx, c: SchedulingCtx, actor: Actor, id: string): Promise<AcceptResult> {
  await requireFeature(tx, c.locationId)
  const e = await entryOf(tx, c.locationId, id, true)
  if (e.status !== 'offered' || !e.openOffer) throw new AppError('WAITLIST_NO_OFFER')
  const now = c.clock.now()
  if (new Date(e.openOffer.expiresAt).getTime() <= now.getTime()) throw new AppError('WAITLIST_NO_OFFER')
  const slotStart = new Date(e.openOffer.slotStart)
  const booking = await createAppointment(tx, c, actor, {
    customer: { id: e.customerId },
    serviceId: e.serviceId,
    start: slotStart,
    source: 'phone',
    notes: e.notes,
  })
  if (e.vehicleId)
    await tx
      .updateTable('appointments')
      .set({ vehicle_id: e.vehicleId })
      .where('id', '=', booking.appointment.id)
      .execute()
  await tx
    .updateTable('waitlist_offers')
    .set({ status: 'accepted', resolved_at: now })
    .where('entry_id', '=', id)
    .where('slot_start', '=', slotStart)
    .where('status', '=', 'open')
    .execute()
  const others = await tx
    .updateTable('waitlist_offers')
    .set({ status: 'canceled', resolved_at: now })
    .where('location_id', '=', c.locationId)
    .where('slot_start', '=', slotStart)
    .where('status', '=', 'open')
    .returning('entry_id')
    .execute()
  for (const o of others)
    await tx
      .updateTable('waitlist_entries')
      .set((eb) => ({ status: 'waiting', updated_at: eb.fn('app_now', []), version: eb('version', '+', 1) }))
      .where('id', '=', o.entry_id)
      .where('status', '=', 'offered')
      .execute()
  await tx
    .updateTable('waitlist_entries')
    .set((eb) => ({
      status: 'booked',
      appointment_id: booking.appointment.id,
      updated_at: eb.fn('app_now', []),
      version: eb('version', '+', 1),
    }))
    .where('id', '=', id)
    .execute()
  return { entry: await entryOf(tx, c.locationId, id), booking }
}
