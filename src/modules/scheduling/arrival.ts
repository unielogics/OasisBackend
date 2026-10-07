// The customer-side arrival ping (backend design 4.9, ADR 0083). A staff member issues a per-appointment link token; the customer's
// phone reports its position with that token. The server measures the distance to the shop, keeps an ETA, alerts the crew once when
// the ETA first reaches the prep time, and inside the radius either checks the job in (auto check-in) or flags it for staff to
// confirm. Everything runs in one transaction, is idempotent (a ping key replays; a job that has arrived ignores further pings)
// and is throttled per appointment.
import { createHash, randomBytes } from 'node:crypto'
import { sql } from 'kysely'
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import * as realtime from '../../platform/realtime.js'
import type { JsonValue } from '../../platform/schema.js'
import { onShiftUsers } from '../settings/db-adapters/effects.js'
import {
  customerBrief,
  lockAppointment,
  logActivity,
  publishOps,
  type AppointmentRecord,
} from './appointments.js'
import { loadSettingsBundle, type Actor, type SchedulingCtx } from './context.js'
import { arriveAppointment } from './lifecycle.js'
import './problems.js'

export const TOKEN_PREFIX = 'oa_'
/** A link works until this long after the booked end. */
export const LINK_GRACE_MS = 2 * 3600_000
/** Minimum spacing of accepted pings for one appointment. */
export const MIN_PING_GAP_MS = 5000
export const AVERAGE_SPEED_KMH = 25
export const MAX_ETA_MIN = 600
const EARTH_RADIUS_M = 6_371_000

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Great-circle distance in metres (haversine). */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number): number => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Minutes to cover `distanceM` at the assumed average speed, rounded up. */
export const etaFromDistance = (distanceM: number): number =>
  Math.min(MAX_ETA_MIN, Math.ceil((distanceM * 60) / (AVERAGE_SPEED_KMH * 1000)))

// Link tokens ---------------------------------------------------------------------------------------------------------

export interface IssuedLink {
  token: string
  path: string
  expiresAt: Date
}

/** Issues (or rotates) the appointment's link token. Only booked, confirmed or arrived jobs have one. */
export async function issueArrivalLink(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  appointmentId: string,
): Promise<IssuedLink> {
  const a = await lockAppointment(tx, c.locationId, appointmentId)
  if (a.status !== 'booked' && a.status !== 'confirmed' && a.status !== 'arrived')
    throw new AppError('INVALID_TRANSITION', { params: { status: a.status } })
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  const expiresAt = new Date(a.scheduledEnd.getTime() + LINK_GRACE_MS)
  await tx
    .updateTable('appointments')
    .set({ arrival_token_hash: hashToken(token), arrival_token_expires_at: expiresAt })
    .where('id', '=', a.id)
    .execute()
  await logActivity(tx, c, {
    appointmentId: a.id,
    text: 'Check-in link issued',
    channels: ['internal'],
    actor,
  })
  return { token, path: `/a/${token}`, expiresAt }
}

// Pings ---------------------------------------------------------------------------------------------------------------

export type PingState =
  'outside' | 'inconclusive' | 'checked_in' | 'confirm_needed' | 'already_arrived' | 'disabled'

export interface PingInput {
  token: string
  lat: number
  lng: number
  accuracyM?: number | null
  etaMinutes?: number | null
  /** The customer tapped "I'm here". */
  declared?: boolean
  /** The client's id for this ping; a repeat returns the stored answer. */
  pingId?: string | null
}

export interface PingReply {
  state: PingState
  distanceM: number
  radiusM: number
  etaMinutes: number | null
  message: string
}

const MESSAGES: Record<PingState, (eta: number | null) => string> = {
  outside: (eta) => (eta === null ? 'We can see you are on your way.' : `You are about ${eta} min away.`),
  inconclusive: () => 'We could not pin down your location yet. Keep this page open.',
  checked_in: () => 'You are checked in. Pull in and we will take it from here.',
  confirm_needed: () => 'We have let the team know you are here.',
  already_arrived: () => 'You are already checked in.',
  disabled: () => 'Check-in by location is turned off. Please check in at the desk.',
}

const reply = (state: PingState, distanceM: number, radiusM: number, eta: number | null): PingReply => ({
  state,
  distanceM,
  radiusM,
  etaMinutes: eta,
  message: MESSAGES[state](eta),
})

/** The system's hands: arrival from a geofence is not a person's action, but it needs an actor for the audit row. */
function geofenceActor(a: AppointmentRecord): Actor {
  return {
    auth: {
      userId: 'system:geofence',
      employeeId: null,
      locationId: a.locationId,
      permissions: new Set(['jobs.status']),
      actorName: 'Geofence',
    },
    audit: { actor: { name: 'Geofence' } },
  }
}

