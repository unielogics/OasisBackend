// POST /public/bookings (ADR 0150): a real appointment from the website, through the same createAppointment() the dashboard's
// booking sheet uses, with the online channel's rules (lead time, booking window, paused days; no overrides: there is nobody to
// grant one). The customer is created or linked by E.164 phone with the SMS consent recorded (source online); an existing
// customer's name and email are never replaced unless the person verified that number (a member token). Guests owe the shop's
// booking fee at the counter or by a payment link staff text afterwards (settings booking.guest_fee); an active member owes
// nothing. The confirmation text is the design's, queued in the booking's transaction; the usual reminders follow from the
// reminder job. Slot failures answer with the design's wording, never the dashboard's override hints.
import { AppError } from '../../platform/errors.js'
import { getSetting } from '../../platform/settings.js'
import { addDays, fmtT, toBizDate, wallToInstant } from '../../platform/time.js'
import type { Tx } from '../../platform/db.js'
import { DateTime } from 'luxon'
import { findCustomerByPhone, updateCustomer } from '../customers/service.js'
import { logActivity } from '../scheduling/appointments.js'
import { createAppointment } from '../scheduling/booking.js'
import { engineInput, evaluateStart, loadDayData } from '../scheduling/availability-loader.js'
import { loadBoardServices } from './availability-loader.js'
import { schedulingCtx, websiteActor, type PublicDeps, type PublicLocation, type PublicRequest } from './deps.js'
import { enforceLimits, publicLimitChecks } from './limits.js'
import { activeMembership } from './members.js'
import { phoneOrThrow, resolveMemberToken } from './otp.js'
import './problems.js'

export interface WebVehicle {
  year?: number
  make?: string
  model?: string
  /** Free text such as "2021 Tesla Model 3" (the join flow's "car" field); parsed when make and model are absent. */
  label?: string
  plate?: string
}

export interface WebBookingInput {
  name: string
  phone: string
  email?: string
  vehicle?: WebVehicle
  serviceKey: string
  addonKeys: string[]
  date: string
  startMin: number
  smsConsent: boolean
  memberToken?: string
}

export interface WebBookingResult {
  bookingRef: string
  status: 'booked'
  start: string
  end: string
  /** Bays still free for that time after this booking. */
  bayCount: number
  deposit: { dueCents: number; how: 'counter' | 'link' }
  confirmationBy: 'sms' | 'none'
  service: { key: string; name: string }
  addons: { key: string; name: string }[]
  /** "Today · 1:00 PM" */
  when: string
  member: boolean
}

const bad = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path: `body.${path}`, message }] })

/** "2021 Tesla Model 3" -> year 2021, make Tesla, model "Model 3"; "Tesla" -> make Tesla. */
export function parseVehicleLabel(label: string): { year: number | null; make: string | null; model: string | null } {
  const words = label.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { year: null, make: null, model: null }
  let year: number | null = null
  if (/^(19|20)\d{2}$/.test(words[0]!)) year = Number(words.shift())
  const make = words.shift() ?? null
  const model = words.length ? words.join(' ') : null
  return { year, make, model }
}

export function vehicleOf(v: WebVehicle | undefined): { year: number | null; make: string | null; model: string | null; plate: string | null } | null {
  if (!v) return null
  const parsed = v.label && !v.make && !v.model ? parseVehicleLabel(v.label) : { year: null, make: null, model: null }
  const out = {
    year: v.year ?? parsed.year,
    make: v.make ?? parsed.make,
    model: v.model ?? parsed.model,
    plate: v.plate ?? null,
  }
  return out.year === null && !out.make && !out.model && !out.plate ? null : out
}

/** "today", "tomorrow", "Sat, Jun 20": the {when} of the confirmation text. */
export function whenWord(date: string, today: string): string {
  if (date === today) return 'today'
  if (date === addDays(today, 1)) return 'tomorrow'
  return DateTime.fromISO(date, { zone: 'utc' }).setLocale('en-US').toFormat('ccc, LLL d')
}

