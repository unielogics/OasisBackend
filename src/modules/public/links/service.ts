// The personal-link API's services (ADR 0160, design section 5 and plan B/E, wave W3c), on the identity core's links, sessions, PIN,
// codes and trust (src/modules/identity/**). The routes (http/routes.ts) resolve the bearer session and call these; everything a
// client sees of their own record goes through `linkState`, which shows a name, appointments or an invoice only as far as the page
// has earned it: the first name and the last two digits of the number to the holder of the link, the appointments once the number is
// verified, nothing personal while the stale-record rule says the record may belong to a previous holder of the number (until the
// client's own PIN proves them: a texted code proves only the number, and a booking it allows makes a new client, W4c fixes).
//
//   bookings            a verified page books through createAppointment (channel online, source link), like the website does for a
//                       verified member: member privileges (no fee, the VIP rules) only for the link's own client, never while a PIN
//                       reset holds them; a completion consumes one use of the link (calendar 3, book-again 1)
//   reschedule          a verified page moves one of its client's own upcoming visits under the online rules
//   membership/start    a fresh PIN or code (5 minutes) on a membership link: a pending membership and a checkout intent (W2e
//                       openCheckoutIntent) with the email the client typed (never a verified email: it is only the intent's
//                       expected email), then the plan's squarespace.com checkout URL
//   pay/start           a fresh PIN or code on a payment link: the invoice's staff-attached payment URL when its host is allowed,
//                       else {status: link_pending} and one notice to the managers to text a payment link. With
//                       PAYMENT_PROCESSOR=square the route goes to square/public.ts instead: a Square link for the exact balance,
//                       made (or reused) at click time
import { DateTime } from 'luxon'
import { sql } from 'kysely'
import type { AppInstance } from '../../../http/types.js'
import * as audit from '../../../platform/audit.js'
import type { AuditContext } from '../../../platform/audit.js'
import type { Executor, Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { getLocation } from '../../../platform/locations.js'
import { maskPhone } from '../../../platform/phone.js'
import { getSetting } from '../../../platform/settings.js'
import { DEFAULT_TZ, fmtT, toBizDate, wallToInstant } from '../../../platform/time.js'
import type { AuthContext } from '../../../http/authorizer.js'
import { checkCheckoutUrl, listPlanPublic } from '../../catalog/plans.js'
import { getCustomer, isVipCustomer, updateCustomer, upsertVehicleByPlate } from '../../customers/service.js'
import { evaluateTrust } from '../../identity/trust.js'
import { pinOwnerOf, pinStateOf } from '../../identity/codes.js'
import { consumeLink } from '../../identity/links.js'
import { memberPrivilegesHeldUntil } from '../../identity/pin-service.js'
import { bindPartyToNumber } from '../../identity/rebind.js'
import { STEP_UP_MAX_AGE_MS, hasFreshStepUp, type SessionView } from '../../identity/sessions.js'
import { staleRecord } from '../../identity/stale.js'
import { PIN_AFTER_CODE_MS } from '../../identity/codes.js'
import type { ClientLinkKind } from '../../identity/schema.js'
import { openCheckoutIntent } from '../../memberships/checkouts.js'
import { loadPlans } from '../../memberships/plans.js'
import { notifyManagers } from '../../messaging/notify.js'
import { logActivity } from '../../scheduling/appointments.js'
import { engineInput, evaluateStart, loadDayData } from '../../scheduling/availability-loader.js'
import { createAppointment } from '../../scheduling/booking.js'
import type { Actor, SchedulingCtx } from '../../scheduling/context.js'
import { rescheduleAppointment } from '../../scheduling/lifecycle.js'
import type { SchedulingPorts } from '../../scheduling/ports.js'
import { checkSlot } from '../../scheduling/slots.js'
import { loadBoardServices } from '../availability-loader.js'
import {
  bookingRefOf,
  classOfLabel,
  dollars,
  isPlaceholderName,
  parseVehicleLabel,
  publicSlotError,
  vehicleOf,
  webPricingOf,
  whenWord,
  type WebPricing,
  type WebVehicle,
} from '../bookings.js'
import { listVehicleClasses, requireVehicleClass } from '../../catalog/vehicle-classes.js'
import { coverageOf, lineClassLabel } from '../../payments/gateway.js'
import { linkHostAllowed } from '../../payments/ports.js'
import { activeMembership } from '../members.js'
import { feeHow, requestDepositLink } from '../../square/deposits.js'
import { CARD_PAGE_KINDS, cardSetupOf, pageCards, type CardSetup, type PageCard } from '../../square/card-page.js'
import { assertNoChargeWaiting } from '../../square/charge-guard.js'
import { squareProcessor } from '../../square/links.js'
import { squareEnv } from '../../square/runtime.js'
import { memberRefOf } from '../memberships.js'
import { tierKeyOf, type PublicTier } from '../tiers.js'
import './problems.js'
import '../problems.js'

const MIN = 60_000

export interface LinkDeps {
  app: AppInstance
  scheduling: SchedulingPorts
  /** Hosts a payment URL may point at (PAYMENT_LINK_HOSTS, default squarespace.com). */
  linkHosts: readonly string[]
}

export interface LinkLocation {
  id: string
  tz: string
}

export async function linkLocation(db: Executor, locationId: string): Promise<LinkLocation> {
  const l = await getLocation(db, locationId)
  return { id: locationId, tz: l?.timezone ?? DEFAULT_TZ }
}

/** Per-request facts: the client address and the request id (never the token). */
export interface LinkRequest {
  ip: string
  requestId: string
  idempotencyKey?: string | null
}

/** The acting party of a link page: no user, no employee, no permission (so no override), named "Personal link" in the logs. */
export function linkActor(locationId: string, r: LinkRequest): Actor {
  const auth: AuthContext = {
    userId: 'personal-link',
    employeeId: null,
    locationId,
    permissions: new Set<string>(),
    actorName: 'Personal link',
    roles: ['personal_link'],
  }
  return { auth, audit: linkAudit(r) }
}

export const linkAudit = (r: LinkRequest): AuditContext => ({
  actor: { name: 'Personal link' },
  requestId: r.requestId,
  idempotencyKey: r.idempotencyKey ?? null,
  ip: r.ip,
})

const schedulingCtx = (d: LinkDeps, loc: LinkLocation): SchedulingCtx => ({
  clock: d.app.clock,
  newId: d.app.newId,
  locationId: loc.id,
  tz: loc.tz,
  ports: d.scheduling,
})

// ---- what the page may show ---------------------------------------------------------------------------------------------------

export interface ClientView {
  /** "" for a stranger's link, a placeholder name, or a record the stale-record rule hides until the client's PIN proves them. */
  firstName: string
  /** The last two digits of the link's number ("BOOKING FOR MARIA ••51"). */
  last2: string
  tier: PublicTier | null
}

export interface InvoiceView {
  number: number
  date: string
  items: { name: string; priceCents: number; listCents: number | null; discountBp: number | null; memberDiscountCents: number; classLabel: string | null }[]
  /** What the membership covered (ADR 0170). */
  coverage: { serviceName: string; coveredCents: number; lineCents: number; differenceCents: number; planClassLabel: string | null }[]
  subtotalCents: number
  taxCents: number
  tipCents: number
  totalCents: number
  paidCents: number
  balanceCents: number
}

export interface PlanView {
  tier: PublicTier | null
  planKey: string
  name: string
  monthlyPriceCents: number | null
  perks: string[]
  /** How the page joins (ADR 0171 wave Q3b): square = card + consent here (membership/subscribe); squarespace = the checkout (membership/start). */
  billing: 'square' | 'squarespace'
  /** The tier's monthly price at each size it is sold at; joinable: the price is set up at Square (always true for squarespace). */
  prices: { class: string; label: string; monthlyCents: number; joinable: boolean }[]
}

export interface AppointmentView {
  ref: string
  start: string
  end: string
  /** "Sat, Jun 20 · 1:00 PM" (shop time) */
  when: string
  service: string
  addons: string[]
  status: string
  canReschedule: boolean
}

export interface LinkState {
  kind: ClientLinkKind
  /** The session's hard end (1 hour after the exchange). */
  expiresAt: Date
  /** The session's idle end (15 minutes after the last request, never past expiresAt). */
  idleExpiresAt: Date
  link: { expiresAt: Date }
  client: ClientView
  trust: { verified: boolean; by: 'pin' | 'code' | null; until: Date | null }
  stepUp: { method: 'pin' | 'code'; freshUntil: Date | null; canSetPinUntil: Date | null }
  /** The client's upcoming visits (verified pages only). */
  appointments: AppointmentView[] | null
  /** A payment link's invoice. */
  invoice: InvoiceView | null
  /** A membership link's plan. */
  plan: PlanView | null
  /** The client's active saved cards (ADR 0171 D7): verified card and membership pages of a proven client only. */
  cards: PageCard[] | null
  /** What a card or membership page needs to take a card (the consent wording, Square's SDK settings); null when cards are off. */
  cardSetup: CardSetup | null
}

/** The state a page is shown: what the session and the number's trust allow, and nothing about the record the rules hide. */
export async function linkState(db: Executor, s: SessionView, now: Date): Promise<LinkState> {
  const loc = await linkLocation(db, s.link.locationId)
  const verified = s.trust === 'verified'
  const customer = s.customerId ? await getCustomer(db, s.customerId) : undefined
  // a record that may be a previous holder's (180 days without activity, an invalid-number bounce) is nobody until the client's own
  // PIN (or staff) proves them: a texted code proves only the number, and its booking makes a new client (W4c fixes)
  const known = customer !== undefined && (await clientProven(db, s, now))
  const held = customer ? await memberPrivilegesHeldUntil(db, customer.id, now) : null
  let tier: PublicTier | null = null
  if (known && customer) {
    const m = await activeMembership(db, customer.id)
    if (m) {
      const plan = (await loadPlans(db, loc.id)).find((p) => p.id === m.planId)
      tier = tierKeyOf(plan)
    }
  }
  const trust = customer ? await evaluateTrust(db, { locationId: loc.id, phone: s.phone, customerId: customer.id, now }) : null
  // a stranger's link whose number a client owns now: that client's PIN is the step-up (W4c review)
  const pin = await pinStateOf(db, await pinOwnerOf(db, s))
  const fresh = hasFreshStepUp(s, now) && s.stepUpAt ? new Date(s.stepUpAt.getTime() + STEP_UP_MAX_AGE_MS) : null
  return {
    kind: s.link.kind,
    expiresAt: s.expiresAt,
    idleExpiresAt: s.idleExpiresAt,
    link: { expiresAt: s.link.expiresAt },
    client: {
      firstName: known && customer && !isPlaceholderName(customer) ? (customer.fullName.trim().split(/\s+/)[0] ?? '') : '',
      last2: s.phone.slice(-2),
      tier: held ? null : tier,
    },
    trust: { verified, by: verified ? s.verifiedBy : null, until: trust?.trusted ? trust.until : null },
    stepUp: {
      method: pin.set ? 'pin' : 'code',
      freshUntil: fresh,
      canSetPinUntil: known && !pin.set ? await pinWindow(db, s, now) : known && pin.set ? await pinWindow(db, s, now, true) : null,
    },
    appointments: verified && known && customer ? await upcomingOf(db, loc, customer.id, s.link.appointmentId, now) : null,
    invoice: s.link.kind === 'pay' && s.link.invoiceId && known ? await invoiceView(db, s.link.invoiceId) : null,
    plan: s.link.kind === 'membership' && s.link.planKey ? await planView(db, loc.id, s.link.planKey) : null,
    cards: verified && known && customer && CARD_PAGE_KINDS.includes(s.link.kind) ? await pageCards(db, loc.id, customer.id) : null,
    cardSetup: cardSetupOf(squareEnv(), s.link.kind),
  }
}

/** Until when the page may choose a PIN: 10 minutes after a code confirmed on it (a reset code once a PIN exists). */
async function pinWindow(db: Executor, s: SessionView, now: Date, reset = false): Promise<Date | null> {
  const r = await db
    .selectFrom('public_otp_challenges')
    .select('consumed_at')
    .where('link_session_hash', '=', s.tokenHash)
    .where('consumed_reason', '=', 'verified')
    .where('purpose', 'in', reset ? ['pin_reset'] : ['link_verify', 'pin_set'])
    .where('consumed_at', '>=', new Date(now.getTime() - PIN_AFTER_CODE_MS))
    .orderBy('consumed_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return r?.consumed_at ? new Date(r.consumed_at.getTime() + PIN_AFTER_CODE_MS) : null
}

const label = (at: Date, tz: string): string => {
  const t = DateTime.fromJSDate(at, { zone: tz })
  return `${t.toFormat('ccc, LLL d')} · ${t.toFormat('h:mm a')}`
}

/** The client's visits from today on that can still happen (booked, confirmed, arrived, in the bay), soonest first, at most 5. */
async function upcomingOf(db: Executor, loc: LinkLocation, customerId: string, onlyId: string | null, now: Date): Promise<AppointmentView[]> {
  const rows = await db
    .selectFrom('appointments')
    .select(['id', 'seq', 'scheduled_start', 'scheduled_end', 'package_name', 'status'])
    .where('location_id', '=', loc.id)
    .where('customer_id', '=', customerId)
    .where('status', 'in', ['booked', 'confirmed', 'arrived', 'cleaning'])
    .where('scheduled_end', '>', new Date(now.getTime() - 60 * MIN))
    .$if(onlyId !== null, (q) => q.where('id', '=', onlyId!))
    .orderBy('scheduled_start')
    .limit(5)
    .execute()
  const ids = rows.map((r) => r.id)
  const addons = ids.length
    ? await db
        .selectFrom('appointment_addons')
        .select(['appointment_id', 'name'])
        .where('appointment_id', 'in', ids)
        .where('removed_at', 'is', null)
        .orderBy('added_at')
        .execute()
    : []
  return rows.map((r) => ({
    ref: bookingRefOf(r.seq),
    start: r.scheduled_start.toISOString(),
    end: r.scheduled_end.toISOString(),
    when: label(r.scheduled_start, loc.tz),
    service: r.package_name,
    addons: addons.filter((a) => a.appointment_id === r.id).map((a) => a.name),
    status: r.status,
    canReschedule: (r.status === 'booked' || r.status === 'confirmed') && r.scheduled_start.getTime() > now.getTime(),
  }))
}

async function invoiceView(db: Executor, invoiceId: string): Promise<InvoiceView | null> {
  const inv = await db.selectFrom('invoices').select(['id', 'invoice_no', 'biz_date', 'vehicle_class_label']).where('id', '=', invoiceId).executeTakeFirst()
  if (!inv) return null
  const items = await db
    .selectFrom('invoice_items')
    .select(['name', 'price_cents', 'list_cents', 'discount_bp', 'price_basis'])
    .where('invoice_id', '=', invoiceId)
    .orderBy('position')
    .execute()
  const coverage = (await coverageOf(db, [invoiceId])).get(invoiceId) ?? []
  const c = await sql<{ sub: string; tax: string; tip: string; total: string; paid: string; balance: string }>`
    select sub, tax, tip, total, paid, balance from invoice_calc_of(${invoiceId}::uuid)`.execute(db)
  const calc = c.rows[0]
  return {
    number: inv.invoice_no,
    date: String(inv.biz_date),
    items: items.map((i) => ({
      name: i.name,
      priceCents: i.price_cents,
      listCents: i.list_cents,
      discountBp: i.discount_bp,
      memberDiscountCents: i.list_cents === null ? 0 : i.list_cents - i.price_cents,
      classLabel: lineClassLabel(i.price_basis, inv.vehicle_class_label),
    })),
    coverage: coverage.map(({ eventId: _e, ...c }) => c),
    subtotalCents: Number(calc?.sub ?? 0),
    taxCents: Number(calc?.tax ?? 0),
    tipCents: Number(calc?.tip ?? 0),
    totalCents: Number(calc?.total ?? 0),
    paidCents: Number(calc?.paid ?? 0),
    balanceCents: Number(calc?.balance ?? 0),
  }
}

async function planView(db: Executor, locationId: string, planKey: string): Promise<PlanView | null> {
  const p = (await listPlanPublic(db, locationId)).find((x) => x.key === planKey)
  if (!p) return null
  const billing = squareProcessor(squareEnv()) ? 'square' : 'squarespace'
  const rows = await db
    .selectFrom('membership_tier_prices as t')
    .innerJoin('membership_plans as pl', 'pl.id', 't.plan_id')
    .innerJoin('vehicle_classes as c', (j) => j.onRef('c.location_id', '=', 't.location_id').onRef('c.key', '=', 't.class_key'))
    .select(['t.class_key', 'c.label', 't.monthly_cents', 't.square_state', 't.square_variation_id'])
    .where('pl.location_id', '=', locationId)
    .where('pl.key', '=', p.key)
    .where('t.superseded_at', 'is', null)
    .where('c.active', '=', true)
    .orderBy('c.sort')
    .orderBy('c.key')
    .execute()
  const prices = rows.map((r) => ({
    class: r.class_key,
    label: r.label,
    monthlyCents: r.monthly_cents,
    joinable: billing === 'squarespace' || (r.square_state === 'synced' && !!r.square_variation_id),
  }))
  return { tier: p.websiteTier, planKey: p.key, name: p.name, monthlyPriceCents: p.monthlyPriceCents, perks: p.perks, billing, prices }
}

// ---- rules shared by the actions ------------------------------------------------------------------------------------------------

/** 401 LINK_WRONG_PURPOSE unless the page's link is one of `kinds`. */
export function requireKind(s: SessionView, kinds: readonly ClientLinkKind[]): void {
  if (!kinds.includes(s.link.kind)) throw new AppError('LINK_WRONG_PURPOSE', { meta: { kind: s.link.kind } })
}

/** 403 IDENTITY_STEP_UP_REQUIRED unless the page is verified (by a PIN or code here, or by the number's live trust). */
export function requireVerified(s: SessionView): void {
  if (s.trust !== 'verified') throw new AppError('IDENTITY_STEP_UP_REQUIRED', { meta: { need: 'verified' } })
}

/** 403 IDENTITY_STEP_UP_REQUIRED unless a PIN or code was entered on this page in the last 5 minutes (memberships, payments). */
export function requireFresh(s: SessionView, now: Date): void {
  if (!hasFreshStepUp(s, now)) throw new AppError('IDENTITY_STEP_UP_REQUIRED', { meta: { need: 'fresh' } })
}

/**
 * The page's own client is proven for it: their record is not held by the stale-record rule, or the page holds their PIN (a PIN
 * entered here, or the number's live trust granted by PIN). A texted code proves only the number (W4c fixes).
 */
export async function clientProven(db: Executor, s: SessionView, now: Date): Promise<boolean> {
  if (!s.customerId) return false
  if (s.trust === 'verified' && s.verifiedBy === 'pin') return true
  return !(await staleRecord(db, { locationId: s.link.locationId, customerId: s.customerId, phone: s.phone, now })).stale
}

/** 409 IDENTITY_RECORD_UNCONFIRMED when the page's client is not proven (a stale record behind a page verified by code). */
export async function requireProven(db: Executor, s: SessionView, now: Date): Promise<void> {
  if (!(await clientProven(db, s, now))) throw new AppError('IDENTITY_RECORD_UNCONFIRMED')
}

export async function requireNoHold(db: Executor, customerId: string, now: Date, tz: string): Promise<void> {
  const held = await memberPrivilegesHeldUntil(db, customerId, now)
  if (held)
    throw new AppError('LINK_PRIVILEGES_HELD', {
      params: { until: DateTime.fromJSDate(held, { zone: tz }).toFormat("ccc, LLL d 'at' h:mm a") },
      meta: { until: held.toISOString() },
    })
}

/**
 * What the page's own client is entitled to: no fee with an active membership; the VIP slot rules as a VIP client (the staff's
 * list) or an active member of the plan the website sells as VIP. Nothing while a PIN reset holds member privileges, and nothing for
 * a page that is not verified or has no client, nor for a stale record the page proved only by a texted code.
 */
export async function privilegesOf(db: Executor, s: SessionView, now: Date): Promise<{ member: boolean; vip: boolean }> {
  const none = { member: false, vip: false }
  if (s.trust !== 'verified' || !s.customerId) return none
  // a stale record behind a page that proved only the number is not this page's (W4c fixes)
  if (!(await clientProven(db, s, now))) return none
  if (await memberPrivilegesHeldUntil(db, s.customerId, now)) return none
  const listed = await isVipCustomer(db, s.link.locationId, s.customerId)
  const m = await activeMembership(db, s.customerId)
  if (!m) return { member: false, vip: listed }
  const plan = (await loadPlans(db, s.link.locationId)).find((p) => p.id === m.planId)
  return { member: true, vip: listed || plan?.vipBooking === true }
}

const bad = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path: `body.${path}`, message }] })

