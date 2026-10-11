// In-chat actions waiting for their reply number (ADR 0160, design sections 0, 3 and 4). Inside the 30-day trust the assistant may
// book, reschedule or cancel by text, but each action runs only after the client replies with a 4-digit number the server texted
// ("Signature Wash, Sat 10:00 AM. Reply 4821 to confirm"; class action_confirm, the number as a secretVar). The model never sees the
// number; only its salted SHA-256 is stored. One pending action per number (a new proposal supersedes the old one); 15 minutes;
// 3 wrong replies lock it, and a number gets at most PENDING_ACTION_WRONG_PER_DAY wrong replies across all its actions in 24 hours
// (a new or superseding proposal never brings fresh guesses: W4c review). The confirmation re-checks the trust, then hands the
// stored payload back for the caller to execute.
import { randomInt } from 'node:crypto'
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import type { JsonValue } from '../../platform/schema.js'
import { safeEqual } from '../auth/tokens.js'
import { hashCode } from '../public/otp.js'
import type { PendingActionKind } from './schema.js'
import { evaluateTrust } from './trust.js'
import './problems.js'
import './schema.js'

export const REPLY_CODE_LENGTH = 4
export const PENDING_ACTION_TTL_MS = 15 * 60_000
export const PENDING_ACTION_MAX_ATTEMPTS = 3
/**
 * Wrong reply numbers one number may send in 24 hours, across every action proposed to it (W4c review). Without it a sender spoofing
 * a trusted number could have the assistant propose again and again (each proposal supersedes the last and brings 3 fresh tries) and
 * walk the 10,000 reply numbers; with it a number gets this many guesses a day, then no proposal until the day has passed.
 */
export const PENDING_ACTION_WRONG_PER_DAY = 5
const DAY_MS = 86_400_000

/** Wrong reply numbers the number sent in the last 24 hours (a confirmed action's attempts include its one right reply). */
export async function wrongRepliesToday(db: Executor, o: { locationId: string; phone: string; now: Date }): Promise<number> {
  const r = await db
    .selectFrom('assistant_pending_actions')
    .select(sql<number>`coalesce(sum(attempts - case when state in ('executed', 'failed') then 1 else 0 end), 0)::int`.as('n'))
    .where('location_id', '=', o.locationId)
    .where('phone_e164', '=', o.phone)
    .where('created_at', '>', new Date(o.now.getTime() - DAY_MS))
    .executeTakeFirstOrThrow()
  return Number(r.n)
}

export const newReplyCode = (): string => String(randomInt(0, 10 ** REPLY_CODE_LENGTH)).padStart(REPLY_CODE_LENGTH, '0')

export interface ProposedAction {
  id: string
  /** The reply number: text it (secretVars) and forget it. Never stored, never given to the model. */
  code: string
  expiresAt: Date
}

/**
 * Records a proposal and returns its reply number. Refused (403 IDENTITY_NOT_TRUSTED) unless the number's trust is live for this
 * client right now: the assistant's own check is not the only one. A pending action of the number is superseded.
 */
