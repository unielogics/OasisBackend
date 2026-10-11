// The PIN rules on a link page (ADR 0160, design section 5):
//   - verify: constant time and the same scrypt work whether or not the client has a PIN; a wrong PIN and a PIN where none exists
//     answer alike (IDENTITY_PIN_INVALID); per page 5 tries then the session ends; per client address 20 wrong an hour; per client
//     10 wrong in any 24 hours; the lockout schedule 5 wrong -> 15 minutes, 3 more -> 1 hour, 3 more -> disabled until reset (staff
//     notified). A right PIN clears the consecutive count (not the 24-hour count) and verifies the page and the number for 30 days.
//   - set: only after a code confirmed on this page within 10 minutes, only while no PIN exists, blocklist; bumps the PIN version, so
//     every other link of the client dies (this page's own link is re-bound).
//   - reset: after a pin_reset code confirmed on this page within 10 minutes; ends every other link, session and the trust, holds
//     member privileges 72 hours, emails the client (when an address is on file) and tells the managers.
//   - clear (staff): removes the PIN, ends links, sessions and trust.
import { DateTime } from 'luxon'
import * as audit from '../../platform/audit.js'
import type { AuditContext } from '../../platform/audit.js'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { getLocation } from '../../platform/locations.js'
import { maskPhone } from '../../platform/phone.js'
import type { Clock } from '../../platform/clock.js'
import { queueEmail } from '../messaging/email/service.js'
import { notifyManagers } from '../messaging/notify.js'
import { PIN_AFTER_CODE_MS, pinStateOf } from './codes.js'
import { liveCustomer } from './common.js'
import type { IdentityDeps } from './deps.js'
import { pinProblem } from './pin.js'
import { revokeIdentity } from './revoke.js'
import { countSessionFailure, markSessionVerified, resolveSession, type SessionView } from './sessions.js'
import { grantTrust } from './trust.js'
import './problems.js'
import './schema.js'

const MIN = 60_000
const HOUR = 60 * MIN

/** Lock levels: 1 after 5 consecutive wrong PINs (15 minutes), 2 after 8 (1 hour), 3 after 11 (disabled until a reset). */
export const PIN_LOCK_SCHEDULE = [
  { level: 1, afterFailures: 5, lockMs: 15 * MIN },
  { level: 2, afterFailures: 8, lockMs: HOUR },
  { level: 3, afterFailures: 11, lockMs: null },
] as const
export const PIN_FAILS_PER_DAY = 10
export const PIN_FAILS_PER_IP_HOUR = 20
export const PIN_RESET_HOLD_MS = 72 * HOUR

const ACTOR = { name: 'Personal link' }

/** The lock level `failures` consecutive wrong PINs reach. */
export function lockLevelFor(failures: number): number {
  let level = 0
  for (const s of PIN_LOCK_SCHEDULE) if (failures >= s.afterFailures) level = s.level
  return level
}

type Outcome = { ok: true; session: SessionView } | { ok: false; error: AppError }

const minutesUntil = (until: Date, now: Date): number => Math.max(1, Math.ceil((until.getTime() - now.getTime()) / MIN))
const retryHeaders = (until: Date, now: Date) => ({ 'Retry-After': String(Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000))) })

/**
 * Checks a PIN typed on the link page. On success the page is verified by PIN (step-up now) and the number trusted 30 days. Errors:
 * 401 IDENTITY_PIN_INVALID (also when no PIN exists), 429 IDENTITY_SESSION_LOCKED (the page's fifth wrong entry), 429
 * IDENTITY_PIN_LOCKED (Retry-After), 423 IDENTITY_PIN_DISABLED, 429 IDENTITY_TOO_MANY_TRIES (this address), 401 IDENTITY_SESSION_INVALID.
 */