/** Online starts are on the board's grid (opening time plus whole slots), as on the website. */
async function assertOnTheGrid(tx: Tx, d: LinkDeps, loc: LinkLocation, date: string, startMin: number): Promise<void> {
  const data = await loadDayData(tx, { locationId: loc.id, tz: loc.tz, now: d.app.clock.now(), date })
  const open = data.day.openMin
  if (data.day.closed || open === null) return
  const step = data.settings.rules.slotMinutes
  if ((((startMin - open) % step) + step) % step !== 0) throw bad('startMin', 'Pick one of the times on the board.')
}

// ---- bookings -------------------------------------------------------------------------------------------------------------------

export interface LinkBookingInput {
  serviceKey: string
  addonKeys: string[]
  date: string
  startMin: number
  vehicle?: WebVehicle & { color?: string }
  /** The size chip (ADR 0170): prices the visit and is recorded on the car (source client). */
  vehicleClass?: string | null
  /** The client's name: required on a stranger's link (no client yet); fills a placeholder name otherwise. */
  name?: string
  email?: string
  /** A stranger's consent to the texts about their booking (a client's consent on file is kept). */
  smsConsent?: boolean
}

export interface LinkBookingResult {
  bookingRef: string
  status: 'booked'
  start: string
  end: string
  deposit: { dueCents: number; how: 'counter' | 'link' }
  confirmationBy: 'sms' | 'none'
  service: { key: string; name: string }
  addons: { key: string; name: string }[]
  when: string
  member: boolean
  bayCount: number
  pricing: WebPricing
}

