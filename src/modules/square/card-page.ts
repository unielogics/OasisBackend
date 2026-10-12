// What a card page (#/k) shows of saved cards (ADR 0171 D7, wave Q3a), for the personal-link state (public/links/service.ts):
//   cards      the client's active saved cards (brand, last 4, expiry, what the client agreed they may be charged for); only on a
//              verified card or membership page whose client is proven (a code alone does not reveal a stale record's cards)
//   cardSetup  what the page needs to take a card: the current consent wording (its version, the template, how each purpose reads,
//              the box unchecked) and Square's Web Payments SDK settings (application and location ids, the SDK's URL), never a
//              secret; null when saved cards are off (PAYMENT_PROCESSOR is not square) or Square is not configured
import type { Env } from '../../config/env.js'
import { squareLocationId } from '../../integrations/square/config.js'
import type { Executor } from '../../platform/db.js'
import type { ClientLinkKind } from '../identity/schema.js'
import { cardsOn } from './charges.js'
import { CARD_PURPOSES, CONSENT_CHECKED_BY_DEFAULT, CONSENT_TEXTS, CURRENT_CONSENT_VERSION, PURPOSE_WORDS, isCardPurpose, type CardPurpose } from './consents.js'
import './db/cards-schema.js'

export interface PageCard {
  id: string
  brand: string | null
  last4: string | null
  expMonth: number | null
  expYear: number | null
  purposes: CardPurpose[]
}

export interface CardSetup {
  consent: {
    version: string
    /** The wording with `{purposes}` where the ticked purposes go ("a no-show fee and a balance you owe"). */
    text: string
    purposes: { key: CardPurpose; words: string }[]
    checkedByDefault: boolean
  }
  square: { applicationId: string; locationId: string; environment: 'sandbox' | 'production'; sdkUrl: string } | null
}

/** The kinds of page that show saved cards and the card form. */
export const CARD_PAGE_KINDS: readonly ClientLinkKind[] = ['card', 'membership']

const SDK_URL = { sandbox: 'https://sandbox.web.squarecdn.com/v1/square.js', production: 'https://web.squarecdn.com/v1/square.js' } as const

export function cardSetupOf(env: Env, kind: ClientLinkKind): CardSetup | null {
  if (!CARD_PAGE_KINDS.includes(kind) || !cardsOn(env)) return null
  const location = squareLocationId(env)
  const square =
    env.SQUARE_APPLICATION_ID && location
      ? { applicationId: env.SQUARE_APPLICATION_ID, locationId: location, environment: env.SQUARE_ENVIRONMENT, sdkUrl: SDK_URL[env.SQUARE_ENVIRONMENT] }
      : null
  return {
    consent: {
      version: CURRENT_CONSENT_VERSION,
      text: CONSENT_TEXTS[CURRENT_CONSENT_VERSION]!,
      purposes: CARD_PURPOSES.map((key) => ({ key, words: PURPOSE_WORDS[key] })),
      checkedByDefault: CONSENT_CHECKED_BY_DEFAULT,
    },
    square,
  }
}

/** The client's active cards with what their live consents allow (newest first). */
export async function pageCards(db: Executor, locationId: string, customerId: string): Promise<PageCard[]> {
  const rows = await db
    .selectFrom('customer_cards')
    .select(['id', 'brand', 'last4', 'exp_month', 'exp_year'])
    .where('location_id', '=', locationId)
    .where('customer_id', '=', customerId)
    .where('state', '=', 'active')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute()
  if (rows.length === 0) return []
  const consents = await db
    .selectFrom('card_consents')
    .select(['card_id', 'purposes'])
    .where('card_id', 'in', rows.map((r) => r.id))
    .where('revoked_at', 'is', null)
    .execute()
  return rows.map((r) => {
    const allowed = new Set(consents.filter((k) => k.card_id === r.id).flatMap((k) => k.purposes))
    return {
      id: r.id,
      brand: r.brand,
      last4: r.last4,
      expMonth: r.exp_month,
      expYear: r.exp_year,
      purposes: CARD_PURPOSES.filter((p) => allowed.has(p) && isCardPurpose(p)),
    }
  })
}