export async function verifySessionPin(
  d: IdentityDeps,
  o: { session: string; pin: string; ip: string | null; requestId?: string | null },
): Promise<SessionView> {
  const now = d.clock.now()
  const out = await d.db.transaction().execute(async (tx): Promise<Outcome> => {
    let s: SessionView
    try {
      s = await resolveSession(tx, o.session, now, { forUpdate: true })
    } catch (e) {
      return { ok: false, error: e as AppError }
    }
    const locationId = s.link.locationId
    if (o.ip) {
      const ipFails = await tx
        .selectFrom('identity_pin_failures')
        .select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.min('at').as('oldest')])
        .where('location_id', '=', locationId)
        .where('ip', '=', o.ip)
        .where('at', '>', new Date(now.getTime() - HOUR))
        .executeTakeFirstOrThrow()
      if (Number(ipFails.n) >= PIN_FAILS_PER_IP_HOUR) {
        const until = new Date(new Date(ipFails.oldest as unknown as string).getTime() + HOUR)
        return { ok: false, error: new AppError('IDENTITY_TOO_MANY_TRIES', { params: { minutes: minutesUntil(until, now) }, headers: retryHeaders(until, now) }) }
      }
    }
    const row = s.customerId
      ? await tx.selectFrom('customer_pins').selectAll().where('customer_id', '=', s.customerId).forUpdate().executeTakeFirst()
      : undefined
    const hasPin = !!row?.pin_hash
    if (row && hasPin) {
      if (row.lock_level >= 3) return { ok: false, error: new AppError('IDENTITY_PIN_DISABLED') }
      if (row.locked_until && row.locked_until.getTime() > now.getTime())
        return { ok: false, error: new AppError('IDENTITY_PIN_LOCKED', { params: { minutes: minutesUntil(row.locked_until, now) }, headers: retryHeaders(row.locked_until, now) }) }
      const day = await tx
        .selectFrom('identity_pin_failures')
        .select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.min('at').as('oldest')])
        .where('customer_id', '=', row.customer_id)
        .where('at', '>', new Date(now.getTime() - 24 * HOUR))
        .executeTakeFirstOrThrow()
      if (Number(day.n) >= PIN_FAILS_PER_DAY) {
        const until = new Date(new Date(day.oldest as unknown as string).getTime() + 24 * HOUR)
        return { ok: false, error: new AppError('IDENTITY_PIN_LOCKED', { params: { minutes: minutesUntil(until, now) }, headers: retryHeaders(until, now) }) }
      }
    }
    // the same HMAC + scrypt work whether or not there is a PIN to compare against
    const owner = s.customerId ?? s.link.id
    const right = row?.pin_hash ? await d.pins.verify(owner, o.pin, row.pin_hash) : await d.pins.verifyNone(owner, o.pin)

    if (!right) {
      await tx
        .insertInto('identity_pin_failures')
        .values({ id: d.newId(), location_id: locationId, customer_id: hasPin ? s.customerId : null, phone_e164: s.phone, ip: o.ip, at: now })
        .execute()
      if (row && hasPin) {
        const failures = row.failed_attempts + 1
        const level = Math.max(row.lock_level, lockLevelFor(failures))
        const step = PIN_LOCK_SCHEDULE.find((x) => x.level === level)
        const newlyLocked = level > row.lock_level
        await tx
          .updateTable('customer_pins')
          .set({
            failed_attempts: failures,
            lock_level: level,
            ...(newlyLocked ? { locked_until: step?.lockMs ? new Date(now.getTime() + step.lockMs) : null } : {}),
            updated_at: now,
          })
          .where('customer_id', '=', row.customer_id)
          .execute()
        if (newlyLocked) await recordLock(tx, d, { locationId, customerId: row.customer_id, phone: s.phone, level, ip: o.ip, requestId: o.requestId })
      }
      const left = await countSessionFailure(tx, s.tokenHash, now)
      if (left === 0) return { ok: false, error: new AppError('IDENTITY_SESSION_LOCKED') }
      return { ok: false, error: new AppError('IDENTITY_PIN_INVALID', { params: { left, tries: left === 1 ? 'try' : 'tries' }, meta: { attemptsLeft: left } }) }
    }

    await tx
      .updateTable('customer_pins')
      .set({ failed_attempts: 0, lock_level: 0, locked_until: null, updated_at: now })
      .where('customer_id', '=', row!.customer_id)
      .execute()
    await markSessionVerified(tx, s.tokenHash, 'pin', now)
    await grantTrust(tx, { locationId, phone: s.phone, customerId: row!.customer_id, verifiedBy: 'pin', now })
    await audit.record(tx, {
      locationId,
      action: 'identity.pin.verified',
      entityType: 'customer',
      entityId: row!.customer_id,
      after: { phone: maskPhone(s.phone), linkId: s.link.id },
      ctx: { actor: ACTOR, requestId: o.requestId ?? null, ip: o.ip },
    })
    return { ok: true, session: await resolveSession(tx, o.session, now, { touch: false }) }
  })
  if (!out.ok) throw out.error
  return out.session
}

