// Link sessions (ADR 0160, design section 5). The page exchanges the link's token (POST, body only) for a bearer session token held
// in memory: 15 minutes idle, 1 hour at most, re-exchange allowed while the link lives (verify and PIN links: 5 exchanges). Only the
// session token's SHA-256 is stored. A session starts at trust 'link' (holding the link proves access to the number's texts), or
// 'verified' when the number's 30-day trust is live for the link's client; a PIN or texted code entered on the page makes it
// 'verified' and stamps step_up_at (memberships and payments need a step-up of at most 5 minutes). Five wrong PINs or codes end it.
// A session dies with its link: a revocation, the client's PIN or phone change and an epoch bump all end it at its next request.
import { sql, type Selectable } from 'kysely'
import type { Db, Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { hashToken, newToken, TOKEN_SHAPE } from '../auth/tokens.js'
import { LINK_POLICY, linkDeadReason, linkView, resolveLink, type LinkDeadReason, type LinkView } from './links.js'
import type { ClientLinkSessionsTable, LinkSessionTrust, VerifiedBy } from './schema.js'
import { evaluateTrust, type TrustState } from './trust.js'
import './problems.js'
import './schema.js'

export const SESSION_IDLE_MS = 15 * 60_000
export const SESSION_MAX_MS = 60 * 60_000
/** Wrong PINs and codes a session survives: the fifth ends it. */
export const SESSION_MAX_FAILURES = 5
/** A membership or payment needs a PIN or code entered this recently. */
export const STEP_UP_MAX_AGE_MS = 5 * 60_000

export type SessionRow = Selectable<ClientLinkSessionsTable>

export interface SessionView {
  /** sha256 of the session token: the key the code rows name (never the token). */
  tokenHash: string
  link: LinkView
  customerId: string | null
  phone: string
  trust: LinkSessionTrust
  verifiedBy: VerifiedBy | null
  stepUpAt: Date | null
  failedAttempts: number
  idleExpiresAt: Date
  expiresAt: Date
}

const view = (s: SessionRow, link: LinkView): SessionView => ({
  tokenHash: s.token_hash,
  link,
  customerId: s.customer_id,
  phone: s.phone_e164,
  trust: s.trust,
  verifiedBy: s.verified_by,
  stepUpAt: s.step_up_at,
  failedAttempts: s.failed_attempts,
  idleExpiresAt: s.idle_expires_at,
  expiresAt: s.expires_at,
})

export interface Exchanged {
  /** The bearer token for the page's memory: returned once, never stored. */
  session: string
  view: SessionView
  /** The number's 30-day trust for the link's client (none for a stranger's link). */
  numberTrust: TrustState | null
}

/**
 * Exchanges a link token for a new session (its own transaction: the link row is locked so concurrent exchanges count right). 401
 * IDENTITY_LINK_INVALID (meta.reason expired|used|revoked|not_found) when the link cannot be opened or has used its exchanges.
 */
export async function exchangeLink(db: Db, o: { token: string; ip: string | null; now: Date }): Promise<Exchanged> {
  return db.transaction().execute(async (tx) => {
    const r = await resolveLink(tx, o.token, o.now, { forUpdate: true })
    if (!r.ok) throw new AppError('IDENTITY_LINK_INVALID', { meta: { reason: r.reason } })
    const exchanges = await tx
      .selectFrom('client_link_sessions')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('link_id', '=', r.link.id)
      .executeTakeFirstOrThrow()
    if (Number(exchanges.n) >= LINK_POLICY[r.link.kind].maxExchanges)
      throw new AppError('IDENTITY_LINK_INVALID', { meta: { reason: 'used' satisfies LinkDeadReason } })
    const trust = r.link.customerId
      ? await evaluateTrust(tx, { locationId: r.link.locationId, phone: r.link.phone, customerId: r.link.customerId, now: o.now })
      : null
    const token = newToken()
    const expiresAt = new Date(o.now.getTime() + SESSION_MAX_MS)
    const row = await tx
      .insertInto('client_link_sessions')
      .values({
        token_hash: hashToken(token),
        link_id: r.link.id,
        customer_id: r.link.customerId,
        phone_e164: r.link.phone,
        trust: trust?.trusted ? 'verified' : 'link',
        verified_by: trust?.trusted ? trust.verifiedBy : null,
        step_up_at: null,
        idle_expires_at: new Date(Math.min(o.now.getTime() + SESSION_IDLE_MS, expiresAt.getTime())),
        expires_at: expiresAt,
        revoked_at: null,
        ip: o.ip,
        created_at: o.now,
        last_used_at: o.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { session: token, view: view(row, r.link), numberTrust: trust }
  })
}

/**
 * The live session a bearer token stands for, or 401 IDENTITY_SESSION_INVALID: unknown, revoked, idle or past its hour, five wrong
 * entries, or its link revoked / bound to a PIN, number or epoch that changed. `touch` slides the idle window (the default);
 * `forUpdate` locks the session row for a change in the caller's transaction.
 */
export async function resolveSession(
  db: Executor,
  token: string,
  now: Date,
  o: { touch?: boolean; forUpdate?: boolean } = {},
): Promise<SessionView> {
  if (!TOKEN_SHAPE.test(token)) throw new AppError('IDENTITY_SESSION_INVALID')
  const s = await db
    .selectFrom('client_link_sessions')
    .selectAll()
    .where('token_hash', '=', hashToken(token))
    .$if(o.forUpdate === true, (q) => q.forUpdate())
    .executeTakeFirst()
  if (!s || !sessionAlive(s, now)) throw new AppError('IDENTITY_SESSION_INVALID')
  const link = await db.selectFrom('client_links').selectAll().where('id', '=', s.link_id).executeTakeFirst()
  if (!link || (await linkDeadReason(db, link, now, 'session')) !== null) throw new AppError('IDENTITY_SESSION_INVALID')
  if (o.touch === false) return view(s, linkView(link))
  const touched = await db
    .updateTable('client_link_sessions')
    .set({ idle_expires_at: new Date(Math.min(now.getTime() + SESSION_IDLE_MS, s.expires_at.getTime())), last_used_at: now })
    .where('token_hash', '=', s.token_hash)
    .returningAll()
    .executeTakeFirstOrThrow()
  return view(touched, linkView(link))
}

export const sessionAlive = (s: SessionRow, now: Date): boolean =>
  s.revoked_at === null &&
  s.idle_expires_at.getTime() > now.getTime() &&
  s.expires_at.getTime() > now.getTime() &&
  s.failed_attempts < SESSION_MAX_FAILURES

/** Marks the session verified by a PIN or a code entered just now (the step-up timestamp too). */
export async function markSessionVerified(tx: Tx, tokenHash: string, by: VerifiedBy, now: Date): Promise<SessionRow> {
  return tx
    .updateTable('client_link_sessions')
    .set({ trust: 'verified', verified_by: by, step_up_at: now, last_used_at: now })
    .where('token_hash', '=', tokenHash)
    .returningAll()
    .executeTakeFirstOrThrow()
}

/** One wrong PIN or code on the page; the fifth revokes the session. Returns the tries left (0: the session is over). */
export async function countSessionFailure(tx: Tx, tokenHash: string, now: Date): Promise<number> {
  const r = await tx
    .updateTable('client_link_sessions')
    .set((eb) => ({ failed_attempts: eb('failed_attempts', '+', 1), last_used_at: now }))
    .where('token_hash', '=', tokenHash)
    .returning('failed_attempts')
    .executeTakeFirstOrThrow()
  const left = Math.max(0, SESSION_MAX_FAILURES - r.failed_attempts)
  if (left === 0) await tx.updateTable('client_link_sessions').set({ revoked_at: now }).where('token_hash', '=', tokenHash).execute()
  return left
}

/** True when the session holds a PIN or code entered within the last 5 minutes (memberships and payments). */
export const hasFreshStepUp = (s: Pick<SessionView, 'stepUpAt' | 'trust'>, now: Date, maxAgeMs = STEP_UP_MAX_AGE_MS): boolean =>
  s.trust === 'verified' && s.stepUpAt !== null && now.getTime() - s.stepUpAt.getTime() <= maxAgeMs

/** 403 IDENTITY_STEP_UP_REQUIRED unless the session has a fresh step-up. */
export function requireFreshStepUp(s: Pick<SessionView, 'stepUpAt' | 'trust'>, now: Date, maxAgeMs = STEP_UP_MAX_AGE_MS): void {
  if (!hasFreshStepUp(s, now, maxAgeMs)) throw new AppError('IDENTITY_STEP_UP_REQUIRED')
}

/** Ends the page's own session (the page's "done"). */
export async function endSession(tx: Tx, token: string, now: Date): Promise<void> {
  if (!TOKEN_SHAPE.test(token)) return
  await tx.updateTable('client_link_sessions').set({ revoked_at: now }).where('token_hash', '=', hashToken(token)).where('revoked_at', 'is', null).execute()
}

/** Ends the live sessions of a client and/or a number, except `keepTokenHash`. Returns how many. */
export async function revokeSessions(
  tx: Tx,
  o: { customerId?: string | null; phone?: string | null; now?: Date; keepTokenHash?: string | null },
): Promise<number> {
  if (!o.customerId && !o.phone) return 0
  const at = o.now ?? sql<Date>`app_now()`
  const r = await tx
    .updateTable('client_link_sessions')
    .set({ revoked_at: at })
    .where('revoked_at', 'is', null)
    .$if(!!o.keepTokenHash, (q) => q.where('token_hash', '<>', o.keepTokenHash!))
    .where((eb) =>
      eb.or([
        ...(o.customerId ? [eb('customer_id', '=', o.customerId)] : []),
        ...(o.phone ? [eb('phone_e164', '=', o.phone)] : []),
      ]),
    )
    .executeTakeFirst()
  return Number(r.numUpdatedRows)
}
