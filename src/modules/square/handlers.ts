// The ingest handlers of wave Q2b installed into the Q1b runtime (runtime.ts squareIngest): payment.* events decide the payment
// (mirror, classification, link payments at once, counter payments after SQUARE_MATCH_DELAY_SECONDS), refund.* events move the
// refund legs or record a refund made in the Square app. Subscription invoices, subscriptions, cards and customers keep the
// foundation's logging handlers until their waves (Q3a, Q3b).
import { createIdGenerator } from '../../platform/ids.js'
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
    return ingestSquareRefund(ctx.tx, depsOf(ctx), refundFacts(r))
  },
}

