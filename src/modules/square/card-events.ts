// The life of a saved card after it is saved (ADR 0171 D7, design q-design-square.md 4.4, wave Q3a):
//   card.automatically_updated / card.updated  the issuer's new expiry or last 4 copied onto customer_cards (Square re-fetched)
//   card.disabled / card.forgotten              the card disabled (or forgotten at the holder's request), its live consents revoked;
//                                               when it paid a membership the managers are told and the client is texted a card link
//   customer.deleted                            the Square customer is gone with its cards: the cards disabled, the link removed (the
//                                               next save makes a new Square customer)
//   nightly (square.cards.nightly)              cards that pay a membership and expire within 30 days get a card link texted (once
//                                               per card and expiry); the cards of a deleted client are disabled at Square
// A card Oasis did not save (made in the Square dashboard) is ignored: it has no consent, so it is never charged.
// The texts go through the messaging queue only while personal links are on (PUBLIC_LINKS_ENABLED) and a queue is wired.
import { sql } from 'kysely'
import type { Env } from '../../config/env.js'
import type { SquareApi } from '../../integrations/ports/square.js'
import type { WireCard, WireCustomer } from '../../integrations/square/wire.js'
import * as audit from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Executor, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { issueClientLink } from '../identity/links.js'
import { loadCustomerTarget } from '../messaging/db/recipients.js'
import { notifyManagers } from '../messaging/notify.js'
import { cardLabel } from '../payments/repository.js'
import { disableCard } from './cards.js'
import { cardWords } from './charges.js'
import type { CardConsentRevokeReason, CustomerCardDisabledReason, CustomerCardState } from './db/cards-schema.js'
import type { IngestOutcome, SquareLogger } from './ingest.js'
import type { SquareQueue } from './runtime.js'
import './db/cards-schema.js'

const DAY = 86_400_000
/** A card paying a membership is replaced this long before it expires. */
export const EXPIRY_NOTICE_DAYS = 30

export interface CardTextDeps {
  clock: Clock
  newId: NewId
  env: Pick<Env, 'PUBLIC_LINKS_ENABLED' | 'PUBLIC_SITE_URL'>
  queue?: SquareQueue
  logger?: SquareLogger
}

export type CardLinkSent =
  | { sent: true; linkId: string; expiresAt: Date; messageId: string; duplicate: boolean }
  | { sent: false; reason: 'links_off' | 'no_queue' | 'no_phone' | 'not_found' | string }

