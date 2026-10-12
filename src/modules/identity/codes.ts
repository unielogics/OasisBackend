// Texted step-up codes for a link session (ADR 0160, design section 5). The code goes to the LINK's number and nowhere else: no
// function here takes a phone. It reuses the website's one-time code machinery (six digits, ten minutes, three tries, the salted
// hash of src/modules/public/otp.ts, one active code per number) with a purpose and the session that asked, and it counts against
// the same hourly ceiling (PUBLIC_OTP_TEXTS_PER_HOUR) under the same lock. Purposes: link_verify (verify the page; refused once a PIN
// exists, a PIN outranks a code), pin_set (verify, then choose a first PIN within 10 minutes) and pin_reset (the only use of a code
// once a PIN exists: it opens a 10-minute window to choose a new PIN, and verifies nothing by itself).
import { advisoryXactLock, type Executor } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import { ipLimitKey } from '../../platform/ip.js'
import { maskPhone } from '../../platform/phone.js'
import { safeEqual } from '../auth/tokens.js'
import { loadCustomerTarget, strangerRecipient } from '../messaging/db/recipients.js'
import { enforceLimits, type LimitRule } from '../public/limits.js'
import { codesSentWithin, hashCode, newCode, OTP_CODE_LENGTH, OTP_TTL_SEC, tellManagersCodesPaused } from '../public/otp.js'
import type { IdentityDeps } from './deps.js'
import type { OtpPurpose } from './schema.js'
import { ownerOf } from './common.js'
import { countSessionFailure, markSessionVerified, resolveSession, type SessionView } from './sessions.js'
import { staleRecord } from './stale.js'
import { grantTrust } from './trust.js'
import './problems.js'
import '../public/problems.js'
import './schema.js'

export type StepUpPurpose = Exclude<OtpPurpose, 'website'>

/** Code requests per client address, per session and per number (10 minutes each; the hourly ceiling is shared on top). */
export const LINK_CODE_LIMITS: Record<'ip' | 'session' | 'phone', LimitRule> = {
  ip: { max: 10, windowSec: 600 },
  session: { max: 3, windowSec: 600 },
  phone: { max: 5, windowSec: 600 },
}

/** How long a confirmed code lets the page choose a PIN. */
export const PIN_AFTER_CODE_MS = 10 * 60_000

const ACTOR = { name: 'Personal link' }

export interface PinState {
  /** A PIN is set (it may be locked or disabled). */
  set: boolean
  version: number
  lockLevel: number
  lockedUntil: Date | null
  setAt: Date | null
  resetHoldUntil: Date | null
}

/**
 * Whose PIN rules a page: its link's client, or, on a stranger's link (no client when it was issued), the live client who owns the
 * number now. A booking from a stranger's page lands on that client's record (upsertCustomerByPhone), so their PIN must outrank a
 * texted code there too, or a code to a recycled number would book onto (and un-hide) a PIN holder's record (W4c review).
 */
export async function pinOwnerOf(db: Executor, s: Pick<SessionView, 'customerId' | 'phone'>): Promise<string | null> {
  return s.customerId ?? (await ownerOf(db, s.phone)) ?? null
}

export async function pinStateOf(db: Executor, customerId: string | null): Promise<PinState> {
  const r = customerId ? await db.selectFrom('customer_pins').selectAll().where('customer_id', '=', customerId).executeTakeFirst() : undefined
  return {
    set: !!r?.pin_hash,
    version: r?.version ?? 0,
    lockLevel: r?.lock_level ?? 0,
    lockedUntil: r?.locked_until ?? null,
    setAt: r?.set_at ?? null,
    resetHoldUntil: r?.reset_hold_until ?? null,
  }
}

export interface CodeRequested {
  challengeId: string
  expiresInSec: number
  purpose: StepUpPurpose
}

/**
 * Texts a code to the session's link number. 409 IDENTITY_PIN_REQUIRED for link_verify once a PIN exists, IDENTITY_PIN_EXISTS for
 * pin_set, IDENTITY_PIN_NOT_SET for pin_reset without a PIN, IDENTITY_UNKNOWN_CLIENT for a PIN purpose on a stranger's link;
 * 429 PUBLIC_RATE_LIMITED / PUBLIC_CODES_PAUSED from the limits and the shared hourly ceiling.
 */
