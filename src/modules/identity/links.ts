// Personal links (ADR 0160, design section 5). A link is a 32-byte random token (base64url, 43 characters) in the fragment of a
// website URL (https://oasisautospanj.com/#/c|m|p|pin|v|k/<token>), texted only to the number on file. Only its SHA-256 is stored.
// It is bound to its kind, the client, the number, the appointment / invoice / plan it is for, and to the client's PIN version,
// phone version and the links epoch at issue time: a PIN change, a phone change or an epoch bump kills it without touching the row.
// Opening (the exchange for a session) uses nothing; a completion (a booking, a verification, a checkout started) consumes one use.
import { advisoryXactLock, type Executor, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { normalizeTextableNanp } from '../../platform/phone.js'
import { sql, type Selectable } from 'kysely'
import { hashToken, newToken, TOKEN_SHAPE } from '../auth/tokens.js'
import { currentEpoch, liveCustomer, optedOutSince, pinVersionOf } from './common.js'
import type { ClientLinkIssuer, ClientLinkKind, ClientLinksTable, IdentityRevokeReason } from './schema.js'
import './problems.js'
import './schema.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export interface LinkPolicy {
  /** Lifetime from issue. */
  ttlMs: number
  /** Completions before the link is used up. */
  maxUses: number
  /** Sessions the link can be exchanged for in its life (re-exchange after a session ends counts). */
  maxExchanges: number
  /** The website route of the fragment: #/<path>/<token>. */
  path: 'c' | 'm' | 'p' | 'pin' | 'v' | 'k'
  /** Its action (a membership, a payment, saving a card) needs a PIN or code entered on the page in the last 5 minutes (requireFresh). */
  fresh: boolean
}

/** Per kind: verify and PIN links 15 minutes, single use, at most 5 exchanges; calendar 72 h (3 bookings); book again 14 days;
 * membership 24 h; payment until paid or void, at most 7 days; card (ADR 0171 D7: save a card with Square) 24 h, 3 saves.
 * Memberships, payments and saving a card need a fresh PIN or code on the page. */
export const LINK_POLICY: Record<ClientLinkKind, LinkPolicy> = {
  verify: { ttlMs: 15 * MIN, maxUses: 1, maxExchanges: 5, path: 'v', fresh: false },
  pin: { ttlMs: 15 * MIN, maxUses: 1, maxExchanges: 5, path: 'pin', fresh: false },
  calendar: { ttlMs: 72 * HOUR, maxUses: 3, maxExchanges: 30, path: 'c', fresh: false },
  book_again: { ttlMs: 14 * DAY, maxUses: 1, maxExchanges: 30, path: 'c', fresh: false },
  membership: { ttlMs: 24 * HOUR, maxUses: 3, maxExchanges: 20, path: 'm', fresh: true },
  pay: { ttlMs: 7 * DAY, maxUses: 3, maxExchanges: 30, path: 'p', fresh: true },
  card: { ttlMs: 24 * HOUR, maxUses: 3, maxExchanges: 20, path: 'k', fresh: true },
}

/** Links the assistant may text one number: at most 3 a day, and one of a kind an hour (design section 4, send_link). */
export const ASSISTANT_LINK_LIMITS = { perDay: 3, perKindPerHour: 1 } as const

export const DEFAULT_SITE_URL = 'https://oasisautospanj.com'

/** The URL a text carries: the token rides in the fragment, which browsers never send to a server or put in a Referer. */
export function linkUrl(kind: ClientLinkKind, token: string, siteUrl: string = DEFAULT_SITE_URL): string {
  return `${siteUrl.replace(/\/+$/, '')}/#/${LINK_POLICY[kind].path}/${token}`
}

export interface IssueLinkInput {
  locationId: string
  kind: ClientLinkKind
  /** The client; the link goes to the number on file. Null only for a stranger's calendar or book-again link (a lead). */
  customerId: string | null
  /** Only for a stranger (customerId null): the number that texted the shop. Ignored when a client is named. */
  phone?: string | null
  appointmentId?: string | null
  invoiceId?: string | null
  planKey?: string | null
  issuedBy: ClientLinkIssuer
  /** An earlier end than the kind's lifetime (a payment link ends when its invoice is paid); never a later one. */
  expiresAt?: Date | null
}

export interface IssuedLink {
  id: string
  /** The token itself: put it in the text (as a secretVar) and nowhere else; it is not stored. */
  token: string
  url: string
  kind: ClientLinkKind
  phone: string
  expiresAt: Date
  maxUses: number
}

