// Member identification by phone and one-time SMS code (ADR 0150). A code is six digits, lives ten minutes, allows three tries and
// is the only active one for its number; the table holds its salted hash. A verified code issues an opaque member token (30
// minutes, hashed at rest, bound to the number and to the customer who owned it at that moment). The SMS goes through the
// messaging queue like every other text (class otp_code: transactional, consent-exempt, never held; suppressed outside production
// for a number that is not on the allowlist, which is the usual rule).
import { createHash, randomInt } from 'node:crypto'
import { advisoryXactLock, type Db, type Executor, type Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import { maskPhone, normalizeTextableNanp } from '../../platform/phone.js'
import { hashToken, newToken, safeEqual } from '../auth/tokens.js'
import { findCustomerByPhone, type CustomerRecord } from '../customers/service.js'
import { loadCustomerTarget, strangerRecipient } from '../messaging/db/recipients.js'
import type { SmsRecipient } from '../messaging/policy/canSend.js'
import type { PublicDeps, PublicLocation, PublicRequest } from './deps.js'
import { enforceLimits, PUBLIC_LIMITS, publicLimitChecks } from './limits.js'
import { memberView, type MemberView } from './members.js'
import { notifyManagers } from '../messaging/notify.js'
import './problems.js'
import './schema.js'

export const OTP_TTL_SEC = 600
export const OTP_MAX_ATTEMPTS = 3
export const OTP_CODE_LENGTH = 6
export const MEMBER_TOKEN_TTL_SEC = 30 * 60

/** sha256(challengeId:code): the challenge id salts the hash, so equal codes never hash alike. */
export const hashCode = (challengeId: string, code: string): string =>
  createHash('sha256').update(`${challengeId}:${code}`).digest('hex')

export const newCode = (): string => String(randomInt(0, 10 ** OTP_CODE_LENGTH)).padStart(OTP_CODE_LENGTH, '0')

const badPhone = (message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path: 'body.phone', message }] })

/** The E.164 form of a number the website may text (US or Canada, able to take a text, not premium or toll free); 422 otherwise. */
export const phoneOrThrow = (raw: string): string => {
  const p = normalizeTextableNanp(raw)
  if (p.ok) return p.e164
  throw badPhone(p.reason === 'invalid' ? 'Enter a valid mobile number.' : 'We can text US and Canadian mobile numbers only.')
}

export interface OtpRequested {
  challengeId: string
  expiresInSec: number
}

/** The customer owning the number as the SMS policy sees them, or a bare number for a stranger. */
async function recipientFor(db: Executor, locationId: string, phone: string): Promise<{ customer: CustomerRecord | undefined; recipient: SmsRecipient }> {
  const customer = await findCustomerByPhone(db, phone)
  if (customer) {
    const t = await loadCustomerTarget(db, locationId, customer.id)
    if (t) return { customer, recipient: t.recipient }
  }
  return { customer, recipient: await strangerRecipient(db, locationId, phone) }
}

export async function requestOtp(
  d: PublicDeps,
  loc: PublicLocation,
  r: PublicRequest,
  input: { phone: string },
): Promise<OtpRequested> {
  const phone = phoneOrThrow(input.phone)
  const { db, clock, newId } = d.app
  await enforceLimits(db, clock, publicLimitChecks('otpRequest', r.ip, phone))
  const now = clock.now()
  const id = newId()
  const code = newCode()
  const cap = d.app.env.PUBLIC_OTP_TEXTS_PER_HOUR
  const paused = await db.transaction().execute(async (tx): Promise<{ sent: number; retryAfterSec: number } | null> => {
    // every code request takes the same lock first, so the count and the new row are one decision across processes
    await advisoryXactLock(tx, `public-otp-cap:${loc.id}`)
    const recent = await codesSentWithin(tx, loc.id, now)
    if (recent.sent >= cap) return { sent: recent.sent, retryAfterSec: recent.retryAfterSec }
    await advisoryXactLock(tx, `public-otp:${loc.id}:${phone}`)
    await tx
      .updateTable('public_otp_challenges')
      .set({ consumed_at: now, consumed_reason: 'superseded' })
      .where('location_id', '=', loc.id)
      .where('phone_e164', '=', phone)
      .where('consumed_at', 'is', null)
      .execute()
    const { recipient } = await recipientFor(tx, loc.id, phone)
    const out = await d.queue.enqueueFor(tx, {
      locationId: loc.id,
      // not attached to the customer's thread: the code is the person's, not a conversation with the shop
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
        location_id: loc.id,
        phone_e164: phone,
        code_hash: hashCode(id, code),
        expires_at: new Date(now.getTime() + OTP_TTL_SEC * 1000),
        consumed_at: null,
        consumed_reason: null,
        requested_ip: r.ip,
        delivery: out.queued ? 'queued' : out.skipped,
        created_at: now,
      })
      .execute()
    await audit.record(tx, {
      locationId: loc.id,
      action: 'public.otp.requested',
      entityType: 'otp_challenge',
      entityId: id,
      after: { phone: maskPhone(phone), delivery: out.queued ? 'queued' : out.skipped },
      ctx: { actor: { name: 'Website' }, requestId: r.requestId, ip: r.ip },
    })
    return null
  })
  if (paused) {
    await tellManagersCodesPaused(d, loc, paused.sent)
    throw new AppError('PUBLIC_CODES_PAUSED', {
      params: { minutes: Math.max(1, Math.ceil(paused.retryAfterSec / 60)) },
      headers: { 'Retry-After': String(paused.retryAfterSec) },
    })
  }
  return { challengeId: id, expiresInSec: OTP_TTL_SEC }
}

