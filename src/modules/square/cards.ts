// Cards on file (ADR 0171 D7 and D12, design 4.2): a client saves a card with Square on a personal link page (the Web Payments SDK
// tokenizes it in the browser; Oasis only ever sees Square's one-time source id and, after saving, Square's card id, brand, last 4 and
// expiry). Each save carries the client's consent: the purposes ticked and the exact wording (consents.ts), stored with its hash.
// A saved card is charged only after a staff member confirms (D7), except the membership's monthly payment Square bills itself.
//
//   saveCardOnFile  the consent wording is checked first (nothing is sent for an outdated or empty consent); ensureSquareCustomer;
//                   CreateCard with the key cd_<keyBase> OUTSIDE any transaction (a retry with the same keyBase answers the same card);
//                   then ONE transaction writes customer_cards and card_consents and the audit `card.saved`. A retry of the same
//                   attempt (same keyBase, same body) gets the same card from Square and answers the stored card and its live
//                   consent (nothing twice).
//   disableCard     DisableCard at Square (outside any transaction; a card Square no longer has counts as done), then one
//                   transaction: the card `disabled` and every live consent of it revoked, audit `card.disabled`. A card already not
//                   active only has its consents revoked (idempotent).
// Writes off (SQUARE_WRITES_ENABLED=false): 409 SQUARE_WRITES_OFF before anything is written; Square down: 503 SQUARE_UNAVAILABLE.
import { isIP } from 'node:net'
import type { Env } from '../../config/env.js'
import type { SquareApi } from '../../integrations/ports/square.js'
import { SquareApiError, SquareDeclined, SquareIdempotencyReused, declineText } from '../../integrations/square/errors.js'
import { sqKey } from '../../integrations/square/keys.js'
import type { WireCard } from '../../integrations/square/wire.js'
import type { AuditContext } from '../../platform/audit.js'
import { record as audit } from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { consentText, type CardPurpose } from './consents.js'
import { ensureSquareCustomer } from './customers.js'
import type {
  CardConsentRevokeReason,
  CustomerCardCreatedVia,
  CustomerCardDisabledReason,
  CustomerCardState,
} from './db/cards-schema.js'
import type { SquareLogger } from './ingest.js'
import { squareProblem } from './links.js'
import './db/cards-schema.js'
import './problems.js'

export interface SquareCardDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Env
  api: SquareApi
  locationId: string
  logger?: SquareLogger
}

export interface SaveCardInput {
  customerId: string
  /** The Web Payments SDK's one-time token (cnon:...), never stored. */
  sourceId: string
  /** The SDK's buyer verification (3-D Secure) token, when it gave one. */
  verificationToken?: string | null
  postalCode?: string | null
  cardholderName?: string | null
  /** What the client ticked (at least one; consents.ts CARD_PURPOSES). */
  purposes: readonly CardPurpose[]
  /** The consent wording the page showed (must be the current one). */
  consentVersion: string
  ip: string | null
  userAgent: string | null
  /** The personal link and the page's session token hash it was saved on. */
  linkId?: string | null
  sessionHash?: string | null
  /**
   * A stable name of this attempt (an enrollment id, a link id plus the request's Idempotency-Key): CreateCard is sent with the key
   * cd_<keyBase>, so a retry of the same attempt can never save a second card.
   */
  keyBase: string
  /** Where the card was saved (default card_link). */
  createdVia?: CustomerCardCreatedVia
  audit?: AuditContext
}

export interface SavedCard {
  cardId: string
  consentId: string
  squareCardId: string
  squareCustomerId: string
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
  state: CustomerCardState
  purposes: CardPurpose[]
  consentVersion: string
  /** false when a retry found the card and consent already stored. */
  created: boolean
}

export interface DisableCardInput {
  cardId: string
  /** When set, the card must be this client's (404 CARD_NOT_FOUND otherwise): a page acts only on its own client's cards. */
  customerId?: string | null
  /** Who removed it: the client (their link page) or staff. */
  by: 'client' | 'staff'
  /** The staff member's name for revoked_by (staff only). */
  actorName?: string | null
  /** Why, when not the client's or staff's own removal: the client was deleted (the nightly job). */
  reason?: 'customer_deleted'
  audit?: AuditContext
}

export interface DisabledCard {
  cardId: string
  state: CustomerCardState
  /** Live consents this call revoked. */
  revokedConsents: number
  /** The card was already not active (nothing was sent to Square). */
  alreadyInactive: boolean
}