export async function requestStepUpCode(
  d: IdentityDeps,
  o: { session: string; purpose: StepUpPurpose; ip: string; requestId?: string | null },
): Promise<CodeRequested> {
  const now = d.clock.now()
  const s = await resolveSession(d.db, o.session, now)
  // a stranger's link (no client) whose number a client now owns: that client's PIN outranks a code as on their own link (W4c)
  const pin = await pinStateOf(d.db, await pinOwnerOf(d.db, s))
  if (o.purpose !== 'link_verify' && !s.customerId) throw new AppError('IDENTITY_UNKNOWN_CLIENT')
  if (o.purpose === 'link_verify' && pin.set) throw new AppError('IDENTITY_PIN_REQUIRED')
  if (o.purpose === 'pin_set' && pin.set) throw new AppError('IDENTITY_PIN_EXISTS')
  if (o.purpose === 'pin_reset' && !pin.set) throw new AppError('IDENTITY_PIN_NOT_SET')
  // a code proves the number, not the client: on a record the stale-record rule holds it never sets or resets the PIN (W4c fixes)
  if (o.purpose !== 'link_verify' && s.customerId && (await staleRecord(d.db, { locationId: s.link.locationId, customerId: s.customerId, phone: s.phone, now })).stale)
    throw new AppError('IDENTITY_RECORD_UNCONFIRMED')
  await enforceLimits(d.db, d.clock, [
    { key: `link_code:ip:${ipLimitKey(o.ip)}`, rule: LINK_CODE_LIMITS.ip },
    { key: `link_code:session:${s.tokenHash}`, rule: LINK_CODE_LIMITS.session },
    { key: `link_code:phone:${s.phone}`, rule: LINK_CODE_LIMITS.phone },
  ])
  const locationId = s.link.locationId
  const phone = s.phone
  const id = d.newId()
  const code = newCode()
  const paused = await d.db.transaction().execute(async (tx): Promise<{ sent: number; retryAfterSec: number } | null> => {
    // the website's codes take the same lock and count the same rows: one ceiling for both
    await advisoryXactLock(tx, `public-otp-cap:${locationId}`)
    const recent = await codesSentWithin(tx, locationId, now)
    if (recent.sent >= d.otpTextsPerHour) return recent
    await advisoryXactLock(tx, `public-otp:${locationId}:${phone}`)
    await tx
      .updateTable('public_otp_challenges')
      .set({ consumed_at: now, consumed_reason: 'superseded' })
      .where('location_id', '=', locationId)
      .where('phone_e164', '=', phone)
      .where('consumed_at', 'is', null)
      .execute()
    const target = s.customerId ? await loadCustomerTarget(tx, locationId, s.customerId) : null
    const recipient = target ? { ...target.recipient, phone } : await strangerRecipient(tx, locationId, phone)
    const out = await d.queue.enqueueFor(tx, {
      locationId,
      // not on the client's thread: the code is the person's, not a conversation with the shop
      customerId: null,
      recipient,
      appointmentId: null,
      templateKey: 'otp_code',
      vars: { code },
      purpose: 'otp',
      senderKind: 'system',
    })
    await tx
      .insertInto('public_otp_challenges')
      .values({
        id,
        location_id: locationId,
        phone_e164: phone,
        code_hash: hashCode(id, code),
        expires_at: new Date(now.getTime() + OTP_TTL_SEC * 1000),
        consumed_at: null,
        consumed_reason: null,
        requested_ip: o.ip,
        delivery: out.queued ? 'queued' : out.skipped,
        created_at: now,
        purpose: o.purpose,
        link_session_hash: s.tokenHash,
      })
      .execute()
    await audit.record(tx, {
      locationId,
      action: 'identity.code.requested',
      entityType: 'customer',
      entityId: s.customerId,
      after: { phone: maskPhone(phone), purpose: o.purpose, linkId: s.link.id, delivery: out.queued ? 'queued' : out.skipped },
      ctx: { actor: ACTOR, requestId: o.requestId ?? null, ip: o.ip },
    })
    return null
  })
  if (paused) {
    await tellManagersCodesPaused(
      { app: { db: d.db, clock: d.clock, newId: d.newId, log: d.log, env: { PUBLIC_OTP_TEXTS_PER_HOUR: d.otpTextsPerHour } } },
      { id: locationId },
      paused.sent,
    )
    throw new AppError('PUBLIC_CODES_PAUSED', {
      params: { minutes: Math.max(1, Math.ceil(paused.retryAfterSec / 60)) },
      headers: { 'Retry-After': String(paused.retryAfterSec) },
    })
  }
  return { challengeId: id, expiresInSec: OTP_TTL_SEC, purpose: o.purpose }
}