async function recordLock(
  tx: Tx,
  d: { newId: NewId; clock: Clock },
  o: { locationId: string; customerId: string; phone: string; level: number; ip: string | null; requestId?: string | null },
): Promise<void> {
  await audit.record(tx, {
    locationId: o.locationId,
    action: o.level >= 3 ? 'identity.pin.disabled' : 'identity.pin.locked',
    entityType: 'customer',
    entityId: o.customerId,
    after: { phone: maskPhone(o.phone), lockLevel: o.level },
    ctx: { actor: ACTOR, requestId: o.requestId ?? null, ip: o.ip },
  })
  if (o.level < 3) return
  const c = await liveCustomer(tx, o.customerId)
  await notifyManagers(
    tx,
    {
      locationId: o.locationId,
      kind: 'identity.pin_disabled',
      title: `Website PIN locked: ${c?.fullName ?? 'a client'}`,
      body:
        `Someone entered a wrong website PIN for ${c?.fullName ?? 'a client'} (${maskPhone(o.phone)}) too many times, so the PIN is ` +
        'disabled until the client resets it with a texted code. If the client did not try, someone else may have their link.',
      entityType: 'customer',
      entityId: o.customerId,
    },
    d,
  )
}

/** The client's verified code of this page (link_verify / pin_set, or pin_reset) confirmed within 10 minutes and after `since`. */
async function recentCodeOf(tx: Executor, s: SessionView, purposes: readonly string[], now: Date, since: Date | null): Promise<boolean> {
  const r = await tx
    .selectFrom('public_otp_challenges')
    .select('id')
    .where('link_session_hash', '=', s.tokenHash)
    .where('consumed_reason', '=', 'verified')
    .where('purpose', 'in', purposes as never)
    .where('consumed_at', '>=', new Date(now.getTime() - PIN_AFTER_CODE_MS))
    .$if(since !== null, (q) => q.where('consumed_at', '>', since!))
    .limit(1)
    .executeTakeFirst()
  return r !== undefined
}

function checkNewPin(pin: string, phone: string): void {
  const problem = pinProblem(pin, phone)
  if (problem) throw new AppError('IDENTITY_PIN_REJECTED', { params: { reason: problem }, errors: [{ path: 'body.pin', message: problem }] })
}

/** Re-binds the page's own link to the new PIN version (every other link of the client stays dead). */
async function rebindLink(tx: Tx, linkId: string, version: number): Promise<void> {
  await tx.updateTable('client_links').set({ pin_version: version }).where('id', '=', linkId).execute()
}

/**
 * Creates the client's first PIN (or one after a staff clear). 403 IDENTITY_CODE_REQUIRED without a code confirmed on this page in the
 * last 10 minutes, 409 IDENTITY_PIN_EXISTS when a PIN is set, 422 IDENTITY_PIN_REJECTED for a blocked PIN.
 */
