// The ingest handlers of wave Q2b installed into the Q1b runtime (runtime.ts squareIngest): payment.* events decide the payment
// (mirror, classification, link payments at once, counter payments after SQUARE_MATCH_DELAY_SECONDS), refund.* events move the
// refund legs or record a refund made in the Square app. Wave Q3a: card.* events keep the saved cards in step (an automatic update, a
// card disabled or forgotten at Square), customer.deleted closes the cards of a Square customer deleted at Square. Subscription
// invoices and subscriptions keep the foundation's logging handlers until wave Q3b.
import { createIdGenerator } from '../../platform/ids.js'
import { paymentFacts, refundFacts } from './facts.js'
import { noopSquareIngest, type SquareIngest, type SquareIngestContext } from './ingest.js'
import { decideSquarePayment, type SquarePaymentDeps } from './payments.js'
import { ingestSquareRefund } from './refunds.js'
import { ingestSquareCard, ingestSquareCustomer, type CardEventDeps } from './card-events.js'
import { squareQueue } from './runtime.js'

const depsOf = (ctx: SquareIngestContext): SquarePaymentDeps => ({
  locationId: ctx.locationId,
  clock: ctx.clock,
  newId: createIdGenerator(ctx.clock),
  env: ctx.env,
})

const cardDepsOf = (ctx: SquareIngestContext): CardEventDeps => ({
  locationId: ctx.locationId,
  clock: ctx.clock,
  newId: createIdGenerator(ctx.clock),
  env: ctx.env,
  queue: squareQueue(),
  logger: ctx.logger,
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
  async card(ctx, card, cardId) {
    return ingestSquareCard(ctx.tx, cardDepsOf(ctx), card, cardId, ctx.event.type)
  },
  async customer(ctx, customer, customerId) {
    return ingestSquareCustomer(ctx.tx, cardDepsOf(ctx), customer, customerId)
  },
}