/** A Square refusal of the card itself (declined, bad data, expired form token): what the client may read. */
function cardRefusal(e: unknown): AppError | null {
  // the same keyBase with another card or body: a caller bug, never the client's card
  if (e instanceof SquareIdempotencyReused) return new AppError('IDEMPOTENCY_MISMATCH')
  if (e instanceof SquareDeclined) return new AppError('CARD_DECLINED', { detail: e.friendly, meta: { code: e.code ?? null } })
  if (e instanceof SquareApiError && e.status === 400 && e.category === 'INVALID_REQUEST_ERROR')
    return new AppError('CARD_DECLINED', { detail: declineText(e.code), meta: { code: e.code ?? null } })
  return null
}

const toProblem = (e: unknown): unknown => (e instanceof AppError ? e : (cardRefusal(e) ?? squareProblem(e)))

const clip = (s: string | null | undefined, n: number): string | null => {
  const v = s?.trim()
  return v ? v.slice(0, n) : null
}

/**
 * Saves a card with Square for a client and records the consent. 422 CARD_CONSENT_INVALID / 409 CARD_CONSENT_OUTDATED before
 * anything is sent; 404 NOT_FOUND for an unknown client; 422 CARD_DECLINED when Square refuses the card; 409 SQUARE_WRITES_OFF
 * (watch-only) or 503 SQUARE_UNAVAILABLE. Never logs the source id or verification token.
 */