async function notifyCrew(
  tx: Tx,
  c: SchedulingCtx,
  a: AppointmentRecord,
  n: { title: string; body: string },
): Promise<void> {
  const people = await onShiftUsers(tx, { locationId: c.locationId, now: c.clock.now(), tz: c.tz })
  for (const p of people) {
    const id = c.newId()
    await tx
      .insertInto('notifications')
      .values({
        id,
        location_id: c.locationId,
        employee_id: p.employeeId,
        role_target: null,
        kind: 'arrival',
        title: n.title,
        body: n.body,
        entity_type: 'appointment',
        entity_id: a.id,
        read_at: null,
      })
      .execute()
    await realtime.publish(tx, {
      locationId: c.locationId,
      channel: 'notifications',
      type: 'notification.new',
      payload: { id, kind: 'arrival' },
      targetUserId: p.userId,
    })
  }
}

export interface ResolvedLink {
  appointmentId: string
  locationId: string
  expiresAt: Date | null
}

/** The appointment a token belongs to: 401 for an unknown token. Expiry and the job's state are checked by recordPing. */
export async function resolveLink(tx: Tx, token: string): Promise<ResolvedLink> {
  const hit = await tx
    .selectFrom('appointments')
    .select(['id', 'location_id', 'arrival_token_expires_at'])
    .where('arrival_token_hash', '=', hashToken(token))
    .executeTakeFirst()
  if (!hit) throw new AppError('ARRIVAL_LINK_INVALID')
  return { appointmentId: hit.id, locationId: hit.location_id, expiresAt: hit.arrival_token_expires_at }
}

/** Ping by token: 401 for a closed job, 410 once the link has expired. `c` is built for the link's location. */
export async function recordPing(
  tx: Tx,
  c: SchedulingCtx,
  link: ResolvedLink,
  input: Omit<PingInput, 'token'>,
): Promise<PingReply> {
  const a = await lockAppointment(tx, c.locationId, link.appointmentId)
  if (a.status === 'canceled' || a.status === 'no_show') throw new AppError('ARRIVAL_LINK_INVALID')
  if (link.expiresAt && link.expiresAt.getTime() < c.clock.now().getTime())
    throw new AppError('ARRIVAL_LINK_EXPIRED')
  return applyPing(tx, c, a, input)
}

