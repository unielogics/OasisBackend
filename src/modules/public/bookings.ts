// POST /public/bookings (ADR 0150): a real appointment from the website, through the same createAppointment() the dashboard's
// booking sheet uses, with the online channel's rules (lead time, booking window, paused days; no overrides: there is nobody to
// grant one). The customer is created or linked by E.164 phone with the SMS consent recorded (source online); an existing
// customer's record is never changed unless the person verified that number (a member token), and even then the name on file
// is only filled when it is a placeholder (a different typed name becomes a note on the booking). Guests owe the shop's
// booking fee at the counter or by a payment link staff text afterwards (settings booking.guest_fee); an active member owes
// nothing. The confirmation text is the design's, queued in the booking's transaction; the usual reminders follow from the
// reminder job. Slot failures answer with the design's wording, never the dashboard's override hints.
import { AppError } from '../../platform/errors.js'
import { getSetting } from '../../platform/settings.js'
import { addDays, fmtT, toBizDate, wallToInstant } from '../../platform/time.js'
import type { Tx } from '../../platform/db.js'
import { DateTime } from 'luxon'
import { findCustomerByPhone, isVipCustomer, updateCustomer } from '../customers/service.js'
import { hasPin } from '../identity/common.js'
import { reassignNumber } from '../identity/rebind.js'
import { staleRecord } from '../identity/stale.js'
import { loadPlans } from '../memberships/plans.js'
import { listVehicleClasses, requireVehicleClass } from '../catalog/vehicle-classes.js'
import { loadPriceBook, quoteVisit } from '../catalog/price-book.js'
import { pricingView, type PricingView } from '../scheduling/visit-pricing.js'
import { logActivity } from '../scheduling/appointments.js'
import { createAppointment } from '../scheduling/booking.js'
import { engineInput, evaluateStart, loadDayData } from '../scheduling/availability-loader.js'
import { loadBoardServices } from './availability-loader.js'
import { schedulingCtx, websiteActor, type PublicDeps, type PublicLocation, type PublicRequest } from './deps.js'
import { enforceLimits, publicLimitChecks } from './limits.js'
import { activeMembership } from './members.js'
import { feeHow, requestDepositLink } from '../square/deposits.js'
import { phoneOrThrow, resolveMemberToken } from './otp.js'
import '../identity/problems.js'
import './problems.js'

export interface WebVehicle {
  year?: number
  make?: string
  model?: string
  /**
   * Free text such as "2021 Tesla Model 3" (the join flow's "car" field); parsed when make and model are absent. A label that is a
   * vehicle size ("Compact SUV", or the old site's "Sedan / Coupe") is the size, never a car (ADR 0170).
   */
  label?: string
  plate?: string
}

/** The old website's size chips (before ADR 0170) and the size each one prices at (the vehicle_type backfill's mapping). */
export const LEGACY_SIZE_LABELS: Readonly<Record<string, string>> = {
  'sedan / coupe': 'compact_car',
  'suv / crossover': 'compact_suv',
  'truck / van': 'truck',
}

const normLabel = (s: string): string => s.trim().toLowerCase().replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ')

/** Whether a free-text label names a vehicle size (one of the shop's, by label or key, or an old size chip) rather than a car. */
export function isSizeLabel(label: string | undefined, sizes: readonly { key: string; label: string }[]): boolean {
  if (!label?.trim()) return false
  const n = normLabel(label)
  return n in LEGACY_SIZE_LABELS || sizes.some((s) => normLabel(s.label) === n || s.key === n.replace(/ /g, '_'))
}

/** The size a size label names (null when it names none, or the size it maps to is not one of `sizes`). */
export function classOfLabel(label: string | undefined, sizes: readonly { key: string; label: string }[]): string | null {
  if (!label?.trim()) return null
  const n = normLabel(label)
  const own = sizes.find((s) => normLabel(s.label) === n || s.key === n.replace(/ /g, '_'))
  if (own) return own.key
  const legacy = LEGACY_SIZE_LABELS[n]
  return legacy && sizes.some((s) => s.key === legacy) ? legacy : null
}

