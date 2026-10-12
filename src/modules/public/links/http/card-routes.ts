// The card page's routes (ADR 0171 D7 and D12, wave Q3a; design q-design-square.md 4.2). A card link (#/k, 24 hours, 3 saves) with
// a FRESH PIN or code (entered on this page in the last 5 minutes), its client proven (a code alone does not prove a stale record)
// and no PIN-reset hold:
//   POST   /public/links/cards          saves a card with Square: the Web Payments SDK's one-time token (never stored), the client's
//                                       consent (the current wording's version and the purposes ticked; the box starts unchecked);
//                                       src/modules/square/cards.ts saveCardOnFile (CreateCard outside any transaction, key
//                                       cd_<link and token>). Idempotency-Key required (the key is the LINK's). Limits: 10 an hour per
//                                       address, 5 a day per number, 3 per page; 3 declined cards a day lock the number for the day
//                                       (429 CARD_SAVE_LOCKED). One completion of the link per card saved.
//   DELETE /public/links/cards/:cardId  removes one of the page client's own cards: DisableCard at Square, consents revoked.
// Closed like every link route (PUBLIC_LINKS_ENABLED=false: the unknown-route 404). Saved cards off (PAYMENT_PROCESSOR is not
// square): 501 LINK_ACTION_NOT_READY, nothing written. Square watch-only: 409 SQUARE_WRITES_OFF.
import type { FastifyRequest } from 'fastify'
import { idempotentHandler } from '../../../../http/idempotent.js'
import { z } from '../../../../http/zod.js'
import { AppError, registerProblems } from '../../../../platform/errors.js'
import { ipLimitKey } from '../../../../platform/ip.js'
import { consumeLink } from '../../../identity/links.js'
import type { SessionView } from '../../../identity/sessions.js'
import { disableCard, saveCardOnFile, type SavedCard, type SquareCardDeps } from '../../../square/cards.js'
import { cardsOn } from '../../../square/charges.js'
import { squareWritesOn } from '../../../square/links.js'
import { CARD_PURPOSES } from '../../../square/consents.js'
import { squareApi, squareEnv } from '../../../square/runtime.js'
import { consume, windowStart, type LimitRule } from '../../limits.js'
import { linkAudit, linkLocation, requireFresh, requireKind, requireNoHold, requireProven } from '../service.js'
import type { LinkRouteKit } from './routes.js'

registerProblems({
  LINK_ACTION_NOT_READY: {
    status: 501,
    title: 'Not ready yet',
    detail: 'This page can’t do that yet. Text us and we’ll help.',
  },
})

/** Durable limits of the card page (public_rate_limits). */
export const CARD_LIMITS = {
  save: { ip: { max: 10, windowSec: 3600 }, phone: { max: 5, windowSec: 86_400 }, session: { max: 3, windowSec: 86_400 } },
  /** Declined cards per number a day before the number is locked for the day (card testing). */
  declines: { max: 3, windowSec: 86_400 },
  remove: { ip: { max: 20, windowSec: 3600 } },
} as const satisfies Record<string, Record<string, LimitRule> | LimitRule>

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

const declineKey = (phone: string): string => `card_decline:phone:${phone}`

/** The number's declined cards today (read without counting): 3 lock it for the rest of the day. */
async function declinesToday(k: LinkRouteKit, phone: string): Promise<number> {
  const rule = CARD_LIMITS.declines
  const r = await k.app.db
    .selectFrom('public_rate_limits')
    .select('count')
    .where('key', '=', declineKey(phone))
    .where('window_start', '=', windowStart(k.app.clock.now(), rule.windowSec))
    .executeTakeFirst()
  return Number(r?.count ?? 0)
}

const cardDeps = (k: LinkRouteKit, locationId: string, req: FastifyRequest): SquareCardDeps => {
  const env = squareEnv()
  return { db: k.app.db, clock: k.app.clock, newId: k.app.newId, env, api: squareApi(env), locationId, logger: req.log }
}