export async function setSessionPin(
  d: IdentityDeps,
  o: { session: string; pin: string; ip: string | null; requestId?: string | null },
): Promise<SessionView> {
  const now = d.clock.now()
  return d.db.transaction().execute(async (tx) => {
    const s = await resolveSession(tx, o.session, now, { forUpdate: true })
    if (!s.customerId) throw new AppError('IDENTITY_UNKNOWN_CLIENT')
    const row = await tx.selectFrom('customer_pins').selectAll().where('customer_id', '=', s.customerId).forUpdate().executeTakeFirst()
    if (row?.pin_hash) throw new AppError('IDENTITY_PIN_EXISTS')
    if (!(await recentCodeOf(tx, s, ['link_verify', 'pin_set'], now, row?.cleared_at ?? null))) throw new AppError('IDENTITY_CODE_REQUIRED')
    checkNewPin(o.pin, s.phone)
    const hash = await d.pins.hash(s.customerId, o.pin)
    const version = (row?.version ?? 0) + 1
    if (row)
      await tx
        .updateTable('customer_pins')
        .set({ pin_hash: hash, version, failed_attempts: 0, lock_level: 0, locked_until: null, set_at: now, reset_hold_until: null, cleared_at: null, updated_at: now })
        .where('customer_id', '=', s.customerId)
        .execute()
    else
      await tx
        .insertInto('customer_pins')
        .values({ customer_id: s.customerId, pin_hash: hash, version, set_at: now, locked_until: null, reset_hold_until: null, cleared_at: null, updated_at: now })
        .execute()
    await rebindLink(tx, s.link.id, version)
    await revokeIdentity(tx, {
      locationId: s.link.locationId,
      customerId: s.customerId,
      reason: 'pin_set',
      now,
      trust: false,
      pendingActions: false,
      keepLinkId: s.link.id,
      keepSessionHash: s.tokenHash,
    })
    await markSessionVerified(tx, s.tokenHash, s.verifiedBy ?? 'code', now)
    await audit.record(tx, {
      locationId: s.link.locationId,
      action: 'identity.pin.set',
      entityType: 'customer',
      entityId: s.customerId,
      after: { phone: maskPhone(s.phone), version, linkId: s.link.id },
      ctx: { actor: ACTOR, requestId: o.requestId ?? null, ip: o.ip },
    })
    return resolveSession(tx, o.session, now, { touch: false })
  })
}

/**
 * Replaces a forgotten or disabled PIN after a pin_reset code confirmed on this page in the last 10 minutes (403
 * IDENTITY_CODE_REQUIRED otherwise, 409 IDENTITY_PIN_NOT_SET without a PIN). Every other link and session of the client and the
 * number's trust end; this page is verified by the code and the number trusted again; member privileges wait 72 hours; the client
 * gets an email (when one is on file) and the managers a notification.
 */
export async function resetSessionPin(
  d: IdentityDeps,
  o: { session: string; pin: string; ip: string | null; requestId?: string | null },
): Promise<SessionView & { resetHoldUntil: Date }> {
  const now = d.clock.now()
  return d.db.transaction().execute(async (tx) => {
    const s = await resolveSession(tx, o.session, now, { forUpdate: true })
    if (!s.customerId) throw new AppError('IDENTITY_UNKNOWN_CLIENT')
    const row = await tx.selectFrom('customer_pins').selectAll().where('customer_id', '=', s.customerId).forUpdate().executeTakeFirst()
    if (!row?.pin_hash) throw new AppError('IDENTITY_PIN_NOT_SET')
    if (!(await recentCodeOf(tx, s, ['pin_reset'], now, row.set_at))) throw new AppError('IDENTITY_CODE_REQUIRED')
    checkNewPin(o.pin, s.phone)
    const hash = await d.pins.hash(s.customerId, o.pin)
    const version = row.version + 1
    const holdUntil = new Date(now.getTime() + PIN_RESET_HOLD_MS)
    await tx
      .updateTable('customer_pins')
      .set({ pin_hash: hash, version, failed_attempts: 0, lock_level: 0, locked_until: null, set_at: now, reset_hold_until: holdUntil, updated_at: now })
      .where('customer_id', '=', s.customerId)
      .execute()
    await rebindLink(tx, s.link.id, version)
    await revokeIdentity(tx, {
      locationId: s.link.locationId,
      customerId: s.customerId,
      phone: s.phone,
      reason: 'pin_reset',
      now,
      keepLinkId: s.link.id,
      keepSessionHash: s.tokenHash,
    })
    await markSessionVerified(tx, s.tokenHash, 'code', now)
    await grantTrust(tx, { locationId: s.link.locationId, phone: s.phone, customerId: s.customerId, verifiedBy: 'code', now })
    await noticeReset(tx, d, { locationId: s.link.locationId, customerId: s.customerId, phone: s.phone, now, holdUntil })
    await audit.record(tx, {
      locationId: s.link.locationId,
      action: 'identity.pin.reset',
      entityType: 'customer',
      entityId: s.customerId,
      after: { phone: maskPhone(s.phone), version, linkId: s.link.id, holdUntil: holdUntil.toISOString() },
      ctx: { actor: ACTOR, requestId: o.requestId ?? null, ip: o.ip },
    })
    return { ...(await resolveSession(tx, o.session, now, { touch: false })), resetHoldUntil: holdUntil }
  })
}