/**
 * Issues a link: validates the bindings (the appointment and invoice are the client's, a pay link names an open invoice, a membership
 * link a plan), records the client's PIN and phone versions and the epoch, supersedes the live link of the same kind to the same
 * number (and the same invoice for a payment link), and for the assistant enforces its per-number limits. The caller texts the URL
 * (class personal_link, the token as a secretVar) in the same transaction.
 */
export async function issueClientLink(
  tx: Tx,
  deps: { newId: NewId; now: Date; siteUrl?: string },
  input: IssueLinkInput,
): Promise<IssuedLink> {
  const { now } = deps
  const policy = LINK_POLICY[input.kind]
  let phone: string
  let phoneVersion = 0
  let pinVersion = 0
  if (input.customerId) {
    const c = await liveCustomer(tx, input.customerId)
    if (!c) throw new AppError('NOT_FOUND', { detail: 'That client does not exist' })
    if (!c.phoneE164) throw new AppError('IDENTITY_NO_PHONE')
    phone = c.phoneE164
    phoneVersion = c.phoneVersion
    pinVersion = await pinVersionOf(tx, c.id)
  } else {
    if (input.kind !== 'calendar' && input.kind !== 'book_again')
      throw new AppError('VALIDATION_FAILED', { detail: `A ${input.kind} link needs a client` })
    const p = normalizeTextableNanp(input.phone ?? '')
    if (!p.ok) throw new AppError('VALIDATION_FAILED', { detail: 'A stranger’s link needs a US or Canadian mobile number' })
    phone = p.e164
  }
  if (input.kind === 'pay' && !input.invoiceId) throw new AppError('VALIDATION_FAILED', { detail: 'A payment link names an invoice' })
  if (input.kind === 'membership' && !input.planKey) throw new AppError('VALIDATION_FAILED', { detail: 'A membership link names a plan' })
  if (input.appointmentId) {
    const a = await tx
      .selectFrom('appointments')
      .select(['customer_id', 'location_id'])
      .where('id', '=', input.appointmentId)
      .executeTakeFirst()
    if (!a || a.location_id !== input.locationId || a.customer_id !== input.customerId)
      throw new AppError('VALIDATION_FAILED', { detail: 'That appointment is not this client’s' })
  }
  if (input.invoiceId) {
    const inv = await tx
      .selectFrom('invoices')
      .select(['customer_id', 'location_id', 'canceled_at'])
      .where('id', '=', input.invoiceId)
      .executeTakeFirst()
    if (!inv || inv.location_id !== input.locationId || inv.customer_id !== input.customerId)
      throw new AppError('VALIDATION_FAILED', { detail: 'That invoice is not this client’s' })
    if (inv.canceled_at !== null) throw new AppError('VALIDATION_FAILED', { detail: 'That invoice is void' })
    if (input.kind === 'pay' && (await invoiceBalance(tx, input.invoiceId)) <= 0)
      throw new AppError('VALIDATION_FAILED', { detail: 'That invoice is already paid' })
  }

  // one decision per number at a time: the limits count and the supersede see every link issued before this one
  await advisoryXactLock(tx, `client-links:${input.locationId}:${phone}`)
  if (input.issuedBy === 'assistant') await enforceAssistantLimits(tx, input.locationId, phone, input.kind, now)

  await tx
    .updateTable('client_links')
    .set({ revoked_at: now, revoke_reason: 'superseded' })
    .where('location_id', '=', input.locationId)
    .where('phone_e164', '=', phone)
    .where('kind', '=', input.kind)
    .where('revoked_at', 'is', null)
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', now)
    .$if(input.kind === 'pay', (q) => q.where('invoice_id', '=', input.invoiceId!))
    .execute()

  const latest = new Date(now.getTime() + policy.ttlMs)
  const expiresAt = input.expiresAt && input.expiresAt.getTime() < latest.getTime() ? input.expiresAt : latest
  if (expiresAt.getTime() <= now.getTime()) throw new AppError('VALIDATION_FAILED', { detail: 'The link would already be expired' })
  const id = deps.newId()
  const token = newToken()
  await tx
    .insertInto('client_links')
    .values({
      id,
      location_id: input.locationId,
      token_hash: hashToken(token),
      kind: input.kind,
      customer_id: input.customerId,
      phone_e164: phone,
      appointment_id: input.appointmentId ?? null,
      invoice_id: input.invoiceId ?? null,
      plan_key: input.planKey ?? null,
      pin_version: pinVersion,
      phone_version: phoneVersion,
      epoch: await currentEpoch(tx, input.locationId),
      issued_by: input.issuedBy,
      expires_at: expiresAt,
      max_uses: policy.maxUses,
      consumed_at: null,
      revoked_at: null,
      revoke_reason: null,
      created_at: now,
    })
    .execute()
  return { id, token, url: linkUrl(input.kind, token, deps.siteUrl), kind: input.kind, phone, expiresAt, maxUses: policy.maxUses }
}