export async function createPendingAction(
  tx: Tx,
  deps: { newId: NewId; now: Date },
  o: {
    locationId: string
    conversationId: string
    customerId: string
    phone: string
    kind: PendingActionKind
    payload: { [key: string]: JsonValue }
  },
): Promise<ProposedAction> {
  const { now } = deps
  const trust = await evaluateTrust(tx, { locationId: o.locationId, phone: o.phone, customerId: o.customerId, now })
  if (!trust.trusted) throw new AppError('IDENTITY_NOT_TRUSTED', { meta: { reason: trust.reason } })
  // the number used up its wrong replies for the day: no new reply number to guess (the assistant hands over to staff)
  if ((await wrongRepliesToday(tx, { locationId: o.locationId, phone: o.phone, now })) >= PENDING_ACTION_WRONG_PER_DAY)
    throw new AppError('IDENTITY_TOO_MANY_TRIES', { params: { minutes: 24 * 60 }, meta: { limit: 'reply_numbers_day' } })
  await tx
    .updateTable('assistant_pending_actions')
    .set({ state: 'superseded', resolved_at: now })
    .where('location_id', '=', o.locationId)
    .where('phone_e164', '=', o.phone)
    .where('state', '=', 'pending')
    .execute()
  const id = deps.newId()
  const code = newReplyCode()
  const expiresAt = new Date(now.getTime() + PENDING_ACTION_TTL_MS)
  await tx
    .insertInto('assistant_pending_actions')
    .values({
      id,
      location_id: o.locationId,
      conversation_id: o.conversationId,
      customer_id: o.customerId,
      phone_e164: o.phone,
      kind: o.kind,
      payload: JSON.stringify(o.payload) as never,
      code_hash: hashCode(id, code),
      max_attempts: PENDING_ACTION_MAX_ATTEMPTS,
      expires_at: expiresAt,
      confirm_message_id: null,
      appointment_id: null,
      error: null,
      created_at: now,
      resolved_at: null,
    })
    .execute()
  return { id, code, expiresAt }
}

/** Links the confirmation text to its action (the message row shows the number masked). */
export async function attachConfirmMessage(tx: Tx, actionId: string, messageId: string): Promise<void> {
  await tx.updateTable('assistant_pending_actions').set({ confirm_message_id: messageId }).where('id', '=', actionId).execute()
}

export interface PendingActionSummary {
  id: string
  kind: PendingActionKind
  customerId: string
  conversationId: string
  expiresAt: Date
  attemptsLeft: number
}

/** The number's live pending action (the router asks before treating a digits-only text as a reply number). */
export async function findPendingAction(db: Executor, o: { locationId: string; phone: string; now: Date }): Promise<PendingActionSummary | null> {
  const r = await db
    .selectFrom('assistant_pending_actions')
    .select(['id', 'kind', 'customer_id', 'conversation_id', 'expires_at', 'attempts', 'max_attempts'])
    .where('location_id', '=', o.locationId)
    .where('phone_e164', '=', o.phone)
    .where('state', '=', 'pending')
    .where('expires_at', '>', o.now)
    .executeTakeFirst()
  return r
    ? { id: r.id, kind: r.kind, customerId: r.customer_id, conversationId: r.conversation_id, expiresAt: r.expires_at, attemptsLeft: r.max_attempts - r.attempts }
    : null
}

export interface ConfirmedAction {
  id: string
  kind: PendingActionKind
  customerId: string
  conversationId: string
  payload: { [key: string]: JsonValue }
}

export type ConfirmOutcome =
  | { status: 'none' }
  | { status: 'expired' }
  | { status: 'wrong'; attemptsLeft: number }
  | { status: 'locked' }
  | { status: 'untrusted' }
  | { status: 'confirmed'; action: ConfirmedAction }

/**
 * Checks a reply number from the number's own text, in the caller's transaction (the attempt counter is written either way: commit
 * it). On the right number the action is claimed (state executed) and its payload returned; the caller executes it in the same
 * transaction and then calls completePendingAction, or failPendingAction when the execution was refused. The trust is checked
 * again here: a STOP, a phone change or a revoke after the proposal cancels it.
 */