/** The checks of a card page's action: a card link, a fresh PIN or code, the page's own proven client, no PIN-reset hold. */
async function cardPage(k: LinkRouteKit, s: SessionView, o: { hold: boolean }): Promise<{ customerId: string; locationId: string }> {
  requireKind(s, ['card'])
  const now = k.app.clock.now()
  requireFresh(s, now)
  if (!s.customerId) throw new AppError('LINK_WRONG_PURPOSE')
  await requireProven(k.app.db, s, now)
  const loc = await linkLocation(k.app.db, s.link.locationId)
  if (o.hold) await requireNoHold(k.app.db, s.customerId, now, loc.tz)
  // saved cards are a Square feature: before the cutover the page cannot take one; watch-only Square writes nothing
  const env = squareEnv()
  if (!cardsOn(env)) throw new AppError('LINK_ACTION_NOT_READY')
  if (!squareWritesOn(env)) throw new AppError('SQUARE_WRITES_OFF')
  return { customerId: s.customerId, locationId: loc.id }
}

const cardDto = (c: Pick<SavedCard, 'cardId' | 'brand' | 'last4' | 'expMonth' | 'expYear' | 'state'>) => ({
  id: c.cardId,
  brand: c.brand,
  last4: c.last4,
  expMonth: c.expMonth,
  expYear: c.expYear,
  state: c.state,
})