async function enforceAssistantLimits(tx: Tx, locationId: string, phone: string, kind: ClientLinkKind, now: Date): Promise<void> {
  const r = await tx
    .selectFrom('client_links')
    .select((eb) => [
      eb.fn.countAll<string>().as('day'),
      eb.fn.count<string>(sql`case when kind = ${kind} and created_at > ${new Date(now.getTime() - HOUR)} then 1 end`).as('kind_hour'),
    ])
    .where('location_id', '=', locationId)
    .where('phone_e164', '=', phone)
    .where('issued_by', '=', 'assistant')
    .where('created_at', '>', new Date(now.getTime() - DAY))
    .executeTakeFirstOrThrow()
  if (Number(r.kind_hour) >= ASSISTANT_LINK_LIMITS.perKindPerHour)
    throw new AppError('IDENTITY_LINK_LIMIT', { params: { what: 'this kind of link in the last hour' }, meta: { limit: 'kind_hour' } })
  if (Number(r.day) >= ASSISTANT_LINK_LIMITS.perDay)
    throw new AppError('IDENTITY_LINK_LIMIT', { params: { what: `${ASSISTANT_LINK_LIMITS.perDay} links today` }, meta: { limit: 'day' } })
}

export type LinkRow = Selectable<ClientLinksTable>

/** Why a link cannot be used: the page shows "expired", "already used" or "replaced" (revoked covers every revocation rule). */
export type LinkDeadReason = 'not_found' | 'expired' | 'used' | 'revoked'

export interface LinkView {
  id: string
  locationId: string
  kind: ClientLinkKind
  customerId: string | null
  phone: string
  appointmentId: string | null
  invoiceId: string | null
  planKey: string | null
  issuedBy: ClientLinkIssuer
  expiresAt: Date
  uses: number
  maxUses: number
  consumedAt: Date | null
  createdAt: Date
}

export const linkView = (r: LinkRow): LinkView => ({
  id: r.id,
  locationId: r.location_id,
  kind: r.kind,
  customerId: r.customer_id,
  phone: r.phone_e164,
  appointmentId: r.appointment_id,
  invoiceId: r.invoice_id,
  planKey: r.plan_key,
  issuedBy: r.issued_by,
  expiresAt: r.expires_at,
  uses: r.uses,
  maxUses: r.max_uses,
  consumedAt: r.consumed_at,
  createdAt: r.created_at,
})

/**
 * Whether a link still stands for its client: not revoked, the epoch it was issued in, the client still live and still on that
 * number with the same phone and PIN versions, no opt-out of the number since it was issued, and for a payment link its invoice
 * neither void ('revoked') nor paid ('used'; money recorded but awaiting the processor counts, as on the invoice's balance). `use`
 * adds the life rules: 'open' (an exchange) also needs it unexpired and not used up; 'session' (a session already opened) does not.
 */
export async function linkDeadReason(db: Executor, link: LinkRow, now: Date, use: 'open' | 'session'): Promise<LinkDeadReason | null> {
  if (link.revoked_at !== null) return 'revoked'
  if (use === 'open') {
    if (link.consumed_at !== null || link.uses >= link.max_uses) return 'used'
    if (link.expires_at.getTime() <= now.getTime()) return 'expired'
  }
  if (link.epoch !== (await currentEpoch(db, link.location_id))) return 'revoked'
  if (link.customer_id) {
    const c = await liveCustomer(db, link.customer_id)
    if (!c || c.phoneE164 !== link.phone_e164 || c.phoneVersion !== link.phone_version) return 'revoked'
    if ((await pinVersionOf(db, c.id)) !== link.pin_version) return 'revoked'
  }
  if (await optedOutSince(db, { locationId: link.location_id, phone: link.phone_e164, customerId: link.customer_id, since: link.created_at }))
    return 'revoked'
  if (link.kind === 'pay' && link.invoice_id) {
    const inv = await db.selectFrom('invoices').select('canceled_at').where('id', '=', link.invoice_id).executeTakeFirst()
    if (!inv || inv.canceled_at !== null) return 'revoked'
    if ((await invoiceBalance(db, link.invoice_id)) <= 0) return 'used'
  }
  return null
}

