// STUB (wave Q3 shared foundation): the Square membership enrollment routes of the `#/m` page, declared so the contract, the
// OpenAPI document and the authz matrix carry them, with NO behaviour yet: closed (PUBLIC_LINKS_ENABLED=false, the default) they
// answer the unknown-route 404 like every link route; open they answer 501 LINK_ACTION_NOT_READY. Wave Q3b (memberships on Square)
// implements them here (design 5.3):
//   POST /public/links/membership/subscribe  a membership page with a fresh PIN or code: the size, the email Square bills to, the card
//                                            and the consent (membership_billing) -> ensureSquareCustomer (with the email),
//                                            saveCardOnFile (keyBase = the enrollment), CreateSubscription; the membership is active
//                                            only once Square's first invoice is paid;
//   GET  /public/links/membership/status     the page polls it until the membership is active or failed.
// The body and answer shapes below are the contract Q3b starts from.
import { z } from '../../../../http/zod.js'
import { AppError } from '../../../../platform/errors.js'
import { VehicleClassKey } from '../../http/schemas.js'
import type { LinkRouteKit } from './routes.js'
import './card-routes.js'

export const MembershipSubscribeBody = z
  .object({
    email: z.string().trim().email('Enter a valid email.').max(254).describe('The email Square sends the membership’s receipts to'),
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

const notReady = async (): Promise<never> => {
  throw new AppError('LINK_ACTION_NOT_READY')
}

export function registerSubscribeLinkRoutes(k: LinkRouteKit): void {
  k.app.post(
    k.path('/membership/subscribe'),
    {
      ...k.guard,
      config: k.cfg('A membership link page with a fresh PIN or code enrolls its client in a membership billed monthly by Square', 10),
      schema: {
        tags: k.tags,
        operationId: 'subscribeClientLinkMembership',
        summary: 'Join with a card, billed monthly by Square (membership link, fresh PIN or code) — not built yet',
        description: `${k.bearerNote} Wave Q3b. Until then: 501 \`LINK_ACTION_NOT_READY\` (404 while personal links are closed).`,
        body: MembershipSubscribeBody,
        response: { 202: MembershipEnrollmentStatus },
      },
    },
    notReady,
  )

  k.app.get(
    k.path('/membership/status'),
    {
      ...k.guard,
      config: k.cfg('A membership link page polls whether its client’s Square membership enrollment is active yet', 60),
      schema: {
        tags: k.tags,
        operationId: 'getClientLinkMembershipStatus',
        summary: 'Where the Square membership enrollment stands (membership link) — not built yet',
        description: `${k.bearerNote} Wave Q3b. Until then: 501 \`LINK_ACTION_NOT_READY\` (404 while personal links are closed).`,
        response: { 200: MembershipEnrollmentStatus },
      },
    },
    notReady,
  )
}