export const dollars = (cents: number): string =>
  cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`

export const bookingRefOf = (seq: number): string => `OAS-${String(seq).padStart(5, '0')}`

/** The dashboard's guard failures in the website's words. */
export function publicSlotError(e: AppError, startMin: number): AppError {
  switch (e.code) {
    case 'SLOT_UNAVAILABLE':
    case 'NO_BAY_FREE':
    case 'BAY_BUSY':
    case 'CONCURRENT_UPDATE':
      return new AppError('PUBLIC_SLOT_TAKEN', { cause: e })
    case 'SLOT_VIP_HELD':
      return new AppError('PUBLIC_SLOT_VIP', { params: { time: fmtT(startMin) }, cause: e })
    case 'SLOT_PAST':
      return new AppError('PUBLIC_SLOT_PAST', { cause: e })
    case 'SLOT_CLOSED':
    case 'SLOT_OUTSIDE_HOURS':
      return new AppError('PUBLIC_SLOT_CLOSED', { cause: e })
    case 'SLOT_OUTSIDE_WINDOW':
      return new AppError('PUBLIC_SLOT_TOO_FAR', { params: { days: /(\d+) days/.exec(e.detail)?.[1] ?? '14' }, cause: e })
    default:
      return e
  }
}

/** Charges the per-phone and per-address limits on the app's pool (outside the booking transaction, so a refused booking still counts). */
export async function chargeBookingLimits(d: PublicDeps, r: PublicRequest, phone: string): Promise<void> {
  await enforceLimits(d.app.db, d.app.clock, publicLimitChecks('booking', r.ip, phone))
}

export async function createWebBooking(
  tx: Tx,
  d: PublicDeps,
  loc: PublicLocation,
  r: PublicRequest,
  input: WebBookingInput,
): Promise<WebBookingResult> {
  const phone = phoneOrThrow(input.phone)
  const now = d.app.clock.now()
  const services = await loadBoardServices(tx, loc.id)
  const pkg = services.packages.find((p) => p.key === input.serviceKey)
  if (!pkg) throw bad('serviceKey', 'Pick a wash from the catalog.')
  const addons = []
  for (const key of [...new Set(input.addonKeys)]) {
    const a = services.addons.find((x) => x.key === key)
    if (!a) throw bad('addonKeys', 'Pick add-ons from the catalog.')
    addons.push(a)
  }
  const verified = input.memberToken ? await resolveMemberToken(tx, loc, input.memberToken, now) : null
  if (verified && verified.phoneE164 !== phone) throw new AppError('PUBLIC_TOKEN_PHONE_MISMATCH')

  const start = wallToInstant(input.date, input.startMin, loc.tz)
  const existing = await findCustomerByPhone(tx, phone)
  // The record of a customer the shop already has changes only when the caller proved the number (a member token issued for this
  // customer) or by staff. Anyone else's booking is linked to that customer and leaves the record alone: no name, email, consent
  // or vehicle from a form that proves nothing about who typed the number (review 2026-10-10).
  const proven = verified !== null && existing !== undefined && verified.customerId === existing.id
  const linkOnly = existing !== undefined && !proven
  const member = existing ? (await activeMembership(tx, existing.id)) !== undefined : false
  const fee = await getSetting(tx, loc.id, 'booking.guest_fee')
  const dueCents = member ? 0 : fee.value.cents
  const how = fee.value.collect
  const today = toBizDate(now, loc.tz)
  const when = whenWord(input.date, today)
  const time = fmtT(input.startMin)

  // a verified member may correct their own name and email; a guest never overwrites what the shop has on file
  if (verified && existing && existing.id === verified.customerId) {
    const name = input.name.trim()
    const email = input.email?.trim() || null
    const patch: { fullName?: string; email?: string | null } = {}
    if (name && name !== existing.fullName) patch.fullName = name
    if (email && email.toLowerCase() !== (existing.email ?? '').toLowerCase()) patch.email = email
    if (Object.keys(patch).length) await updateCustomer(tx, { id: existing.id, patch })
  }

  const c = schedulingCtx(d, loc)
  const actor = websiteActor(loc, r)
  let booked
  try {
    booked = await createAppointment(tx, c, actor, {
      customer: linkOnly ? { id: existing.id } : { name: input.name, phone, email: input.email ?? null, smsOptIn: input.smsConsent },
      vehicle: linkOnly ? null : vehicleOf(input.vehicle),
      serviceId: pkg.id,
      addonIds: addons.map((a) => a.id),
      start,
      source: 'online',
      channel: 'online',
      message: {
        templateKey: 'booking_confirmed_web',
        vars: {
          service: pkg.name,
          when,
          time,
          ...(member ? { member: 'yes' } : dueCents > 0 ? { fee: dollars(dueCents), how: how === 'link' ? 'by payment link' : 'at the shop' } : {}),
        },
      },
    })
  } catch (e) {
    if (e instanceof AppError) throw publicSlotError(e, input.startMin)
    throw e
  }
  const appointmentId = booked.appointment.id
  if (linkOnly)
    await logActivity(tx, c, { appointmentId, text: unverifiedDetails(input), channels: ['internal'], actor })
  await logActivity(tx, c, {
    appointmentId,
    text: member
      ? 'Booked on the website · member, no booking fee'
      : dueCents > 0
        ? `Booked on the website · ${dollars(dueCents)} booking fee due ${how === 'link' ? 'by payment link' : 'at the counter'}`
        : 'Booked on the website',
    channels: ['system'],
    actor,
  })
  return {
    bookingRef: bookingRefOf(booked.appointment.seq),
    status: 'booked',
    start: booked.appointment.scheduledStart,
    end: booked.appointment.scheduledEnd,
    bayCount: await baysLeft(tx, d, loc, pkg.durationMin, start),
    deposit: { dueCents, how },
    confirmationBy: booked.messageQueued ? 'sms' : 'none',
    service: { key: pkg.key, name: pkg.name },
    addons: addons.map((a) => ({ key: a.key, name: a.name })),
    when: `${when === 'today' ? 'Today' : when === 'tomorrow' ? 'Tomorrow' : when} · ${time}`,
    member,
  }
}

/** What an unverified caller typed for a customer the shop already has, for staff to confirm (nothing of it reaches the record). */
function unverifiedDetails(input: WebBookingInput): string {
  const v = vehicleOf(input.vehicle)
  const car = v ? [v.year, v.make, v.model].filter((x) => x !== null && x !== '').join(' ') + (v.plate ? ` (${v.plate})` : '') : null
  const parts = [
    `name "${input.name.trim()}"`,
    input.email?.trim() ? `email "${input.email.trim()}"` : null,
    car ? `vehicle "${car.trim()}"` : null,
    `texts ${input.smsConsent ? 'yes' : 'no'}`,
  ].filter(Boolean)
  return `Booked on the website with the number of this customer, not verified by a code, so their record was left as it is. Typed: ${parts.join(', ')}. Confirm with the customer before changing anything.`
}

/** Bays still free for the slot once this booking is in (the engine's count, this booking included in the intervals). */
async function baysLeft(tx: Tx, d: PublicDeps, loc: PublicLocation, durationMin: number, start: Date): Promise<number> {
  const data = await loadDayData(tx, { locationId: loc.id, tz: loc.tz, now: d.app.clock.now(), date: toBizDate(start, loc.tz) })
  const ev = evaluateStart(engineInput(data, { durationMin, channel: 'online', isVip: false }), start)
  return ev.baysFree
}