/** What is left to pay on an invoice, from the ledger's own calculation (0 for a void one). */
async function invoiceBalance(db: Executor, invoiceId: string): Promise<number> {
  const r = await sql<{ balance: string | number }>`select balance from invoice_calc_of(${invoiceId}::uuid)`.execute(db)
  return Number(r.rows[0]?.balance ?? 0)
}

export type ResolvedLink = { ok: true; link: LinkView; row: LinkRow } | { ok: false; reason: LinkDeadReason }

/** The link a token stands for, if it can still be opened. A token that is not the 43-character shape never reaches the database. */
export async function resolveLink(db: Executor, token: string, now: Date, o: { forUpdate?: boolean } = {}): Promise<ResolvedLink> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false, reason: 'not_found' }
  const row = await db
    .selectFrom('client_links')
    .selectAll()
    .where('token_hash', '=', hashToken(token))
    .$if(o.forUpdate === true, (q) => q.forUpdate())
    .executeTakeFirst()
  if (!row) return { ok: false, reason: 'not_found' }
  const dead = await linkDeadReason(db, row, now, 'open')
  return dead ? { ok: false, reason: dead } : { ok: true, link: linkView(row), row }
}

/**
 * Counts one completion (a booking, a verification, a checkout started) against the link, under a row lock: refused with 409
 * IDENTITY_LINK_USED once its uses are spent (or a payment link's invoice is paid), 401 IDENTITY_LINK_INVALID when it was revoked,
 * the client's PIN, number or the epoch changed, or a payment link's invoice was voided. A completion within a live session is allowed after the link's own expiry (the session decides that).
 */
export async function consumeLink(tx: Tx, linkId: string, now: Date): Promise<LinkView> {
  const row = await tx.selectFrom('client_links').selectAll().where('id', '=', linkId).forUpdate().executeTakeFirst()
  if (!row) throw new AppError('IDENTITY_LINK_INVALID')
  const dead = await linkDeadReason(tx, row, now, 'session')
  if (dead === 'used') throw new AppError('IDENTITY_LINK_USED')
  if (dead) throw new AppError('IDENTITY_LINK_INVALID', { meta: { reason: dead } })
  if (row.consumed_at !== null || row.uses >= row.max_uses) throw new AppError('IDENTITY_LINK_USED')
  const uses = row.uses + 1
  const updated = await tx
    .updateTable('client_links')
    .set({ uses, ...(uses >= row.max_uses ? { consumed_at: now } : {}) })
    .where('id', '=', linkId)
    .returningAll()
    .executeTakeFirstOrThrow()
  return linkView(updated)
}

/** Revokes one link (and, by the session rule, every session opened from it). */
export async function revokeLink(tx: Tx, linkId: string, reason: IdentityRevokeReason, now?: Date): Promise<boolean> {
  const at = now ?? sql<Date>`app_now()`
  const r = await tx
    .updateTable('client_links')
    .set({ revoked_at: at, revoke_reason: reason })
    .where('id', '=', linkId)
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  await tx.updateTable('client_link_sessions').set({ revoked_at: at }).where('link_id', '=', linkId).where('revoked_at', 'is', null).execute()
  return Number(r.numUpdatedRows) > 0
}

/**
 * Revokes the live links of a client and/or of a number (a stranger's links have no client), except `keepLinkId`. Returns how many.
 */
export async function revokeLinks(
  tx: Tx,
  o: { locationId?: string; customerId?: string | null; phone?: string | null; reason: IdentityRevokeReason; now?: Date; keepLinkId?: string | null },
): Promise<number> {
  if (!o.customerId && !o.phone) return 0
  const at = o.now ?? sql<Date>`app_now()`
  const r = await tx
    .updateTable('client_links')
    .set({ revoked_at: at, revoke_reason: o.reason })
    .where('revoked_at', 'is', null)
    .$if(o.locationId !== undefined, (q) => q.where('location_id', '=', o.locationId!))
    .$if(!!o.keepLinkId, (q) => q.where('id', '<>', o.keepLinkId!))
    .where((eb) =>
      eb.or([
        ...(o.customerId ? [eb('customer_id', '=', o.customerId)] : []),
        ...(o.phone ? [eb('phone_e164', '=', o.phone)] : []),
      ]),
    )
    .executeTakeFirst()
  return Number(r.numUpdatedRows)
}
