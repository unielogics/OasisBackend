// The ingest handlers installed into the Q1b runtime (runtime.ts squareIngest): payment.* events decide the payment (mirror,
// classification, link payments at once, counter payments after SQUARE_MATCH_DELAY_SECONDS) and refund.* events move the refund
// legs or record a refund made in the Square app (wave Q2b); invoice.* and subscription.* drive the memberships billed by Square,
// and a membership refund follows its refund.* events (wave Q3b, memberships/square/billing.ts). Cards and customers keep the
// foundation's logging handlers until wave Q3a.
import { createIdGenerator } from '../../platform/ids.js'
import { ingestMembershipRefund, ingestSquareSubscription, ingestSubscriptionInvoice } from '../memberships/square/billing.js'
import { paymentFacts, refundFacts } from './facts.js'
import { noopSquareIngest, type SquareIngest, type SquareIngestContext } from './ingest.js'
import { decideSquarePayment, type SquarePaymentDeps } from './payments.js'
import { ingestSquareRefund } from './refunds.js'

const depsOf = (ctx: SquareIngestContext): SquarePaymentDeps => ({
  locationId: ctx.locationId,
  clock: ctx.clock,
  newId: createIdGenerator(ctx.clock),
  env: ctx.env,
})

export const squareCoreIngest: SquareIngest = {
  ...noopSquareIngest,
  async payment(ctx, p) {
    const out = await decideSquarePayment(ctx.tx, depsOf(ctx), paymentFacts(p))
    return out === 'ignored' ? { status: 'ignored', note: `payment ${p.status.toLowerCase()}` } : { status: 'processed', note: `payment ${out}` }
  },
  async refund(ctx, r) {
    const facts = refundFacts(r)
    // a membership payment's refund (wave Q3b) is the membership's; every other refund moves the ledger's legs
    return (await ingestMembershipRefund(ctx, facts)) ?? ingestSquareRefund(ctx.tx, depsOf(ctx), facts)
  },
  invoice: ingestSubscriptionInvoice,
  subscription: ingestSquareSubscription,
}