/** The evaluation shared with the dev "simulate arrival" control. */
export async function applyPing(
  tx: Tx,
  c: SchedulingCtx,
  a: AppointmentRecord,
  input: Omit<PingInput, 'token'>,
  o: { skipThrottle?: boolean } = {},
): Promise<PingReply> {
  const now = c.clock.now()
  if (input.pingId) {
    const seen = await tx
      .selectFrom('arrival_pings')
      .select('reply')
      .where('appointment_id', '=', a.id)
      .where('ping_key', '=', input.pingId)
      .executeTakeFirst()
    if (seen) return seen.reply as unknown as PingReply
  }
  const settings = await loadSettingsBundle(tx, c.locationId)
  const radiusM = settings.arrival.radiusM
  if (!settings.arrival.enabled) return reply('disabled', 0, radiusM, null)
  const loc = await tx
    .selectFrom('locations')
    .select(['lat', 'lng'])
    .where('id', '=', c.locationId)
    .executeTakeFirstOrThrow()
  if (loc.lat === null || loc.lng === null) throw new AppError('ARRIVAL_NOT_CONFIGURED')
  const distanceM = Math.round(
    haversineM({ lat: input.lat, lng: input.lng }, { lat: Number(loc.lat), lng: Number(loc.lng) }),
  )

  const arrivedAlready = a.status !== 'booked' && a.status !== 'confirmed'
  if (arrivedAlready) return reply('already_arrived', distanceM, radiusM, null)

  if (!o.skipThrottle) {
    const last = await tx
      .selectFrom('arrival_pings')
      .select(sql<Date>`max(at)`.as('at'))
      .where('appointment_id', '=', a.id)
      .executeTakeFirst()
    if (last?.at && now.getTime() - last.at.getTime() < MIN_PING_GAP_MS) {
      const wait = Math.ceil((MIN_PING_GAP_MS - (now.getTime() - last.at.getTime())) / 1000)
      throw new AppError('ARRIVAL_PING_TOO_FAST', {
        headers: { 'Retry-After': String(wait) },
        meta: { retryAfterSec: wait },
      })
    }
  }

  const accurate = input.accuracyM === undefined || input.accuracyM === null || input.accuracyM <= radiusM
  const inside = distanceM <= radiusM
  const customer = await customerBrief(tx, a.customerId)
  let state: PingState
  let eta: number | null = null

  if (inside && accurate) {
    if (settings.arrival.autoArrive) {
      await arriveAppointment(tx, c, geofenceActor(a), a.id, { source: 'geofence' })
      state = 'checked_in'
    } else {
      await tx
        .updateTable('appointments')
        .set((eb) => ({
          geo_checked_in_at: now,
          eta_minutes: null,
          eta_at: null,
          version: eb('version', '+', 1),
          updated_at: eb.fn('app_now', []),
        }))
        .where('id', '=', a.id)
        .execute()
      await logActivity(tx, c, {
        appointmentId: a.id,
        text: 'Geofence check-in · waiting for staff to confirm',
        channels: ['automation'],
        actorType: 'automation',
      })
      state = 'confirm_needed'
    }
    await realtime.publish(tx, {
      locationId: c.locationId,
      channel: 'ops',
      type: 'arrival.checked_in',
      payload: { appointmentId: a.id, auto: state === 'checked_in', distanceM },
    })
    if (settings.arrival.alertCrew)
      await notifyCrew(tx, c, a, {
        title: `${customer.fullName} is here`,
        body: state === 'checked_in' ? 'Checked in automatically' : 'Confirm the arrival',
      })
    if (state === 'confirm_needed') {
      const fresh = await lockAppointment(tx, c.locationId, a.id)
      await publishOps(tx, c.locationId, {
        appointment: { id: fresh.id, version: fresh.version, status: fresh.status, change: 'checked_in' },
      })
    }
  } else {
    state = inside ? 'inconclusive' : 'outside'
    const given = input.etaMinutes
    eta =
      given !== undefined && given !== null
        ? Math.min(MAX_ETA_MIN, Math.max(0, Math.round(given)))
        : etaFromDistance(distanceM)
    const crossed =
      eta <= settings.arrival.prepAtMin &&
      (a.etaMinutes === null || a.etaMinutes > settings.arrival.prepAtMin)
    if (a.etaMinutes !== eta) {
      await tx
        .updateTable('appointments')
        .set((eb) => ({
          eta_minutes: eta,
          eta_at: now,
          version: eb('version', '+', 1),
          updated_at: eb.fn('app_now', []),
        }))
        .where('id', '=', a.id)
        .execute()
      await realtime.publish(tx, {
        locationId: c.locationId,
        channel: 'ops',
        type: 'arrival.eta',
        payload: { appointmentId: a.id, etaMinutes: eta, distanceM, crossed },
      })
      const fresh = await lockAppointment(tx, c.locationId, a.id)
      await publishOps(tx, c.locationId, {
        appointment: { id: fresh.id, version: fresh.version, status: fresh.status, change: 'eta' },
      })
    }
    if (crossed && settings.arrival.alertCrew)
      await notifyCrew(tx, c, a, {
        title: `${customer.fullName} is ${eta} min away`,
        body: `Prep the bay · ${settings.arrival.prepAtMin} min alert`,
      })
  }

  const out = reply(state, distanceM, radiusM, eta)
  await tx
    .insertInto('arrival_pings')
    .values({
      id: c.newId(),
      location_id: c.locationId,
      appointment_id: a.id,
      at: now,
      lat: input.lat,
      lng: input.lng,
      accuracy_m:
        input.accuracyM === undefined || input.accuracyM === null ? null : Math.round(input.accuracyM),
      distance_m: distanceM,
      eta_min: eta,
      declared: input.declared ?? false,
      outcome: state as 'outside' | 'inconclusive' | 'checked_in' | 'confirm_needed',
      ping_key: input.pingId ?? null,
      reply: JSON.stringify(out) as unknown as JsonValue as never,
    })
    .execute()
  return out
}

/** Dev control: behaves as a ping from inside the geofence ("arrive") or from `etaMinutes` away ("eta"), without a token. */
export async function simulateArrival(
  tx: Tx,
  c: SchedulingCtx,
  appointmentId: string,
  o: { mode: 'arrive' | 'eta'; etaMinutes?: number },
): Promise<PingReply> {
  const a = await lockAppointment(tx, c.locationId, appointmentId)
  const loc = await tx
    .selectFrom('locations')
    .select(['lat', 'lng'])
    .where('id', '=', c.locationId)
    .executeTakeFirstOrThrow()
  if (loc.lat === null || loc.lng === null) throw new AppError('ARRIVAL_NOT_CONFIGURED')
  const eta = o.etaMinutes ?? 10
  const metersAway = o.mode === 'arrive' ? 0 : Math.round((eta * AVERAGE_SPEED_KMH * 1000) / 60)
  return applyPing(
    tx,
    c,
    a,
    {
      lat: Number(loc.lat) + metersAway / 111_194.9266,
      lng: Number(loc.lng),
      accuracyM: 5,
      etaMinutes: o.mode === 'eta' ? eta : null,
    },
    { skipThrottle: true },
  )
}