export async function saveCardOnFile(deps: SquareCardDeps, input: SaveCardInput): Promise<SavedCard> {
  const consent = consentText(input.consentVersion, input.purposes)
  const key = sqKey('cd', input.keyBase)

  let squareCustomerId: string
  let card: WireCard
  try {
    squareCustomerId = (await ensureSquareCustomer(deps, { customerId: input.customerId })).squareCustomerId
    const postal = clip(input.postalCode, 12)
    const holder = clip(input.cardholderName, 100)
    card = await deps.api.cards.create(key, {
      source_id: input.sourceId,
      ...(input.verificationToken ? { verification_token: input.verificationToken } : {}),
      card: {
        customer_id: squareCustomerId,
        reference_id: input.customerId,
        ...(holder ? { cardholder_name: holder } : {}),
        ...(postal ? { billing_address: { postal_code: postal } } : {}),
      },
    })
  } catch (e) {
    const p = toProblem(e)
    if (!(e instanceof AppError))
      deps.logger?.warn({ customerId: input.customerId, err: e instanceof Error ? e.message : String(e) }, 'square: saving a card failed')
    throw p
  }

  const now = deps.clock.now()
  return transaction(deps.db, async (tx) => {
    const inserted = await tx
      .insertInto('customer_cards')
      .values({
        id: deps.newId(),
        location_id: deps.locationId,
        customer_id: input.customerId,
        square_customer_id: squareCustomerId,
        square_card_id: card.id,
        brand: card.card_brand ?? null,
        last4: card.last_4 && /^[0-9]{4}$/.test(card.last_4) ? card.last_4 : null,
        exp_month: card.exp_month ?? null,
        exp_year: card.exp_year ?? null,
        card_type: card.card_type ?? null,
        postal: clip(card.billing_address?.postal_code ?? input.postalCode, 12),
        fingerprint: card.fingerprint ?? null,
        state: card.enabled ? 'active' : 'disabled',
        created_via: input.createdVia ?? 'card_link',
        disabled_at: card.enabled ? null : now,
        disabled_reason: card.enabled ? null : 'square_disabled',
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.column('square_card_id').doNothing())
      .returning('id')
      .executeTakeFirst()
    // the same card again (a retry of the same attempt, maybe concurrent): its live consent is the answer, nothing twice
    const existing = await tx.selectFrom('customer_cards').selectAll().where('square_card_id', '=', card.id).forUpdate().executeTakeFirstOrThrow()
    if (existing.customer_id !== input.customerId || existing.location_id !== deps.locationId) throw new AppError('CARD_NOT_FOUND')
    const cardId = existing.id
    if (!inserted) {
      if (existing.state !== 'active') throw new AppError('CARD_NOT_FOUND', { detail: 'That card was removed. Enter it again to save it.' })
      const live = await tx
        .selectFrom('card_consents')
        .select(['id', 'purposes', 'text_version'])
        .where('card_id', '=', cardId)
        .where('revoked_at', 'is', null)
        .orderBy('accepted_at', 'desc')
        .executeTakeFirst()
      if (live) return savedOf(existing, live.id, live.purposes as CardPurpose[], live.text_version, false)
    }
    const consentId = deps.newId()
    await tx
      .insertInto('card_consents')
      .values({
        id: consentId,
        location_id: deps.locationId,
        customer_id: input.customerId,
        card_id: cardId,
        purposes: consent.purposes,
        text_version: consent.version,
        text_sha256: consent.sha256,
        text_snapshot: consent.text,
        accepted_at: now,
        ip: input.ip && isIP(input.ip) ? input.ip : null,
        user_agent: clip(input.userAgent, 512),
        link_id: input.linkId ?? null,
        session_hash: input.sessionHash ?? null,
        revoked_at: null,
        revoked_by: null,
        revoke_reason: null,
        created_at: now,
      })
      .execute()
    const row = await cardRow(tx, cardId)
    await audit(tx, {
      locationId: deps.locationId,
      action: 'card.saved',
      entityType: 'customer_card',
      entityId: cardId,
      after: {
        customerId: input.customerId,
        brand: row.brand,
        last4: row.last4,
        purposes: consent.purposes,
        consentId,
        consentVersion: consent.version,
        via: row.created_via,
      },
      ctx: input.audit ?? { actor: { name: 'Client' }, ip: input.ip },
    })
    return savedOf(row, consentId, consent.purposes, consent.version, !!inserted)
  })
}

async function cardRow(tx: Tx, cardId: string) {
  return tx.selectFrom('customer_cards').selectAll().where('id', '=', cardId).executeTakeFirstOrThrow()
}

function savedOf(
  row: Awaited<ReturnType<typeof cardRow>>,
  consentId: string,
  purposes: CardPurpose[],
  consentVersion: string,
  created: boolean,
): SavedCard {
  return {
    cardId: row.id,
    consentId,
    squareCardId: row.square_card_id,
    squareCustomerId: row.square_customer_id,
    brand: row.brand,
    last4: row.last4,
    expMonth: row.exp_month,
    expYear: row.exp_year,
    state: row.state,
    purposes,
    consentVersion,
    created,
  }
}

/**
 * Removes a saved card: DisableCard at Square, the card `disabled`, its live consents revoked. 404 CARD_NOT_FOUND for a card of
 * another location or (with `customerId`) another client; 409 SQUARE_WRITES_OFF / 503 SQUARE_UNAVAILABLE leave everything unchanged.
 */
export async function disableCard(deps: SquareCardDeps, input: DisableCardInput): Promise<DisabledCard> {
  const card = await deps.db
    .selectFrom('customer_cards')
    .select(['id', 'customer_id', 'square_card_id', 'state'])
    .where('id', '=', input.cardId)
    .where('location_id', '=', deps.locationId)
    .executeTakeFirst()
  if (!card || (input.customerId && card.customer_id !== input.customerId)) throw new AppError('CARD_NOT_FOUND')

  const alreadyInactive = card.state !== 'active'
  if (!alreadyInactive) {
    try {
      await deps.api.cards.disable(card.square_card_id)
    } catch (e) {
      deps.logger?.warn({ cardId: card.id, err: e instanceof Error ? e.message : String(e) }, 'square: disabling a card failed')
      throw squareProblem(e)
    }
  }

  const now = deps.clock.now()
  const disabledReason: CustomerCardDisabledReason = input.reason ?? (input.by === 'client' ? 'client_removed' : 'staff_removed')
  const revokeReason: CardConsentRevokeReason = input.reason ?? (input.by === 'client' ? 'client_removed' : 'staff_removed')
  const revokedBy = input.by === 'client' ? 'client' : `staff${input.actorName ? `: ${input.actorName}` : ''}`.slice(0, 120)
  return transaction(deps.db, async (tx) => {
    const row = await tx
      .selectFrom('customer_cards')
      .select(['id', 'state', 'customer_id', 'brand', 'last4'])
      .where('id', '=', card.id)
      .forUpdate()
      .executeTakeFirstOrThrow()
    if (row.state === 'active')
      await tx
        .updateTable('customer_cards')
        .set({ state: 'disabled', disabled_at: now, disabled_reason: disabledReason, updated_at: now })
        .where('id', '=', card.id)
        .execute()
    const revoked = await tx
      .updateTable('card_consents')
      .set({ revoked_at: now, revoked_by: revokedBy, revoke_reason: revokeReason })
      .where('card_id', '=', card.id)
      .where('revoked_at', 'is', null)
      .returning('id')
      .execute()
    const state: CustomerCardState = row.state === 'active' ? 'disabled' : row.state
    if (row.state === 'active' || revoked.length > 0)
      await audit(tx, {
        locationId: deps.locationId,
        action: 'card.disabled',
        entityType: 'customer_card',
        entityId: card.id,
        before: { state: row.state },
        after: { state, customerId: row.customer_id, brand: row.brand, last4: row.last4, by: input.by, revokedConsents: revoked.map((r) => r.id) },
        ctx: input.audit ?? { actor: { name: input.by === 'client' ? 'Client' : (input.actorName ?? 'Staff') } },
      })
    return { cardId: card.id, state, revokedConsents: revoked.length, alreadyInactive }
  })
}
