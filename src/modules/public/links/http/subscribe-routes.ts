// The Square membership enrollment routes of the `#/m` page (ADR 0171 D8, wave Q3b, design 5.3; the logic is
// src/modules/memberships/square/enroll.ts). Closed (PUBLIC_LINKS_ENABLED=false, the default) they answer the unknown-route 404 like
// every link route; with PAYMENT_PROCESSOR=squarespace (the default) subscribe answers 501 LINK_ACTION_NOT_READY (the page uses
// membership/start, the Squarespace checkout):
//   POST /public/links/membership/subscribe  a membership page with a fresh PIN or code: the size, the email Square bills to, the card
//                                            (the Web Payments SDK's one-time token) and the consent (membership_billing) ->
//                                            ensureSquareCustomer (with the email), saveCardOnFile (cd_<enrollment>),
//                                            CreateSubscription (sb_<enrollment>); the membership is active only once Square's
//                                            first invoice is paid. The Square calls run in the idempotency prepare hook (outside
//                                            any transaction); an Idempotency-Key is optional (a retry with it is answered as stored).
//   GET  /public/links/membership/status     the page polls it until the membership is active or failed.
import type { FastifyRequest } from 'fastify'
import { idempotentHandler } from '../../../../http/idempotent.js'
import { z } from '../../../../http/zod.js'
import { ipLimitKey } from '../../../../platform/ip.js'
import { enrollmentStatus, subscribeOnLink, type EnrollmentStatusView } from '../../../memberships/square/enroll.js'
import { VehicleClassKey } from '../../http/schemas.js'
import type { LinkRouteKit } from './routes.js'
import './card-routes.js'

/** The membership limits of the link routes (routes.ts LINK_LIMITS.membership): the subscribe shares their counters. */
const LIMITS = { ip: { max: 10, windowSec: 3600 }, phone: { max: 5, windowSec: 86_400 } } as const

export const MembershipSubscribeBody = z
  .object({
    email: z.string().trim().email('Enter a valid email.').max(254).describe('The email Square sends the membership’s receipts to (a deliverable one: example and test domains are refused)'),
    planClass: VehicleClassKey.optional().describe('The vehicle size the membership is priced at (ADR 0170); absent: the tier’s cheapest priced size'),
    vehicles: z
      .array(z.object({ car: z.string().trim().min(1).max(80), plate: z.string().trim().max(15).optional() }).strict())
      .max(5)
      .optional(),
    sourceId: z.string().min(1).max(512).describe('The Web Payments SDK token of the card (cnon:...); used once, never stored'),
    verificationToken: z.string().min(1).max(4096).optional(),
    consentVersion: z.string().regex(/^v[0-9]{1,4}$/),
    cardholderName: z.string().trim().max(100).optional(),
    postalCode: z.string().trim().max(12).optional(),
  })
  .strict()

export const MembershipEnrollmentStatus = z.object({
  status: z.enum(['none', 'pending', 'active', 'failed']),
  membershipRef: z.string().nullable(),
})

export function registerSubscribeLinkRoutes(k: LinkRouteKit): void {
  k.app.post(
    k.path('/membership/subscribe'),
    {
      ...k.guard,
      config: k.cfg('A membership link page with a fresh PIN or code enrolls its client in a membership billed monthly by Square', 10),
      schema: {
        tags: k.tags,
        operationId: 'subscribeClientLinkMembership',
        summary: 'Join with a card, billed monthly by Square (membership link, fresh PIN or code)',
        description:
          `${k.bearerNote} With PAYMENT_PROCESSOR=square (else 501 \`LINK_ACTION_NOT_READY\`: the page uses membership/start). Needs a PIN or code entered on this page in the last 5 minutes (403 \`IDENTITY_STEP_UP_REQUIRED\`, \`meta.need\` \`fresh\`); 403 \`LINK_PRIVILEGES_HELD\` within 72 hours of a PIN reset; 401 \`LINK_WRONG_PURPOSE\` on another kind of link. ` +
          'The size must be priced for the link’s tier (422 `TIER_CLASS_UNPRICED`) and that price set up at Square (409 `LINK_CHECKOUT_UNAVAILABLE`, also while Square is watch-only or SQUARE_MEMBERSHIPS_ENABLED is false); the email must look deliverable (422 on `body.email`: Square ends a subscription whose email it cannot deliver to); the consent version must be the current one (409 `CARD_CONSENT_OUTDATED`). 409 `LINK_ALREADY_MEMBER` for a client who holds or shares a live membership. ' +
          'A pending membership (source square) and an enrollment, one completion of the link (3); then the client’s Square customer (with the email), the card saved with the consent `membership_billing` (422 `CARD_DECLINED` with the reason the client may read), and the Square subscription from today. `202 {status: pending}`: the page polls `GET membership/status` until `active` (Square’s first invoice paid) or `failed`. A second submit while an attempt is past its card answers its status and sends nothing. 503 `SQUARE_UNAVAILABLE` when Square does not answer before the card is saved. Limits: 10 an hour per address, 5 a day per number (shared with membership/start).',
        body: MembershipSubscribeBody,
        response: { 202: MembershipEnrollmentStatus },
      },
    },
    idempotentHandler<FastifyRequest, EnrollmentStatusView>(
      async (_req, _tx, _reply, out) => ({ status: 202, body: out }),
      {
        actor: async (req) => `link:${(await k.session(k.app.db, req, { touch: false })).link.id}`,
        // the work runs here: its own short transactions around the Square calls (never inside the idempotency transaction)
        prepare: async (req) => {
          const s0 = await k.session(k.app.db, req, { touch: false })
          await k.limit([
            { key: `link_membership:ip:${ipLimitKey(req.ip)}`, rule: LIMITS.ip },
            { key: `link_membership:phone:${s0.phone}`, rule: LIMITS.phone },
          ])
          const ua = req.headers['user-agent']
          return subscribeOnLink(
            k.deps,
            (db, o) => k.session(db, req, o),
            { ...k.reqOf(req), userAgent: typeof ua === 'string' ? ua : null },
            req.body as z.infer<typeof MembershipSubscribeBody>,
            req.log,
          )
        },
      },
    ) as never,
  )

  k.app.get(
    k.path('/membership/status'),
    {
      ...k.guard,
      config: k.cfg('A membership link page polls whether its client’s Square membership enrollment is active yet', 60),
      schema: {
        tags: k.tags,
        operationId: 'getClientLinkMembershipStatus',
        summary: 'Where the Square membership enrollment stands (membership link)',
        description: `${k.bearerNote} This page’s own enrollment: \`none\` before it submitted, \`pending\` until Square’s first invoice is paid, \`active\`, or \`failed\` (the card was refused, the first payment failed, Square ended the subscription, or it was not finished within an hour). 401 \`LINK_WRONG_PURPOSE\` on another kind of link.`,
        response: { 200: MembershipEnrollmentStatus },
      },
    },
    async (req) => enrollmentStatus(k.app.db, await k.session(k.app.db, req, { touch: false })),
  )
}