const HOUR_MS = 3_600_000

/**
 * The website's codes actually handed to the queue in the hour before `now` (a code suppressed by the policy costs the tablet
 * nothing), and when the oldest of them leaves that hour.
 */
async function codesSentWithin(tx: Tx, locationId: string, now: Date): Promise<{ sent: number; retryAfterSec: number }> {
  const r = await tx
    .selectFrom('public_otp_challenges')
    .select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.min('created_at').as('oldest')])
    .where('location_id', '=', locationId)
    .where('delivery', '=', 'queued')
    .where('created_at', '>', new Date(now.getTime() - HOUR_MS))
    .executeTakeFirstOrThrow()
  const oldest = r.oldest ? new Date(r.oldest as unknown as string | Date) : now
  return { sent: Number(r.n), retryAfterSec: Math.max(1, Math.ceil((oldest.getTime() + HOUR_MS - now.getTime()) / 1000)) }
}

/** One notification per manager when the ceiling is reached, at most once an hour (its own transaction: the refusal rolls back). */
async function tellManagersCodesPaused(d: PublicDeps, loc: PublicLocation, sent: number): Promise<void> {
  const { db, clock, newId } = d.app
  const now = clock.now()
  d.app.log.warn({ sent, cap: d.app.env.PUBLIC_OTP_TEXTS_PER_HOUR }, 'public one-time codes paused: hourly ceiling reached')
  await db.transaction().execute(async (tx) => {
    await advisoryXactLock(tx, `public-otp-cap-notice:${loc.id}`)
    const told = await tx
      .selectFrom('notifications')
      .select('id')
      .where('location_id', '=', loc.id)
      .where('kind', '=', 'public.otp_cap_reached')
      .where('created_at', '>', new Date(now.getTime() - HOUR_MS))
      .limit(1)
      .executeTakeFirst()
    if (told) return
    await notifyManagers(
      tx,
      {
        locationId: loc.id,
        kind: 'public.otp_cap_reached',
        title: `Website codes paused: ${sent} sent in the last hour`,
        body:
          `The website texted ${sent} one-time codes within an hour, its ceiling (PUBLIC_OTP_TEXTS_PER_HOUR), so new code requests are ` +
          'refused until the oldest leaves the hour. The ceiling keeps the tablet’s sending budget for the shop’s own texts. If this is ' +
          'not a busy hour, someone may be abusing the website’s form.',
        entityType: null,
        entityId: null,
      },
      { newId, clock },
    )
  })
}

export interface OtpVerified {
  memberToken: string
  expiresInSec: number
  member: MemberView
}

type VerifyOutcome =
  | { ok: true; token: string; member: MemberView }
  | { ok: false; error: AppError }