async function savepoint<T>(tx: Tx, name: string, fn: () => Promise<T>): Promise<T> {
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

class NotQueued extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/**
 * Issues a card link (#/k, 24 hours) for the client and texts it (template personal_link_card, the link a secret variable), in the
 * caller's transaction. `why` opens the text ("Your Visa ending in 4242 expires soon."). Nothing is issued when personal links are
 * off or no queue is wired; a text the policy refuses (opted out, no number) leaves no link behind.
 */
export async function textCardLink(
  tx: Tx,
  d: CardTextDeps,
  i: { locationId: string; customerId: string; issuedBy: 'staff' | 'system'; why?: string | null; dedupeKey?: string; senderKind?: 'staff' | 'system' },
): Promise<CardLinkSent> {
  if (!d.env.PUBLIC_LINKS_ENABLED) return { sent: false, reason: 'links_off' }
  if (!d.queue) {
    d.logger?.warn({ customerId: i.customerId }, 'square: no messaging queue wired; the card link was not texted')
    return { sent: false, reason: 'no_queue' }
  }
  const queue = d.queue
  const target = await loadCustomerTarget(tx, i.locationId, i.customerId)
  if (!target) return { sent: false, reason: 'not_found' }
  try {
    return await savepoint(tx, 'card_link', async () => {
      const issued = await issueClientLink(
        tx,
        { newId: d.newId, now: d.clock.now(), ...(d.env.PUBLIC_SITE_URL ? { siteUrl: d.env.PUBLIC_SITE_URL } : {}) },
        { locationId: i.locationId, kind: 'card', customerId: i.customerId, issuedBy: i.issuedBy },
      )
      const out = await queue.enqueueFor(tx, {
        locationId: i.locationId,
        customerId: i.customerId,
        recipient: target.recipient,
        appointmentId: null,
        templateKey: 'personal_link_card',
        vars: i.why ? { why: i.why } : {},
        secretVars: { link: issued.url },
        purpose: 'card_link',
        senderKind: i.senderKind ?? 'system',
        dedupeKey: i.dedupeKey ?? `card-link:${issued.id}`,
      })
      if (!out.queued) throw new NotQueued(out.skipped)
      return { sent: true as const, linkId: issued.id, expiresAt: issued.expiresAt, messageId: out.messageId, duplicate: out.duplicate }
    })
  } catch (e) {
    if (e instanceof NotQueued) return { sent: false, reason: e.reason }
    if (e instanceof AppError && e.code === 'IDENTITY_NO_PHONE') return { sent: false, reason: 'no_phone' }
    if (e instanceof AppError && e.code === 'NOT_FOUND') return { sent: false, reason: 'not_found' }
    throw e
  }
}

/**
 * The card pays a membership: a live consent covering membership_billing and a live membership of the client (active, past due or
 * paused). Wave Q3b (memberships on Square) may narrow this to the subscription's own card.
 */
export async function cardPaysMembership(db: Executor, card: { id: string; customer_id: string }): Promise<boolean> {
  const r = await sql<{ hit: boolean }>`
    select exists (
      select 1 from card_consents k where k.card_id = ${card.id} and k.revoked_at is null and 'membership_billing' = any(k.purposes)
    ) and exists (
      select 1 from memberships m where m.customer_id = ${card.customer_id} and m.status in ('active', 'past_due', 'paused')
    ) as hit`.execute(db)
  return r.rows[0]?.hit === true
}

export interface CardEventDeps extends CardTextDeps {
  locationId: string
}

const STATE_OF: Record<string, { state: CustomerCardState; reason: CustomerCardDisabledReason; revoke: CardConsentRevokeReason }> = {
  forgotten: { state: 'forgotten', reason: 'square_forgotten', revoke: 'card_forgotten' },
  disabled: { state: 'disabled', reason: 'square_disabled', revoke: 'card_disabled' },
}

/** Marks a saved card disabled or forgotten and revokes its live consents (Square already did it); audited as Square's. */
async function closeCard(
  tx: Tx,
  d: CardEventDeps,
  row: { id: string; customer_id: string; brand: string | null; last4: string | null; state: CustomerCardState },
  how: 'disabled' | 'forgotten',
  event: string,
): Promise<{ revoked: number; paysMembership: boolean }> {
  const s = STATE_OF[how]!
  const now = d.clock.now()
  const paysMembership = await cardPaysMembership(tx, row)
  if (row.state === 'active')
    await tx
      .updateTable('customer_cards')
      .set({ state: s.state, disabled_at: now, disabled_reason: s.reason, updated_at: now })
      .where('id', '=', row.id)
      .execute()
  const revoked = await tx
    .updateTable('card_consents')
    .set({ revoked_at: now, revoked_by: 'Square', revoke_reason: s.revoke })
    .where('card_id', '=', row.id)
    .where('revoked_at', 'is', null)
    .returning('id')
    .execute()
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'card.disabled',
    entityType: 'customer_card',
    entityId: row.id,
    before: { state: row.state },
    after: { state: row.state === 'active' ? s.state : row.state, by: 'square', event, customerId: row.customer_id, revokedConsents: revoked.map((r) => r.id) },
    ctx: { actor: { name: 'Square' } },
  })
  return { revoked: revoked.length, paysMembership }
}

/** A card that paid a membership is gone: the managers are told, the client gets a card link. */
async function replaceMembershipCard(tx: Tx, d: CardEventDeps, row: { id: string; customer_id: string; brand: string | null; last4: string | null }, why: string): Promise<void> {
  const c = await tx.selectFrom('customers').select('full_name').where('id', '=', row.customer_id).executeTakeFirst()
  const label = cardLabel(row.brand, row.last4).label
  const sent = await textCardLink(tx, d, { locationId: d.locationId, customerId: row.customer_id, issuedBy: 'system', why, dedupeKey: `card-replace:${row.id}` })
  await notifyManagers(
    tx,
    {
      locationId: d.locationId,
      kind: 'square.card_removed',
      title: `Membership card removed · ${c?.full_name ?? 'a client'}`,
      body: `${label} paid a membership and can no longer be charged. ${sent.sent ? 'The client was texted a link to save a new card.' : 'Ask the client for a new card.'}`,
      entityType: 'customer',
      entityId: row.customer_id,
      sourceRef: `card_removed:${row.id}`,
    },
    { newId: d.newId, clock: d.clock },
  )
}