export interface WebBookingInput {
  name: string
  phone: string
  email?: string
  vehicle?: WebVehicle
  /** The size chip (ADR 0170): prices the visit; recorded on the car only for the verified owner of the record or a new client. */
  vehicleClass?: string | null
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
  /** What the visit was priced at (ADR 0170): the size, whether the shop confirms the price, the totals before tax. */
  pricing: WebPricing
}

export interface WebPricing {
  vehicleClass: string | null
  vehicleClassLabel: string | null
  /** The size is not known yet, or has no price of its own: the exact price is confirmed at the shop. */
  confirmAtShop: boolean
  listCents: number
  discountCents: number
  coveredCents: number
  dueCents: number
}

/** The pricing a public booking answer carries (nothing of the record: a guest is priced as a guest). */
export const webPricingOf = (p: PricingView): WebPricing => ({
  vehicleClass: p.vehicleClass,
  vehicleClassLabel: p.vehicleClassLabel,
  confirmAtShop: p.confirmAtShop,
  ...p.totals,
})

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

/** The car a form describes; a label that names a size is not a car (ADR 0170: "Sedan / Coupe" never becomes make "Sedan"). */
export function vehicleOf(
  v: WebVehicle | undefined,
  sizes: readonly { key: string; label: string }[] = [],
): { year: number | null; make: string | null; model: string | null; plate: string | null } | null {
  if (!v) return null
  const label = isSizeLabel(v.label, sizes) ? undefined : v.label
  const parsed = label && !v.make && !v.model ? parseVehicleLabel(label) : { year: null, make: null, model: null }
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

/** The package, add-ons and size a website booking names (422 on what the catalog does not have). */
async function webVisitOf(tx: Tx, loc: PublicLocation, input: Pick<WebBookingInput, 'serviceKey' | 'addonKeys' | 'vehicleClass' | 'vehicle'>) {
  const services = await loadBoardServices(tx, loc.id)
  const pkg = services.packages.find((p) => p.key === input.serviceKey)
  if (!pkg) throw bad('serviceKey', 'Pick a wash from the catalog.')
  const addons = []
  for (const key of [...new Set(input.addonKeys)]) {
    const a = services.addons.find((x) => x.key === key)
    if (!a) throw bad('addonKeys', 'Pick add-ons from the catalog.')
    addons.push(a)
  }
  // the size: the chip, else a size label an old cached page sent as the car (ADR 0170)
  const sizes = await listVehicleClasses(tx, loc.id, { activeOnly: true })
  const vehicleClass = input.vehicleClass
    ? (await requireVehicleClass(tx, loc.id, input.vehicleClass, { active: true, path: 'body.vehicleClass' })).key
    : classOfLabel(input.vehicle?.label, sizes)
  return { pkg, addons, sizes, vehicleClass }
}

/**
 * What a guest's booking of this visit would cost (the honeypot's answer reads like a real one: the same validation, the same
 * price book; nothing is written).
 */
export async function guestPricingOf(
  tx: Tx,
  loc: PublicLocation,
  input: Pick<WebBookingInput, 'serviceKey' | 'addonKeys' | 'vehicleClass' | 'vehicle'>,
): Promise<WebPricing> {
  const { pkg, addons, vehicleClass } = await webVisitOf(tx, loc, input)
  const book = await loadPriceBook(tx, loc.id)
  const quote = quoteVisit(book, { packageId: pkg.id, addonIds: addons.map((a) => a.id), classKey: vehicleClass }, null)
  return webPricingOf(
    pricingView({ book, member: null, classKey: vehicleClass, classLabel: vehicleClass ? (book.labels.get(vehicleClass) ?? null) : null, quote }),
  )
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
  const { pkg, addons, sizes, vehicleClass } = await webVisitOf(tx, loc, input)
  const verified = input.memberToken ? await resolveMemberToken(tx, loc, input.memberToken, now) : null
  if (verified && verified.phoneE164 !== phone) throw new AppError('PUBLIC_TOKEN_PHONE_MISMATCH')

  await assertOnTheGrid(tx, d, loc, input.date, input.startMin)
  const start = wallToInstant(input.date, input.startMin, loc.tz)
  let existing = await findCustomerByPhone(tx, phone)
  let reboundId: string | null = null
  // A PIN outranks a texted code (design section 5): for a number whose client has a PIN, stale or not, a member token (a code only)
  // books nothing, exactly as a link page verified by code refuses (ADR 0160 W4c re-review L1). Without a token the booking is a
  // guest's linked to that client, which changes nothing on the record.
  if (verified && existing && (await hasPin(tx, existing.id))) throw new AppError('IDENTITY_PIN_REQUIRED')
  // A member token proves the NUMBER (a texted code), not the client the shop has on file for it: on a record the stale-record rule
  // holds, the caller becomes a new client and the number moves to them; the old record keeps its history and is flagged for staff
  // (identity/rebind.ts, ADR 0160 W4c fixes). Without a token the booking is only linked to the stale record (below), which changes
  // nothing on it and never ends the rule.
  if (
    verified &&
    existing &&
    verified.customerId === existing.id &&
    (await staleRecord(tx, { locationId: loc.id, customerId: existing.id, phone, now })).stale
  ) {
    const moved = await reassignNumber(tx, d.app, {
      from: existing.id,
      locationId: loc.id,
      phone,
      name: input.name.trim().replace(/\s+/g, ' ') || null,
      email: input.email?.trim() || null,
      smsOptIn: input.smsConsent ? 'online' : null,
      source: 'online',
      audit: websiteActor(loc, r).audit,
    })
    const fresh = await findCustomerByPhone(tx, phone)
    if (!fresh || fresh.id !== moved.customerId) throw new AppError('CONCURRENT_UPDATE')
    existing = fresh
    reboundId = moved.customerId
  }
  // The record of a customer the shop already has changes only when the caller proved the number (a member token issued for this
  // customer) or by staff. Anyone else's booking is linked to that customer and leaves the record alone: no name, email, consent
  // or vehicle from a form that proves nothing about who typed the number (review 2026-10-10).
  const proven = verified !== null && existing !== undefined && (verified.customerId === existing.id || existing.id === reboundId)
  const linkOnly = existing !== undefined && !proven
  // Member and VIP privileges (no fee, VIP-held times, the longer online window) follow the verified owner only: a number typed
  // without its code books as anyone's would, and the answer cannot tell a member's number from a stranger's (review 2026-10-10).
  const privileges = proven && existing ? await privilegesOf(tx, loc.id, existing.id) : { member: false, vip: false }
  const member = privileges.member
  const fee = await getSetting(tx, loc.id, 'booking.guest_fee')
  const dueCents = member ? 0 : fee.value.cents
  const how = fee.value.collect
  const today = toBizDate(now, loc.tz)
  const when = whenWord(input.date, today)
  const time = fmtT(input.startMin)

  // A verified member may correct their own email. The name on file is never replaced by what was typed (a booking form's
  // "Maria" must not overwrite "Maria Lopez", review 2026-10-10): the typed name only fills a placeholder (a walk-in or a texter
  // whose name is still unknown); a different one is kept as a note on the booking for staff. A guest changes nothing.
  let typedNameNote: string | null = null
  if (verified && existing && existing.id === verified.customerId) {
    const name = input.name.trim().replace(/\s+/g, ' ')
    const email = input.email?.trim() || null
    const patch: { fullName?: string; email?: string | null } = {}
    if (name && name !== existing.fullName) {
      if (isPlaceholderName(existing)) patch.fullName = name
      else typedNameNote = `Booked on the website as "${name}"; the name on file ("${existing.fullName}") was kept. Update it in the client file if the client asks.`
    }
    if (email && email.toLowerCase() !== (existing.email ?? '').toLowerCase()) patch.email = email
    if (Object.keys(patch).length) await updateCustomer(tx, { id: existing.id, patch })
  }

  const c = schedulingCtx(d, loc)
  const actor = websiteActor(loc, r)
  let booked
  try {
    booked = await createAppointment(tx, c, actor, {
      customer: linkOnly && existing ? { id: existing.id } : { name: input.name, phone, email: input.email ?? null, smsOptIn: input.smsConsent },
      vehicle: linkOnly ? null : vehicleOf(input.vehicle, sizes),
      // a guest's size prices the visit but never reaches someone else's record; member prices only for the verified owner
      vehicleClass,
      recordClassAs: linkOnly ? null : 'client',
      memberPricing: member,
      confirmPriceVar: 'confirm',
      serviceId: pkg.id,
      addonIds: addons.map((a) => a.id),
      start,
      source: 'online',
      channel: 'online',
      vip: privileges.vip,
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
  // the deposit by Square link (ADR 0171 D2): a request the job square.deposit-link turns into a texted quick-pay link
  await requestDepositLink(tx, { newId: d.app.newId, clock: d.app.clock }, { locationId: loc.id, appointmentId, cents: dueCents, collect: how })
  if (linkOnly)
    await logActivity(tx, c, { appointmentId, text: unverifiedDetails(input, sizes), channels: ['internal'], actor })
  if (typedNameNote) await logActivity(tx, c, { appointmentId, text: typedNameNote, channels: ['internal'], actor })
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
    deposit: { dueCents, how: feeHow(how) },
    // what the policy did is the verified owner's to know; anyone else is told what they asked for (a STOP or a missing opt-in on
    // the record of a known number would otherwise show through)
    confirmationBy: verified ? (booked.messageQueued ? 'sms' : 'none') : input.smsConsent ? 'sms' : 'none',
    service: { key: pkg.key, name: pkg.name },
    addons: addons.map((a) => ({ key: a.key, name: a.name })),
    when: `${when === 'today' ? 'Today' : when === 'tomorrow' ? 'Tomorrow' : when} · ${time}`,
    member,
    pricing: webPricingOf(booked.pricing),
  }
}

/**
 * Online bookings start on the board's grid (opening time plus whole slots): the website only offers those, and a start a few
 * minutes off one slipped past checks that match the grid's starts exactly, a VIP hold among them (review 2026-10-10). A day the
 * shop is closed is left to the slot guard, which answers in the design's words.
 */
async function assertOnTheGrid(tx: Tx, d: PublicDeps, loc: PublicLocation, date: string, startMin: number): Promise<void> {
  const data = await loadDayData(tx, { locationId: loc.id, tz: loc.tz, now: d.app.clock.now(), date })
  const open = data.day.openMin
  if (data.day.closed || open === null) return
  const step = data.settings.rules.slotMinutes
  if ((((startMin - open) % step) + step) % step !== 0) throw bad('startMin', 'Pick one of the times on the board.')
}

/**
 * What a verified customer is entitled to online: no fee with an active membership; the VIP slot rules as a VIP client (the staff's
 * list) or as an active member of the plan the website sells as VIP (tiers.ts).
 */
async function privilegesOf(tx: Tx, locationId: string, customerId: string): Promise<{ member: boolean; vip: boolean }> {
  const m = await activeMembership(tx, customerId)
  const listed = await isVipCustomer(tx, locationId, customerId)
  if (!m) return { member: false, vip: listed }
  const plan = (await loadPlans(tx, locationId)).find((p) => p.id === m.planId)
  return { member: true, vip: listed || plan?.vipBooking === true }
}

/**
 * A name the shop does not really have yet: a record still flagged needs_details, the walk-in placeholder, or the assistant's
 * provisional "New texter ••1234" (ADR 0160). Only such a name is filled from a booking form.
 */
export function isPlaceholderName(c: { fullName: string; needsDetails: boolean }): boolean {
  const n = c.fullName.trim()
  return c.needsDetails || n === '' || n === 'Walk-in guest' || /^New texter\b/i.test(n)
}

/** What an unverified caller typed for a customer the shop already has, for staff to confirm (nothing of it reaches the record). */
function unverifiedDetails(input: WebBookingInput, sizes: readonly { key: string; label: string }[]): string {
  const v = vehicleOf(input.vehicle, sizes)
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