/** POST bookings: a verified calendar or book-again page books a visit for its client (inside the idempotency transaction). */
export async function bookOnLink(tx: Tx, d: LinkDeps, s: SessionView, r: LinkRequest, input: LinkBookingInput): Promise<LinkBookingResult> {
  requireKind(s, ['calendar', 'book_again'])
  requireVerified(s)
  const now = d.app.clock.now()
  const loc = await linkLocation(tx, s.link.locationId)
  const services = await loadBoardServices(tx, loc.id)
  const pkg = services.packages.find((p) => p.key === input.serviceKey)
  if (!pkg) throw bad('serviceKey', 'Pick a wash from the catalog.')
  const addons = []
  for (const key of [...new Set(input.addonKeys)]) {
    const a = services.addons.find((x) => x.key === key)
    if (!a) throw bad('addonKeys', 'Pick add-ons from the catalog.')
    addons.push(a)
  }
  await assertOnTheGrid(tx, d, loc, input.date, input.startMin)
  // the size: the chip, else a size label sent as the car (ADR 0170)
  const sizes = await listVehicleClasses(tx, loc.id, { activeOnly: true })
  const vehicleClass = input.vehicleClass
    ? (await requireVehicleClass(tx, loc.id, input.vehicleClass, { active: true, path: 'body.vehicleClass' })).key
    : classOfLabel(input.vehicle?.label, sizes)
  // one completion of the link (the calendar's three bookings, book-again's one); refused before anything is written
  await consumeLink(tx, s.link.id, now)

  const name = input.name?.trim().replace(/\s+/g, ' ') ?? ''
  const email = input.email?.trim() || null
  let customerId: string
  // the PIN this page holds is its client's (or, on a stranger's link, the number's client's): such a booking is proof of them
  const pinOf = s.trust === 'verified' && s.verifiedBy === 'pin' ? await pinOwnerOf(tx, s) : null
  if (s.customerId && (await clientProven(tx, s, now))) {
    const c = await getCustomer(tx, s.customerId)
    if (!c || c.deletedAt || c.mergedInto) throw new AppError('IDENTITY_SESSION_INVALID')
    customerId = c.id
    // the page may fill a placeholder name and an empty email, never replace a real name or the email on file: a page verified
    // by the number alone must not move the address a PIN reset's notice goes to (nor drop a verified email); staff change it
    const patch: { fullName?: string; email?: string | null } = {}
    if (name && name !== c.fullName && isPlaceholderName(c)) patch.fullName = name
    if (email && !c.email) patch.email = email
    if (Object.keys(patch).length) await updateCustomer(tx, { id: c.id, patch })
  } else {
    // a stranger's link, or a client's link whose record the stale-record rule holds while this page proved only the number
    if (!s.customerId && !name) throw bad('name', 'Enter your name.')
    // the number's client (the booking lands on their record) has a PIN: a page verified by a texted code does not book for them
    // (a PIN set after this page's code, or a page verified before this rule): only their PIN does (W4c review)
    if (!s.customerId && s.verifiedBy !== 'pin' && (await pinStateOf(tx, await pinOwnerOf(tx, s))).set) throw new AppError('IDENTITY_PIN_REQUIRED')
    // proving the number is not proving the client on a stale record: the party becomes a new client and the number moves to them
    // (identity/rebind.ts); otherwise the number's client (or a new one when nobody holds the number)
    const bound = await bindPartyToNumber(tx, d.app, {
      locationId: s.link.locationId,
      phone: s.phone,
      provenByPinOf: pinOf,
      name: name || null,
      email,
      smsOptIn: input.smsConsent ? 'online' : null,
      source: 'online',
      // a stranger's link stays the new client's page; a client's link died with the old record's phone
      keepLinkId: s.customerId ? null : s.link.id,
      keepSessionHash: s.customerId ? null : s.tokenHash,
      audit: linkAudit(r),
    })
    customerId = bound.customerId
  }
  // member privileges are the page's own client's only (never a new client's that took the number)
  const privileges = customerId === s.customerId ? await privilegesOf(tx, s, now) : { member: false, vip: false }
  const fee = await getSetting(tx, loc.id, 'booking.guest_fee')
  const dueCents = privileges.member ? 0 : fee.value.cents
  const how = fee.value.collect
  const today = toBizDate(now, loc.tz)
  const when = whenWord(input.date, today)
  const time = fmtT(input.startMin)
  const start = wallToInstant(input.date, input.startMin, loc.tz)
  const c = schedulingCtx(d, loc)
  const actor = linkActor(loc.id, r)
  const v = vehicleOf(input.vehicle, sizes)
  let booked
  try {
    booked = await createAppointment(tx, c, actor, {
      customer: { id: customerId },
      vehicle: v ? { ...v, color: input.vehicle?.color ?? null } : null,
      // the page's client (or the new client the page made): their own record, so the size is recorded on the car they named
      vehicleClass,
      recordClassAs: 'client',
      memberPricing: privileges.member,
      confirmPriceVar: 'confirm',
      serviceId: pkg.id,
      addonIds: addons.map((a) => a.id),
      start,
      source: 'link',
      channel: 'online',
      vip: privileges.vip,
      bookedWithPin: pinOf !== null && pinOf === customerId,
      message: {
        templateKey: 'booking_confirmed_web',
        vars: {
          service: pkg.name,
          when,
          time,
          ...(privileges.member ? { member: 'yes' } : dueCents > 0 ? { fee: dollars(dueCents), how: how === 'link' ? 'by payment link' : 'at the shop' } : {}),
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
  await logActivity(tx, c, {
    appointmentId,
    text: privileges.member
      ? 'Booked on a personal link · member, no booking fee'
      : dueCents > 0
        ? `Booked on a personal link · ${dollars(dueCents)} booking fee due ${how === 'link' ? 'by payment link' : 'at the counter'}`
        : 'Booked on a personal link',
    channels: ['system'],
    actor,
  })
  const data = await loadDayData(tx, { locationId: loc.id, tz: loc.tz, now, date: toBizDate(start, loc.tz) })
  const bays = evaluateStart(engineInput(data, { durationMin: pkg.durationMin, channel: 'online', isVip: false }), start).baysFree
  return {
    bookingRef: bookingRefOf(booked.appointment.seq),
    status: 'booked',
    start: booked.appointment.scheduledStart,
    end: booked.appointment.scheduledEnd,
    deposit: { dueCents, how: feeHow(how) },
    confirmationBy: booked.messageQueued ? 'sms' : 'none',
    service: { key: pkg.key, name: pkg.name },
    addons: addons.map((a) => ({ key: a.key, name: a.name })),
    when: `${when === 'today' ? 'Today' : when === 'tomorrow' ? 'Tomorrow' : when} · ${time}`,
    member: privileges.member,
    bayCount: bays,
    pricing: webPricingOf(booked.pricing),
  }
}

// ---- reschedule -----------------------------------------------------------------------------------------------------------------

const REF = /^OAS-(\d{1,9})$/

export interface LinkRescheduleResult {
  bookingRef: string
  status: string
  start: string
  end: string
  when: string
}

/**
 * POST appointments/:ref/reschedule: a verified calendar page moves one of its client's own upcoming visits (booked or confirmed,
 * not started) to another time on the board, under the online rules (lead time, booking window, VIP holds as its privileges allow).
 * A calendar link sent for one visit moves only that visit. The client is texted the new time as for a desk reschedule.
 */
export async function rescheduleOnLink(
  tx: Tx,
  d: LinkDeps,
  s: SessionView,
  r: LinkRequest,
  ref: string,
  input: { date: string; startMin: number },
): Promise<LinkRescheduleResult> {
  requireKind(s, ['calendar'])
  requireVerified(s)
  const now = d.app.clock.now()
  const loc = await linkLocation(tx, s.link.locationId)
  const seq = REF.exec(ref)?.[1]
  // a stale record's visits are not shown to a page that proved only the number, nor moved by it (W4c fixes)
  const a =
    seq && s.customerId && (await clientProven(tx, s, now))
      ? await tx
          .selectFrom('appointments')
          .select(['id', 'status', 'scheduled_start', 'duration_min', 'customer_id'])
          .where('location_id', '=', loc.id)
          .where('seq', '=', Number(seq))
          .where('customer_id', '=', s.customerId)
          .$if(s.link.appointmentId !== null, (q) => q.where('id', '=', s.link.appointmentId!))
          .executeTakeFirst()
      : undefined
  if (!a) throw new AppError('LINK_APPOINTMENT_NOT_FOUND')
  if ((a.status !== 'booked' && a.status !== 'confirmed') || a.scheduled_start.getTime() <= now.getTime())
    throw new AppError('LINK_CANT_RESCHEDULE', { meta: { status: a.status } })
  await assertOnTheGrid(tx, d, loc, input.date, input.startMin)
  const start = wallToInstant(input.date, input.startMin, loc.tz)
  const c = schedulingCtx(d, loc)
  const actor = linkActor(loc.id, r)
  const privileges = await privilegesOf(tx, s, now)
  try {
    // the online rules first (the desk check inside rescheduleAppointment is the looser one)
    await checkSlot(tx, c, actor, {
      start,
      durationMin: a.duration_min,
      customerId: a.customer_id,
      channel: 'online',
      vip: privileges.vip,
      excludeAppointmentId: a.id,
    })
    const out = await rescheduleAppointment(tx, c, actor, a.id, { start })
    await audit.record(tx, {
      locationId: loc.id,
      action: 'identity.link.rescheduled',
      entityType: 'appointment',
      entityId: a.id,
      before: { start: a.scheduled_start.toISOString() },
      after: { start: start.toISOString(), linkId: s.link.id },
      ctx: linkAudit(r),
    })
    return {
      bookingRef: ref,
      status: out.appointment.status,
      start: out.appointment.scheduledStart,
      end: out.appointment.scheduledEnd,
      when: label(start, loc.tz),
    }
  } catch (e) {
    if (e instanceof AppError) throw publicSlotError(e, input.startMin)
    throw e
  }
}

// ---- membership -----------------------------------------------------------------------------------------------------------------

export interface MembershipStartResult {
  redirectUrl: string
  membershipRef: string
  /** Until when the checkout is expected (the intent's 72-hour window). */
  checkoutExpiresAt: Date
}

/**
 * POST membership/start: a membership link with a fresh PIN or code starts the plan's Squarespace checkout for its client. The
 * email the client typed only names the checkout intent's expected email (customers.email and email_verified are untouched: an
 * unverified email never links an order by itself). Vehicles typed on the page are added to the client.
 */
export async function startMembership(
  tx: Tx,
  d: LinkDeps,
  s: SessionView,
  r: LinkRequest,
  input: { email: string; planClass?: string; vehicles?: { car: string; plate?: string }[] },
): Promise<MembershipStartResult> {
  requireKind(s, ['membership'])
  const now = d.app.clock.now()
  requireFresh(s, now)
  if (!s.customerId || !s.link.planKey) throw new AppError('LINK_WRONG_PURPOSE')
  // with Square as the processor the page joins with a card (membership/subscribe, ADR 0171 wave Q3b), never a Squarespace checkout
  if (squareProcessor(squareEnv())) throw new AppError('LINK_CHECKOUT_UNAVAILABLE')
  // a code proves the number: on a stale record a membership waits for the client's PIN or staff (W4c fixes)
  await requireProven(tx, s, now)
  const loc = await linkLocation(tx, s.link.locationId)
  await requireNoHold(tx, s.customerId, now, loc.tz)
  await consumeLink(tx, s.link.id, now)
  for (const v of input.vehicles ?? []) {
    const parsed = parseVehicleLabel(v.car)
    if (!parsed.make && !v.plate) continue
    await upsertVehicleByPlate(tx, { newId: d.app.newId, customerId: s.customerId, year: parsed.year, make: parsed.make, model: parsed.model, plate: v.plate ?? null })
  }
  let out
  try {
    out = await openCheckoutIntent(
      tx,
      { locationId: loc.id, clock: d.app.clock, newId: d.app.newId },
      {
        customerId: s.customerId,
        planKey: s.link.planKey,
        planClass: input.planClass,
        email: input.email,
        linkId: s.link.id,
        envProductMap: d.app.env.SQSP_PRODUCT_MAP,
      },
      linkAudit(r),
    )
  } catch (e) {
    // a household member shares a membership already: the page says so in the same words
    if (e instanceof AppError && (e.code === 'MEMBERSHIP_EXISTS' || e.code === 'MEMBERSHIP_HOUSEHOLD_TAKEN'))
      throw new AppError('LINK_ALREADY_MEMBER', { cause: e })
    if (e instanceof AppError && e.code === 'MEMBERSHIP_CHECKOUT_UNAVAILABLE') throw new AppError('LINK_CHECKOUT_UNAVAILABLE', { cause: e })
    if (e instanceof AppError && e.code === 'VALIDATION_FAILED' && e.errors?.some((x) => x.path === 'planClass'))
      throw bad('planClass', 'Pick one of the vehicle sizes.')
    if (e instanceof AppError && e.code === 'VALIDATION_FAILED' && e.errors?.some((x) => x.path === 'email'))
      throw bad('email', 'Enter a valid email.')
    if (e instanceof AppError && e.code === 'VALIDATION_FAILED') throw new AppError('LINK_CHECKOUT_UNAVAILABLE', { cause: e })
    throw e
  }
  let redirectUrl: string
  try {
    // the plan's URL was checked when it was saved; checked again so nothing but squarespace.com is ever a redirect
    redirectUrl = checkCheckoutUrl(out.checkoutUrl)
  } catch (e) {
    throw new AppError('LINK_CHECKOUT_UNAVAILABLE', { cause: e })
  }
  return { redirectUrl, membershipRef: memberRefOf(out.membershipId), checkoutExpiresAt: out.expiresAt }
}

// ---- payment --------------------------------------------------------------------------------------------------------------------

export interface PayStartResult {
  status: 'redirect' | 'link_pending'
  redirectUrl: string | null
}

/** True when `url` is https on one of the allowed hosts (linkHostAllowed: an entry or its subdomain, `=host` exactly), with no user, password or port. */
export function payHostAllowed(url: string, hosts: readonly string[]): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const host = u.hostname.toLowerCase()
  return (
    u.protocol === 'https:' &&
    u.username === '' &&
    u.password === '' &&
    u.port === '' &&
    linkHostAllowed(host, hosts)
  )
}

export const payRequestSourceRef = (invoiceId: string): string => `pay_link_request:${invoiceId}`

/** The checks of pay/start (a payment link, a fresh PIN or code, the page's own proven client, no PIN-reset hold): its invoice. */
export async function payPageInvoice(tx: Tx, d: LinkDeps, s: SessionView) {
  requireKind(s, ['pay'])
  const now = d.app.clock.now()
  requireFresh(s, now)
  if (!s.customerId || !s.link.invoiceId) throw new AppError('LINK_WRONG_PURPOSE')
  await requireProven(tx, s, now)
  const loc = await linkLocation(tx, s.link.locationId)
  await requireNoHold(tx, s.customerId, now, loc.tz)
  const inv = await tx
    .selectFrom('invoices')
    .select(['id', 'invoice_no', 'payment_link_url', 'customer_id'])
    .where('id', '=', s.link.invoiceId)
    .where('location_id', '=', loc.id)
    .executeTakeFirst()
  if (!inv || inv.customer_id !== s.customerId) throw new AppError('LINK_WRONG_PURPOSE')
  // a saved-card charge of the invoice still waiting for Square: the page sends nowhere to pay (review Q4 money:H1)
  await assertNoChargeWaiting(tx, inv.id, { client: true })
  return { loc, inv, customerId: s.customerId, now }
}

/**
 * POST pay/start: a payment link with a fresh PIN or code. The invoice's payment URL (attached by staff) when its host is allowed:
 * one completion of the link and {status: redirect}. Without one: {status: link_pending}, and the managers are asked once (until
 * they read it) to text the client a payment link.
 */
export async function startPayment(tx: Tx, d: LinkDeps, s: SessionView, r: LinkRequest): Promise<PayStartResult> {
  const { loc, inv, now } = await payPageInvoice(tx, d, s)
  const url = inv.payment_link_url
  if (url && payHostAllowed(url, d.linkHosts)) {
    await consumeLink(tx, s.link.id, now)
    await audit.record(tx, {
      locationId: loc.id,
      action: 'identity.link.pay_redirect',
      entityType: 'invoice',
      entityId: inv.id,
      after: { linkId: s.link.id, host: new URL(url).hostname },
      ctx: linkAudit(r),
    })
    return { status: 'redirect', redirectUrl: url }
  }
  const ref = payRequestSourceRef(inv.id)
  const waiting = await tx
    .selectFrom('notifications')
    .select('id')
    .where('location_id', '=', loc.id)
    .where('source_ref', '=', ref)
    .where('read_at', 'is', null)
    .executeTakeFirst()
  if (!waiting) {
    const c = await getCustomer(tx, inv.customer_id)
    const who = c?.fullName ?? 'A client'
    await notifyManagers(
      tx,
      {
        locationId: loc.id,
        kind: 'payments.link_requested',
        title: `Text ${who.split(/\s+/)[0]} a payment link`,
        body:
          `${who} (${maskPhone(s.phone)}) opened their payment page for invoice #${inv.invoice_no}, but the invoice has no payment link ` +
          'yet. Attach the Squarespace link to the invoice and send it.',
        entityType: 'invoice',
        entityId: inv.id,
        sourceRef: ref,
      },
      { newId: d.app.newId, clock: d.app.clock },
    )
    await audit.record(tx, {
      locationId: loc.id,
      action: 'identity.link.pay_requested',
      entityType: 'invoice',
      entityId: inv.id,
      after: { linkId: s.link.id, reason: url ? 'host_not_allowed' : 'no_url' },
      ctx: linkAudit(r),
    })
  }
  return { status: 'link_pending', redirectUrl: null }
}