export function registerCardLinkRoutes(k: LinkRouteKit): void {
  k.app.post(
    k.path('/cards'),
    {
      ...k.guard,
      config: k.cfg('A card link page with a fresh PIN or code saves a card with Square, with the client’s consent; Idempotency-Key required', 10, {
        idempotency: 'required',
      }),
      schema: {
        tags: k.tags,
        operationId: 'saveClientLinkCard',
        summary: 'Save a card with Square (card link, fresh PIN or code)',
        description:
          `${k.bearerNote} Idempotency-Key required (the key belongs to the link). Needs a PIN or code entered on this page in the last 5 minutes (403 \`IDENTITY_STEP_UP_REQUIRED\`, \`meta.need\` \`fresh\`); 401 \`LINK_WRONG_PURPOSE\` on another kind of link; 409 \`IDENTITY_RECORD_UNCONFIRMED\` on a stale record proven only by a code; 403 \`LINK_PRIVILEGES_HELD\` within 72 hours of a PIN reset. ` +
          '`sourceId` is the Web Payments SDK’s one-time token (never stored); the consent must be the current wording (409 `CARD_CONSENT_OUTDATED`: reload) with at least one purpose ticked (422 `CARD_CONSENT_INVALID`). The card is saved with Square (CreateCard, outside any transaction) under the client’s Square customer, then the card and the consent (version, SHA-256 and text, time, address, browser, link and page) are stored. 201 `{card, consent}`; one completion of the link. ' +
          '422 `CARD_DECLINED` with the reason the client may read in `detail` (it counts toward the number’s 3 declined cards a day: then 429 `CARD_SAVE_LOCKED` until the next day); 429 `PUBLIC_RATE_LIMITED` (10 an hour per address, 5 a day per number, 3 per page); 501 `LINK_ACTION_NOT_READY` while saved cards are off (PAYMENT_PROCESSOR is not square); 409 `SQUARE_WRITES_OFF`; 503 `SQUARE_UNAVAILABLE`.',
        body: CardSaveBody,
        response: { 201: CardSaveResult },
      },
    },
    idempotentHandler<FastifyRequest, SavedCard>(
      async (req, tx, _reply, saved) => {
        // one completion of the card link per card saved (a retry of the same attempt saved nothing new); a page that used its
        // last completion meanwhile still gets its card
        if (saved.created) {
          const s = await k.session(tx, req, { touch: false, forUpdate: true })
          try {
            await consumeLink(tx, s.link.id, k.app.clock.now())
          } catch (e) {
            if (!(e instanceof AppError) || e.code !== 'IDENTITY_LINK_USED') throw e
          }
        }
        return { status: 201, body: { card: cardDto(saved), consent: { version: saved.consentVersion, purposes: saved.purposes } } }
      },
      {
        actor: async (req) => `link:${(await k.session(k.app.db, req, { touch: false })).link.id}`,
        // on the pool, before the idempotency transaction: the checks, the limits (a refused attempt still counts) and the Square call
        prepare: async (req) => {
          const s = await k.session(k.app.db, req, { touch: false })
          const { customerId, locationId } = await cardPage(k, s, { hold: true })
          if ((await declinesToday(k, s.phone)) >= CARD_LIMITS.declines.max) throw new AppError('CARD_SAVE_LOCKED')
          await k.limit([
            { key: `link_card:ip:${ipLimitKey(req.ip)}`, rule: CARD_LIMITS.save.ip },
            { key: `link_card:phone:${s.phone}`, rule: CARD_LIMITS.save.phone },
            { key: `link_card:session:${s.tokenHash}`, rule: CARD_LIMITS.save.session },
          ])
          const body = req.body as z.infer<typeof CardSaveBody>
          const ua = req.headers['user-agent']
          try {
            return await saveCardOnFile(cardDeps(k, locationId, req), {
              customerId,
              sourceId: body.sourceId,
              verificationToken: body.verificationToken ?? null,
              postalCode: body.postalCode ?? null,
              cardholderName: body.cardholderName ?? null,
              purposes: body.purposes,
              consentVersion: body.consentVersion,
              ip: req.ip,
              userAgent: typeof ua === 'string' ? ua : null,
              linkId: s.link.id,
              sessionHash: s.tokenHash,
              // one attempt = this link and this card token (a token is single use): a retry can never save a second card
              keyBase: `link-card:${s.link.id}:${body.sourceId}`,
              createdVia: 'card_link',
              audit: linkAudit(k.reqOf(req)),
            })
          } catch (e) {
            if (e instanceof AppError && e.code === 'CARD_DECLINED') await consume(k.app.db, k.app.clock, declineKey(s.phone), CARD_LIMITS.declines)
            throw e
          }
        },
      },
    ) as never,
  )

  k.app.delete(
    k.path('/cards/:cardId'),
    {
      ...k.guard,
      config: k.cfg('A card link page with a fresh PIN or code removes one of its own client’s saved cards', 10),
      schema: {
        tags: k.tags,
        operationId: 'removeClientLinkCard',
        summary: 'Remove a saved card (card link, fresh PIN or code)',
        description:
          `${k.bearerNote} Needs a fresh PIN or code on a card page (403 \`IDENTITY_STEP_UP_REQUIRED\`; 401 \`LINK_WRONG_PURPOSE\`; 409 \`IDENTITY_RECORD_UNCONFIRMED\`). Only the page client’s own cards (404 \`CARD_NOT_FOUND\` otherwise). DisableCard at Square first (nothing changes when Square does not answer: 503 \`SQUARE_UNAVAILABLE\`, or is watch-only: 409 \`SQUARE_WRITES_OFF\`), then the card \`disabled\` and its consents revoked (audit \`card.disabled\`). Removing a removed card answers its state again. Uses no completion of the link. 20 an hour per address.`,
        params: CardParams,
        response: { 200: CardRemoveResult },
      },
    },
    async (req) => {
      const s = await k.session(k.app.db, req, { touch: false })
      const { customerId, locationId } = await cardPage(k, s, { hold: false })
      await k.limit([{ key: `link_card_remove:ip:${ipLimitKey(req.ip)}`, rule: CARD_LIMITS.remove.ip }])
      const { cardId } = req.params as z.infer<typeof CardParams>
      const out = await disableCard(cardDeps(k, locationId, req), { cardId, customerId, by: 'client', audit: linkAudit(k.reqOf(req)) })
      return { cardId: out.cardId, state: out.state }
    },
  )
}