export interface CodeConfirmed {
  purpose: StepUpPurpose
  session: SessionView
  /** True when the page is now verified (link_verify, pin_set); a pin_reset code only opens the 10-minute window to choose a PIN. */
  verified: boolean
}

type Outcome = { ok: true; value: CodeConfirmed } | { ok: false; error: AppError }

/**
 * Checks a code the session asked for (a code another session or the website asked for is unknown here). Wrong: the code's three
 * tries and the session's five both count, and 401 PUBLIC_OTP_INVALID / 429 PUBLIC_OTP_LOCKED / 429 IDENTITY_SESSION_LOCKED.
 * Right, for link_verify / pin_set: the page is verified by code and the number trusted 30 days (a client's link). If a PIN was set
 * meanwhile the code verifies nothing (409 IDENTITY_PIN_REQUIRED).
 */
export async function confirmStepUpCode(
  d: IdentityDeps,
  o: { session: string; challengeId: string; code: string; ip: string; requestId?: string | null },
): Promise<CodeConfirmed> {
  const now = d.clock.now()
  const code = o.code.replace(/\D/g, '')
  const out = await d.db.transaction().execute(async (tx): Promise<Outcome> => {
    let s: SessionView
    try {
      s = await resolveSession(tx, o.session, now, { forUpdate: true })
    } catch (e) {
      return { ok: false, error: e as AppError }
    }
    const row = await tx
      .selectFrom('public_otp_challenges')
      .selectAll()
      .where('id', '=', o.challengeId)
      .where('location_id', '=', s.link.locationId)
      .where('link_session_hash', '=', s.tokenHash)
      .forUpdate()
      .executeTakeFirst()
    if (!row || row.purpose === 'website') return { ok: false, error: new AppError('PUBLIC_OTP_EXPIRED') }
    if (row.consumed_at !== null)
      return { ok: false, error: new AppError(row.consumed_reason === 'locked' ? 'PUBLIC_OTP_LOCKED' : 'PUBLIC_OTP_EXPIRED') }
    if (row.expires_at.getTime() <= now.getTime()) return { ok: false, error: new AppError('PUBLIC_OTP_EXPIRED') }
    const purpose = row.purpose as StepUpPurpose
    if (code.length !== OTP_CODE_LENGTH || !safeEqual(hashCode(row.id, code), row.code_hash)) {
      const attempts = row.attempts + 1
      const locked = attempts >= row.max_attempts
      await tx
        .updateTable('public_otp_challenges')
        .set({ attempts, ...(locked ? { consumed_at: now, consumed_reason: 'locked' as const } : {}) })
        .where('id', '=', row.id)
        .execute()
      const sessionLeft = await countSessionFailure(tx, s.tokenHash, now)
      if (sessionLeft === 0) return { ok: false, error: new AppError('IDENTITY_SESSION_LOCKED') }
      if (locked) return { ok: false, error: new AppError('PUBLIC_OTP_LOCKED') }
      const left = Math.min(row.max_attempts - attempts, sessionLeft)
      return {
        ok: false,
        error: new AppError('PUBLIC_OTP_INVALID', { params: { left, tries: left === 1 ? 'try' : 'tries' }, meta: { attemptsLeft: left } }),
      }
    }
    await tx
      .updateTable('public_otp_challenges')
      .set({ consumed_at: now, consumed_reason: 'verified', attempts: row.attempts + 1 })
      .where('id', '=', row.id)
      .execute()
    let verified = false
    if (purpose !== 'pin_reset') {
      // a PIN outranks a code: one set since the code was asked for leaves the page unverified
      if ((await pinStateOf(tx, await pinOwnerOf(tx, s))).set) return { ok: false, error: new AppError('IDENTITY_PIN_REQUIRED') }
      await markSessionVerified(tx, s.tokenHash, 'code', now)
      if (s.customerId) await grantTrust(tx, { locationId: s.link.locationId, phone: s.phone, customerId: s.customerId, verifiedBy: 'code', now })
      verified = true
    }
    await audit.record(tx, {
      locationId: s.link.locationId,
      action: 'identity.code.verified',
      entityType: 'customer',
      entityId: s.customerId,
      after: { phone: maskPhone(s.phone), purpose, linkId: s.link.id },
      ctx: { actor: ACTOR, requestId: o.requestId ?? null, ip: o.ip },
    })
    const fresh = await resolveSession(tx, o.session, now, { touch: false })
    return { ok: true, value: { purpose, session: fresh, verified } }
  })
  if (!out.ok) throw out.error
  return out.value
}