/** The card handler of the Square ingest (card.* events; the card re-fetched, or null when Square no longer has it). */
export async function ingestSquareCard(tx: Tx, d: CardEventDeps, card: WireCard | null, squareCardId: string, eventType: string): Promise<IngestOutcome> {
  const row = await tx
    .selectFrom('customer_cards')
    .select(['id', 'customer_id', 'brand', 'last4', 'exp_month', 'exp_year', 'state'])
    .where('location_id', '=', d.locationId)
    .where('square_card_id', '=', squareCardId)
    .forUpdate()
    .executeTakeFirst()
  if (!row) return { status: 'ignored', note: 'a card Oasis did not save' }
  const gone = !card || !card.enabled || eventType === 'card.disabled' || eventType === 'card.forgotten'
  if (gone) {
    if (row.state !== 'active') {
      // already closed (a client or staff removal, an earlier event): only make sure no consent is left live
      const left = await tx.selectFrom('card_consents').select('id').where('card_id', '=', row.id).where('revoked_at', 'is', null).execute()
      if (left.length === 0) return { status: 'processed', note: `card already ${row.state}` }
    }
    const how = eventType === 'card.forgotten' ? 'forgotten' : 'disabled'
    const out = await closeCard(tx, d, row, how, eventType)
    if (out.paysMembership && row.state === 'active')
      await replaceMembershipCard(tx, d, row, `Your saved ${cardWords(cardLabel(row.brand, row.last4).label)} can no longer be charged for your membership.`)
    return { status: 'processed', note: `card ${how}${out.paysMembership ? ', membership card: client texted a card link' : ''}` }
  }
  // updated (the issuer's automatic update, or another change): copy what Square says now
  const next = {
    brand: card.card_brand ?? row.brand,
    last4: card.last_4 && /^[0-9]{4}$/.test(card.last_4) ? card.last_4 : row.last4,
    exp_month: card.exp_month ?? row.exp_month,
    exp_year: card.exp_year ?? row.exp_year,
  }
  if (next.brand === row.brand && next.last4 === row.last4 && next.exp_month === row.exp_month && next.exp_year === row.exp_year)
    return { status: 'processed', note: 'card unchanged' }
  const now = d.clock.now()
  await tx
    .updateTable('customer_cards')
    .set({ ...next, fingerprint: card.fingerprint ?? undefined, expiry_notice_for: null, updated_at: now })
    .where('id', '=', row.id)
    .execute()
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'card.updated',
    entityType: 'customer_card',
    entityId: row.id,
    before: { brand: row.brand, last4: row.last4, expMonth: row.exp_month, expYear: row.exp_year },
    after: { brand: next.brand, last4: next.last4, expMonth: next.exp_month, expYear: next.exp_year, event: eventType },
    ctx: { actor: { name: 'Square' } },
  })
  return { status: 'processed', note: 'card updated' }
}

/** The customer handler: a Square customer deleted at Square takes its cards with it; the link goes so the next save starts again. */
export async function ingestSquareCustomer(tx: Tx, d: CardEventDeps, customer: WireCustomer | null, squareCustomerId: string): Promise<IngestOutcome> {
  if (customer) return { status: 'processed', note: 'customer updated (nothing to change)' }
  const link = await tx
    .selectFrom('square_customer_links')
    .select(['id', 'customer_id'])
    .where('location_id', '=', d.locationId)
    .where('square_customer_id', '=', squareCustomerId)
    .forUpdate()
    .executeTakeFirst()
  const cards = await tx
    .selectFrom('customer_cards')
    .select(['id', 'customer_id', 'brand', 'last4', 'state'])
    .where('location_id', '=', d.locationId)
    .where('square_customer_id', '=', squareCustomerId)
    .forUpdate()
    .execute()
  if (!link && cards.length === 0) return { status: 'ignored', note: 'a Square customer Oasis is not linked to' }
  let closed = 0
  for (const c of cards) {
    const live = await tx.selectFrom('card_consents').select('id').where('card_id', '=', c.id).where('revoked_at', 'is', null).execute()
    if (c.state !== 'active' && live.length === 0) continue
    const out = await closeCard(tx, d, c, 'disabled', 'customer.deleted')
    closed += 1
    if (out.paysMembership && c.state === 'active')
      await replaceMembershipCard(tx, d, c, `Your saved ${cardWords(cardLabel(c.brand, c.last4).label)} can no longer be charged for your membership.`)
  }
  if (link) {
    await tx.deleteFrom('square_customer_links').where('id', '=', link.id).execute()
    await audit.record(tx, {
      locationId: d.locationId,
      action: 'square.customer_unlinked',
      entityType: 'customer',
      entityId: link.customer_id,
      after: { squareCustomerId, reason: 'deleted at Square', cardsClosed: closed },
      ctx: { actor: { name: 'Square' } },
    })
  }
  return { status: 'processed', note: `Square customer deleted: ${closed} card(s) closed` }
}