export async function verifyOtp(
  d: PublicDeps,
  loc: PublicLocation,
  r: PublicRequest,
  input: { challengeId: string; code: string },
): Promise<OtpVerified> {
  const { db, clock } = d.app
  await enforceLimits(db, clock, [{ key: `otp_verify:ip:${r.ip}`, rule: PUBLIC_LIMITS.otpVerify.ip }])
  const now = clock.now()
  const code = input.code.replace(/\D/g, '')
  // the attempt counter must survive a wrong code, so the outcome is decided inside the transaction and thrown after it
  const out = await db.transaction().execute(async (tx): Promise<VerifyOutcome> => {
    const row = await tx
      .selectFrom('public_otp_challenges')
      .selectAll()
      .where('id', '=', input.challengeId)
      .where('location_id', '=', loc.id)
      .forUpdate()
      .executeTakeFirst()
    if (!row) return { ok: false, error: new AppError('PUBLIC_OTP_EXPIRED') }
    if (row.consumed_at !== null)
      return { ok: false, error: new AppError(row.consumed_reason === 'locked' ? 'PUBLIC_OTP_LOCKED' : 'PUBLIC_OTP_EXPIRED') }
    if (row.expires_at.getTime() <= now.getTime()) return { ok: false, error: new AppError('PUBLIC_OTP_EXPIRED') }
    if (code.length !== OTP_CODE_LENGTH || !safeEqual(hashCode(row.id, code), row.code_hash)) {
      const attempts = row.attempts + 1
      const locked = attempts >= row.max_attempts
      await tx
        .updateTable('public_otp_challenges')
        .set({ attempts, ...(locked ? { consumed_at: now, consumed_reason: 'locked' as const } : {}) })
        .where('id', '=', row.id)
        .execute()
      if (locked) {
        await audit.record(tx, {
          locationId: loc.id,
          action: 'public.otp.locked',
          entityType: 'otp_challenge',
          entityId: row.id,
          after: { phone: maskPhone(row.phone_e164), attempts },
          ctx: { actor: { name: 'Website' }, requestId: r.requestId, ip: r.ip },
        })
        return { ok: false, error: new AppError('PUBLIC_OTP_LOCKED') }
      }
      const left = row.max_attempts - attempts
      return {
        ok: false,
        error: new AppError('PUBLIC_OTP_INVALID', {
          params: { left, tries: left === 1 ? 'try' : 'tries' },
          meta: { attemptsLeft: left },
        }),
      }
    }
    await tx
      .updateTable('public_otp_challenges')
      .set({ consumed_at: now, consumed_reason: 'verified', attempts: row.attempts + 1 })
      .where('id', '=', row.id)
      .execute()
    const customer = await findCustomerByPhone(tx, row.phone_e164)
    const token = newToken()
    await tx
      .insertInto('public_member_tokens')
      .values({
        token_hash: hashToken(token),
        location_id: loc.id,
        phone_e164: row.phone_e164,
        customer_id: customer?.id ?? null,
        challenge_id: row.id,
        expires_at: new Date(now.getTime() + MEMBER_TOKEN_TTL_SEC * 1000),
        last_used_at: null,
        created_at: now,
      })
      .execute()
    await audit.record(tx, {
      locationId: loc.id,
      action: 'public.otp.verified',
      entityType: 'customer',
      entityId: customer?.id ?? null,
      after: { phone: maskPhone(row.phone_e164), known: customer !== undefined },
      ctx: { actor: { name: 'Website' }, requestId: r.requestId, ip: r.ip },
    })
    return { ok: true, token, member: await memberView(tx, loc.id, customer) }
  })
  if (!out.ok) throw out.error
  return { memberToken: out.token, expiresInSec: MEMBER_TOKEN_TTL_SEC, member: out.member }
}

export interface ResolvedToken {
  phoneE164: string
  customerId: string | null
}

/** The number (and customer) a member token stands for; 401 PUBLIC_TOKEN_INVALID when unknown or expired. Touches last_used_at. */
export async function resolveMemberToken(db: Executor, loc: PublicLocation, token: string, now: Date): Promise<ResolvedToken> {
  const row = await db
    .selectFrom('public_member_tokens')
    .select(['token_hash', 'phone_e164', 'customer_id', 'expires_at'])
    .where('token_hash', '=', hashToken(token))
    .where('location_id', '=', loc.id)
    .executeTakeFirst()
  if (!row || row.expires_at.getTime() <= now.getTime()) throw new AppError('PUBLIC_TOKEN_INVALID')
  await db.updateTable('public_member_tokens').set({ last_used_at: now }).where('token_hash', '=', row.token_hash).execute()
  return { phoneE164: row.phone_e164, customerId: row.customer_id }
}

/** Challenges and tokens more than a day past their expiry are of no use to anyone (maintenance.purge). */
export async function purgeOtpRows(db: Db | Tx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - 86_400_000)
  const a = await db.deleteFrom('public_member_tokens').where('expires_at', '<', cutoff).executeTakeFirst()
  const b = await db.deleteFrom('public_otp_challenges').where('expires_at', '<', cutoff).executeTakeFirst()
  return Number(a.numDeletedRows) + Number(b.numDeletedRows)
}