export async function confirmPendingAction(tx: Tx, o: { locationId: string; phone: string; code: string; now: Date }): Promise<ConfirmOutcome> {
  const row = await tx
    .selectFrom('assistant_pending_actions')
    .selectAll()
    .where('location_id', '=', o.locationId)
    .where('phone_e164', '=', o.phone)
    .where('state', '=', 'pending')
    .forUpdate()
    .executeTakeFirst()
  if (!row) return { status: 'none' }
  if (row.expires_at.getTime() <= o.now.getTime()) {
    await tx.updateTable('assistant_pending_actions').set({ state: 'expired', resolved_at: o.now }).where('id', '=', row.id).execute()
    return { status: 'expired' }
  }
  const code = o.code.replace(/\D/g, '')
  if (code.length !== REPLY_CODE_LENGTH || !safeEqual(hashCode(row.id, code), row.code_hash)) {
    const attempts = row.attempts + 1
    // this wrong reply is the number's last one of the day: the action locks whatever tries it had left
    const dayUsed = (await wrongRepliesToday(tx, { locationId: o.locationId, phone: o.phone, now: o.now })) + 1 >= PENDING_ACTION_WRONG_PER_DAY
    const locked = attempts >= row.max_attempts || dayUsed
    await tx
      .updateTable('assistant_pending_actions')
      .set({ attempts, ...(locked ? { state: 'locked' as const, resolved_at: o.now } : {}) })
      .where('id', '=', row.id)
      .execute()
    return locked ? { status: 'locked' } : { status: 'wrong', attemptsLeft: row.max_attempts - attempts }
  }
  const trust = await evaluateTrust(tx, { locationId: o.locationId, phone: o.phone, customerId: row.customer_id, now: o.now })
  if (!trust.trusted) {
    await tx
      .updateTable('assistant_pending_actions')
      .set({ state: 'canceled', resolved_at: o.now, error: `trust ended: ${trust.reason ?? 'unknown'}` })
      .where('id', '=', row.id)
      .execute()
    return { status: 'untrusted' }
  }
  await tx
    .updateTable('assistant_pending_actions')
    .set({ state: 'executed', resolved_at: o.now, attempts: row.attempts + 1 })
    .where('id', '=', row.id)
    .execute()
  return {
    status: 'confirmed',
    action: {
      id: row.id,
      kind: row.kind,
      customerId: row.customer_id,
      conversationId: row.conversation_id,
      payload: row.payload as { [key: string]: JsonValue },
    },
  }
}

/** Records the appointment the confirmed action booked, moved or canceled. */
export async function completePendingAction(tx: Tx, actionId: string, o: { appointmentId: string | null }): Promise<void> {
  await tx.updateTable('assistant_pending_actions').set({ appointment_id: o.appointmentId }).where('id', '=', actionId).execute()
}

/** The confirmed action could not run (the slot was taken meanwhile, ...): state failed with the reason. */
export async function failPendingAction(tx: Tx, actionId: string, o: { error: string; now: Date }): Promise<void> {
  await tx
    .updateTable('assistant_pending_actions')
    .set({ state: 'failed', error: o.error.slice(0, 2000), resolved_at: o.now })
    .where('id', '=', actionId)
    .execute()
}

/** Cancels the pending actions of a client and/or a number (a revocation, a handoff). Returns how many. */
export async function cancelPendingActions(
  tx: Tx,
  o: { locationId?: string; customerId?: string | null; phone?: string | null; now?: Date; error?: string },
): Promise<number> {
  if (!o.customerId && !o.phone) return 0
  const at = o.now ?? sql<Date>`app_now()`
  const r = await tx
    .updateTable('assistant_pending_actions')
    .set({ state: 'canceled', resolved_at: at, error: o.error?.slice(0, 2000) ?? null })
    .where('state', '=', 'pending')
    .$if(o.locationId !== undefined, (q) => q.where('location_id', '=', o.locationId!))
    .where((eb) =>
      eb.or([
        ...(o.customerId ? [eb('customer_id', '=', o.customerId)] : []),
        ...(o.phone ? [eb('phone_e164', '=', o.phone)] : []),
      ]),
    )
    .executeTakeFirst()
  return Number(r.numUpdatedRows)
}

/** Pending actions past their 15 minutes become expired (maintenance; confirmPendingAction also expires on read). */
export async function expirePendingActions(db: Executor, now: Date): Promise<number> {
  const r = await db
    .updateTable('assistant_pending_actions')
    .set({ state: 'expired', resolved_at: now })
    .where('state', '=', 'pending')
    .where('expires_at', '<=', now)
    .executeTakeFirst()
  return Number(r.numUpdatedRows)
}