// ---- nightly ----------------------------------------------------------------------------------------------------------------

export interface CardNightlyReport {
  /** Cards of deleted clients disabled at Square. */
  disabled: number
  /** Cards that could not be disabled (Square down or watch-only: tried again the next night). */
  disableFailed: number
  /** Card links texted for a membership card about to expire. */
  texted: number
  /** Expiring membership cards whose link could not go (links off, opted out, no number). */
  notTexted: number
}

export interface CardNightlyDeps extends CardEventDeps {
  db: Db
  api: SquareApi
  env: Env
}

/** "2026-11": the expiry month a card's notice is for. */
const expiryKey = (y: number, m: number): string => `${y}-${String(m).padStart(2, '0')}`

/**
 * square.cards.nightly: (1) the active cards of deleted clients are disabled at Square (DisableCard; consents revoked
 * `customer_deleted`); (2) every active card paying a membership whose expiry month ends within 30 days gets a card link texted, once
 * per card and expiry (customer_cards.expiry_notice_for).
 */
export async function runCardNightly(d: CardNightlyDeps): Promise<CardNightlyReport> {
  const report: CardNightlyReport = { disabled: 0, disableFailed: 0, texted: 0, notTexted: 0 }
  const orphans = await d.db
    .selectFrom('customer_cards as k')
    .innerJoin('customers as c', 'c.id', 'k.customer_id')
    .select(['k.id'])
    .where('k.location_id', '=', d.locationId)
    .where('k.state', '=', 'active')
    .where('c.deleted_at', 'is not', null)
    .execute()
  for (const o of orphans) {
    try {
      await disableCard(d, { cardId: o.id, by: 'staff', actorName: 'Oasis (client deleted)', reason: 'customer_deleted' })
      report.disabled += 1
    } catch (e) {
      report.disableFailed += 1
      d.logger?.warn({ cardId: o.id, err: e instanceof Error ? e.message : String(e) }, 'square: disabling a deleted client’s card failed')
    }
  }
  const now = d.clock.now()
  const horizon = new Date(now.getTime() + EXPIRY_NOTICE_DAYS * DAY)
  const cards = await d.db
    .selectFrom('customer_cards as k')
    .innerJoin('customers as c', 'c.id', 'k.customer_id')
    .select(['k.id', 'k.customer_id', 'k.brand', 'k.last4', 'k.exp_month', 'k.exp_year', 'k.expiry_notice_for'])
    .where('k.location_id', '=', d.locationId)
    .where('k.state', '=', 'active')
    .where('c.deleted_at', 'is', null)
    .where('k.exp_month', 'is not', null)
    .where('k.exp_year', 'is not', null)
    .execute()
  for (const k of cards) {
    const end = Date.UTC(k.exp_year!, k.exp_month!, 1)
    if (end > horizon.getTime() || end <= now.getTime()) continue
    const key = expiryKey(k.exp_year!, k.exp_month!)
    if (k.expiry_notice_for === key) continue
    if (!(await cardPaysMembership(d.db, k))) continue
    const sent = await transaction(d.db, async (tx) => {
      const out = await textCardLink(tx, d, {
        locationId: d.locationId,
        customerId: k.customer_id,
        issuedBy: 'system',
        why: `Your ${cardWords(cardLabel(k.brand, k.last4).label)} on file for your membership expires soon.`,
        dedupeKey: `card-expiring:${k.id}:${key}`,
      })
      if (out.sent) await tx.updateTable('customer_cards').set({ expiry_notice_for: key }).where('id', '=', k.id).execute()
      return out.sent
    })
    if (sent) report.texted += 1
    else report.notTexted += 1
  }
  return report
}
