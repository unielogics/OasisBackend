// STUB (wave Q3 shared foundation): the card page's routes, declared so the contract, the OpenAPI document and the authz matrix
// carry them, with NO behaviour yet: closed (PUBLIC_LINKS_ENABLED=false, the default) they answer the unknown-route 404 like every
// link route; open they answer 501 LINK_ACTION_NOT_READY. Wave Q3a (cards on file) implements them here:
//   POST   /public/links/cards          a `card` (#/k) or `membership` page with a fresh PIN or code saves a card with Square and the
//                                       client's consent: src/modules/square/cards.ts saveCardOnFile (keyBase from the link and the
//                                       request's Idempotency-Key), limits per address, per number (5 a day) and per page (3), the
//                                       number locked for the day after 3 declines (design 4.2);
//   DELETE /public/links/cards/:cardId  the page removes one of its own client's cards (fresh PIN or code): disableCard.
// The body and answer shapes below are the contract Q3a starts from.
import { z } from '../../../../http/zod.js'
import { AppError, registerProblems } from '../../../../platform/errors.js'
import { CARD_PURPOSES } from '../../../square/consents.js'
import type { LinkRouteKit } from './routes.js'

registerProblems({
  LINK_ACTION_NOT_READY: {
    status: 501,
    title: 'Not ready yet',
    detail: 'This page can’t do that yet. Text us and we’ll help.',
  },
})

export const CardSaveBody = z
  .object({
    sourceId: z.string().min(1).max(512).describe('The Web Payments SDK token of the card (cnon:...); used once, never stored'),
    verificationToken: z.string().min(1).max(4096).optional().describe('The SDK’s buyer verification (3-D Secure) token'),
    consentVersion: z.string().regex(/^v[0-9]{1,4}$/).describe('The consent wording the page showed (the current one, else 409 CARD_CONSENT_OUTDATED)'),
    purposes: z.array(z.enum(CARD_PURPOSES)).min(1).max(CARD_PURPOSES.length).describe('What the client ticked (the box starts unchecked)'),
    cardholderName: z.string().trim().max(100).optional(),
    postalCode: z.string().trim().max(12).optional(),
  })
  .strict()

export const CardView = z.object({
  id: z.string().uuid(),
  brand: z.string().nullable(),
  last4: z.string().nullable(),
  expMonth: z.number().int().nullable(),
  expYear: z.number().int().nullable(),
  state: z.enum(['active', 'disabled', 'forgotten', 'expired']),
})

export const CardSaveResult = z.object({
  card: CardView,
  consent: z.object({ version: z.string(), purposes: z.array(z.enum(CARD_PURPOSES)) }),
})

export const CardParams = z.object({ cardId: z.string().uuid() }).strict()
export const CardRemoveResult = z.object({ cardId: z.string().uuid(), state: CardView.shape.state })

const notReady = async (): Promise<never> => {
  throw new AppError('LINK_ACTION_NOT_READY')
}

export function registerCardLinkRoutes(k: LinkRouteKit): void {
  k.app.post(
    k.path('/cards'),
    {
      ...k.guard,
      config: k.cfg('A card or membership link page with a fresh PIN or code saves a card with Square, with the client’s consent', 10),
      schema: {
        tags: k.tags,
        operationId: 'saveClientLinkCard',
        summary: 'Save a card with Square (card or membership link, fresh PIN or code) — not built yet',
        description: `${k.bearerNote} Wave Q3a. Until then: 501 \`LINK_ACTION_NOT_READY\` (404 while personal links are closed).`,
        body: CardSaveBody,
        response: { 201: CardSaveResult },
      },
    },
    notReady,
  )

  k.app.delete(
    k.path('/cards/:cardId'),
    {
      ...k.guard,
      config: k.cfg('A card link page with a fresh PIN or code removes one of its own client’s saved cards', 10),
      schema: {
        tags: k.tags,
        operationId: 'removeClientLinkCard',
        summary: 'Remove a saved card (card link, fresh PIN or code) — not built yet',
        description: `${k.bearerNote} Wave Q3a. Until then: 501 \`LINK_ACTION_NOT_READY\` (404 while personal links are closed).`,
        params: CardParams,
        response: { 200: CardRemoveResult },
      },
    },
    notReady,
  )
}
