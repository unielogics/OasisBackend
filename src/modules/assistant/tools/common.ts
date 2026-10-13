// What the assistant's tools share (ADR 0160, design section 4; wave W3b): outcome builders, the trust order, dates in words, the
// online slot verdict the tools and the reply-number handler both apply, the client's privileges (member: no fee; VIP: the VIP slot
// rules, only once trusted) and the cap on future AI bookings. Nothing here takes an id from the model.
import { sql } from 'kysely'
import { DateTime } from 'luxon'
import type { AiJson, AiJsonObject } from '../../../integrations/ports/ai.js'
import type { Executor, Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { addDays, diffDays, fmtT, isValidBizDate, toBizDate, wallToInstant } from '../../../platform/time.js'
import { isVipCustomer } from '../../customers/service.js'
import { memberPrivilegesHeldUntil } from '../../identity/pin-service.js'
import { loadPlans } from '../../memberships/plans.js'
import { activeMembership } from '../../public/members.js'
import { computeSlots, type Slot } from '../../scheduling/availability.js'
import { engineInput, loadDayData, sameDayGuaranteesUsed } from '../../scheduling/availability-loader.js'
import { getVipSettings } from '../../settings/vip.js'
import type { HandoffRequest, ToolContext, ToolErrorKind, ToolHandoffReason, ToolOutcome, TurnTrust } from '../contract.js'

/** At most this many future bookings the assistant made may be open per client (plan C caps). */
export const MAX_AI_BOOKINGS_AHEAD = 2

export const TRUST_RANK: Record<TurnTrust, number> = { unknown: 0, caller: 1, trusted: 2 }
export const atLeast = (have: TurnTrust, need: TurnTrust): boolean => TRUST_RANK[have] >= TRUST_RANK[need]

/** A plain JSON copy (the facts' interfaces have no index signature; the model's data must be pure JSON anyway). */
export const json = (x: unknown): AiJsonObject => JSON.parse(JSON.stringify(x)) as AiJsonObject
export const jsonValue = (x: unknown): AiJson => JSON.parse(JSON.stringify(x ?? null)) as AiJson

export function ok(data: AiJsonObject, extra: { amountsCents?: number[]; handoff?: HandoffRequest } = {}): ToolOutcome {
  return { ok: true, data, ...extra }
}

export function fail(error: ToolErrorKind, message: string, extra: { detail?: AiJsonObject; handoff?: HandoffRequest } = {}): ToolOutcome {
  return { ok: false, error, message, ...extra }
}

/** Hands the conversation to staff (the context's handoff; the first request of the turn wins) and says so in the outcome. */
export function withHandoff(ctx: ToolContext, outcome: ToolOutcome, reason: ToolHandoffReason, summary: string): ToolOutcome {
  ctx.handoff(reason, summary)
  return { ...outcome, handoff: { reason, summary } }
}

export const BIZ_DATE = /^\d{4}-\d{2}-\d{2}$/

/** "Sat Jun 20". */
export const shortDate = (date: string): string => DateTime.fromISO(date, { zone: 'utc' }).setLocale('en-US').toFormat('ccc LLL d')

/** "today at 10:00 AM", "tomorrow at 9:00 AM", "Sat Jun 20 at 10:00 AM". */
export function whenWords(date: string, startMin: number, today: string): string {
  const day = date === today ? 'today' : date === addDays(today, 1) ? 'tomorrow' : shortDate(date)
  return `${day} at ${fmtT(startMin)}`
}

/** "today", "tomorrow" or "Sat Jun 20" (the booked text's {when}). */
export const dayWord = (date: string, today: string): string =>
  date === today ? 'today' : date === addDays(today, 1) ? 'tomorrow' : shortDate(date)

export const partOfDayOf = (startMin: number): 'morning' | 'afternoon' | 'evening' =>
  startMin < 12 * 60 ? 'morning' : startMin < 17 * 60 ? 'afternoon' : 'evening'

/**
 * What a client is entitled to: no booking fee with an active membership; the VIP slot rules as a VIP client or VIP-tier member.
 * Neither while a PIN reset by texted code holds the member privileges (72 hours; identity/pin-service memberPrivilegesHeldUntil,
 * design section 5): the number was just trusted again from a code alone.
 */
export async function privilegesOf(db: Executor, locationId: string, customerId: string, now: Date): Promise<{ member: boolean; vip: boolean }> {
  if ((await memberPrivilegesHeldUntil(db, customerId, now)) !== null) return { member: false, vip: false }
  const m = await activeMembership(db, customerId)
  const listed = await isVipCustomer(db, locationId, customerId)
  if (!m) return { member: false, vip: listed }
  const plan = (await loadPlans(db, locationId)).find((p) => p.id === m.planId)
  return { member: true, vip: listed || plan?.vipBooking === true }
}

/** Open future bookings the assistant made for the client. */
export async function aiBookingsAhead(db: Executor, customerId: string, now: Date): Promise<number> {
  const r = await db
    .selectFrom('appointments')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('customer_id', '=', customerId)
    .where('source', '=', 'sms_ai')
    .where('status', 'in', ['booked', 'confirmed'])
    .where('scheduled_start', '>', now)
    .executeTakeFirstOrThrow()
  return r.n
}

export type SlotProblem = 'bad_date' | 'past' | 'too_far' | 'closed' | 'off_grid' | 'taken'

export type SlotVerdict =
  | { ok: true; start: Date; date: string; startMin: number }
  | { ok: false; problem: SlotProblem; message: string; open: { time: string; startMin: number }[] }

const PROBLEM_TEXT: Record<SlotProblem, string> = {
  bad_date: 'That date is not a valid date (use YYYY-MM-DD).',
  past: 'That time has already passed or is too soon to book online.',
  too_far: 'That date is too far ahead to book online.',
  closed: 'The shop is closed that day.',
  off_grid: 'That is not one of the bookable start times.',
  taken: 'That time is not open.',
}

/** The open (bookable) start times of one date for a duration, the way the website's board shows them (online channel). */
export async function openTimes(
  db: Executor,
  o: { locationId: string; tz: string; now: Date; date: string; durationMin: number; vip: boolean; customerId: string | null; excludeAppointmentId?: string },
): Promise<{ closed: boolean; reason: string | null; slots: Slot[]; all: Slot[] }> {
  const data = await loadDayData(db, {
    locationId: o.locationId,
    tz: o.tz,
    now: o.now,
    date: o.date,
    ...(o.excludeAppointmentId ? { excludeAppointmentId: o.excludeAppointmentId } : {}),
  })
  const sameDayUsed = o.vip && o.customerId ? await sameDayGuaranteesUsed(db, { locationId: o.locationId, customerId: o.customerId, now: o.now, tz: o.tz }) : 0
  const result = computeSlots(engineInput(data, { durationMin: o.durationMin, channel: 'online', isVip: o.vip, sameDayUsed }))
  return {
    closed: result.closed || data.day.closed,
    reason: data.day.reason,
    slots: result.closed ? [] : result.slots.filter((s) => s.state === 'available'),
    all: result.closed ? [] : result.slots,
  }
}

/**
 * Whether a start is bookable online right now: a real date inside the booking window (VIP's when vip), on the board's grid, and
 * open for the whole duration. The same check runs when the proposal is made and again when the reply number confirms it.
 */
export async function slotVerdict(
  db: Executor,
  o: {
    locationId: string
    tz: string
    now: Date
    date: string
    startMin: number
    durationMin: number
    vip: boolean
    customerId: string | null
    windowDays: number
    excludeAppointmentId?: string
  },
): Promise<SlotVerdict> {
  const no = (problem: SlotProblem, open: { time: string; startMin: number }[] = []): SlotVerdict => ({ ok: false, problem, message: PROBLEM_TEXT[problem], open })
  if (!BIZ_DATE.test(o.date) || !isValidBizDate(o.date)) return no('bad_date')
  const today = toBizDate(o.now, o.tz)
  if (o.date < today) return no('past')
  if (diffDays(today, o.date) > o.windowDays) return no('too_far')
  const day = await openTimes(db, o)
  if (day.closed) return no('closed')
  const open = day.slots.map((s) => ({ time: fmtT(s.startMin), startMin: s.startMin }))
  const hit = day.slots.find((s) => s.startMin === o.startMin)
  if (!hit) {
    const slot = day.all.find((s) => s.startMin === o.startMin)
    const near = nearest(open, o.startMin)
    if (!slot) return no('off_grid', near)
    if (slot.state === 'past') return no('past', near)
    if (slot.state === 'outside_window') return no('too_far')
    if (slot.state === 'closed' || slot.state === 'cutoff') return no('taken', near)
    return no('taken', near)
  }
  return { ok: true, start: wallToInstant(o.date, o.startMin, o.tz), date: o.date, startMin: o.startMin }
}

/** The open times closest to the asked one (at most four). */
export function nearest(open: { time: string; startMin: number }[], startMin: number, n = 4): { time: string; startMin: number }[] {
  return [...open].sort((a, b) => Math.abs(a.startMin - startMin) - Math.abs(b.startMin - startMin) || a.startMin - b.startMin).slice(0, n).sort((a, b) => a.startMin - b.startMin)
}

/** The booking window in days for the caller: the VIP window only for a trusted VIP. */
export async function windowDaysFor(db: Executor, locationId: string, vip: boolean): Promise<number> {
  const { settings } = await getVipSettings(db, locationId)
  return vip ? settings.windowVipDays : settings.windowStdDays
}

/** The appointment behind a ref, only when it is this client's (the refs are built for the turn's client; checked again here). */
export async function ownAppointment(
  db: Executor,
  ctx: Pick<ToolContext, 'refs' | 'identity'>,
  ref: string,
): Promise<{ id: string; customerId: string; status: string; start: Date; durationMin: number; serviceName: string; locationId: string } | null> {
  const id = ctx.refs.resolve(ref)
  if (!id || !ctx.identity.customerId) return null
  const a = await db
    .selectFrom('appointments as a')
    .leftJoin('services as s', 's.id', 'a.service_id')
    .select(['a.id', 'a.customer_id', 'a.status', 'a.scheduled_start', 'a.duration_min', 'a.package_name', 's.public_name', 'a.location_id'])
    .where('a.id', '=', id)
    .executeTakeFirst()
  if (!a || a.customer_id !== ctx.identity.customerId || a.location_id !== ctx.identity.locationId) return null
  return {
    id: a.id,
    customerId: a.customer_id,
    status: a.status,
    start: a.scheduled_start,
    durationMin: a.duration_min,
    serviceName: a.public_name ?? a.package_name,
    locationId: a.location_id,
  }
}

/** Runs fn inside a savepoint of tx: a failure rolls back only what fn wrote (the caller's transaction stays usable). */
export async function inSavepoint<T>(tx: Tx, name: string, fn: () => Promise<T>): Promise<T> {
  await sql`savepoint ${sql.id(name)}`.execute(tx)
  try {
    const out = await fn()
    await sql`release savepoint ${sql.id(name)}`.execute(tx)
    return out
  } catch (e) {
    await sql`rollback to savepoint ${sql.id(name)}`.execute(tx)
    throw e
  }
}

/** A client-facing sentence for a scheduling refusal (never the dashboard's override hints). */
export function plainSchedulingError(e: unknown): string | null {
  if (!(e instanceof AppError)) return null
  if (e.code.startsWith('SLOT_') || e.code === 'BAY_UNAVAILABLE') return 'that time was just taken.'
  if (e.code === 'INVALID_TRANSITION' || e.code === 'CANT_MOVE_JOB') return 'that visit can no longer be changed by text.'
  if (e.code === 'VALIDATION_FAILED') return 'that service is no longer offered online.'
  return 'something on our side did not work.'
}

/** A person's name as typed: letters (any alphabet), spaces, apostrophes, hyphens and periods; one to four words. */
export function cleanPersonName(raw: string): string | null {
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (name.length < 2 || name.length > 60) return null
  if (!/^\p{L}[\p{L}\p{M}'’ .-]*$/u.test(name)) return null
  const words = name.split(' ')
  if (words.length > 4 || words.some((w) => !/\p{L}/u.test(w))) return null
  return name
}