async function noticeReset(
  tx: Tx,
  d: { newId: NewId; clock: Clock },
  o: { locationId: string; customerId: string; phone: string; now: Date; holdUntil: Date },
): Promise<void> {
  const c = await liveCustomer(tx, o.customerId)
  const tz = (await getLocation(tx, o.locationId))?.timezone ?? 'America/New_York'
  const label = (at: Date) => DateTime.fromJSDate(at, { zone: tz }).toFormat("ccc, LLL d 'at' h:mm a")
  if (c?.email && !c.emailBounced)
    await queueEmail(
      tx,
      {
        locationId: o.locationId,
        to: c.email,
        template: 'pin_reset_notice',
        vars: {
          customerName: c.fullName.trim().split(/\s+/)[0] ?? c.fullName,
          phoneLast4: o.phone.slice(-4),
          changedLabel: `on ${label(o.now)}`,
          holdLabel: label(o.holdUntil),
        },
        purpose: 'pin_reset_notice',
        customerId: o.customerId,
      },
      d,
    )
  await notifyManagers(
    tx,
    {
      locationId: o.locationId,
      kind: 'identity.pin_reset',
      title: `Website PIN reset: ${c?.fullName ?? 'a client'}`,
      body:
        `The website PIN of ${c?.fullName ?? 'a client'} (${maskPhone(o.phone)}) was reset with a texted code. Membership changes and ` +
        `payments through their links wait until ${label(o.holdUntil)}. If the client did not do this, clear the PIN and call them.`,
      entityType: 'customer',
      entityId: o.customerId,
    },
    d,
  )
}

/** When the client's member privileges come back after a PIN reset (null when there is no hold now). */
export async function memberPrivilegesHeldUntil(db: Executor, customerId: string, now: Date): Promise<Date | null> {
  const p = await pinStateOf(db, customerId)
  return p.resetHoldUntil && p.resetHoldUntil.getTime() > now.getTime() ? p.resetHoldUntil : null
}

/**
 * Staff "Clear PIN": the client has no PIN any more (they verify by code and may create a new one), and every link, session, the
 * trust and a pending in-chat action end. Returns false when there was no PIN (nothing changes then).
 */
export async function clearCustomerPin(
  tx: Tx,
  o: { locationId: string; customerId: string; now: Date; audit?: AuditContext },
): Promise<boolean> {
  const row = await tx.selectFrom('customer_pins').selectAll().where('customer_id', '=', o.customerId).forUpdate().executeTakeFirst()
  if (!row?.pin_hash) return false
  await tx
    .updateTable('customer_pins')
    .set({
      pin_hash: null,
      cleared_at: o.now,
      version: row.version + 1,
      failed_attempts: 0,
      lock_level: 0,
      locked_until: null,
      reset_hold_until: null,
      updated_at: o.now,
    })
    .where('customer_id', '=', o.customerId)
    .execute()
  const revoked = await revokeIdentity(tx, { locationId: o.locationId, customerId: o.customerId, reason: 'pin_cleared', now: o.now })
  await audit.record(tx, {
    locationId: o.locationId,
    action: 'identity.pin.cleared',
    entityType: 'customer',
    entityId: o.customerId,
    before: { pin: 'set', version: row.version, lockLevel: row.lock_level },
    after: { pin: 'none', version: row.version + 1, revoked: { ...revoked } },
    ctx: o.audit,
  })
  return true
}
