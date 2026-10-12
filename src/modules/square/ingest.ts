// What a Square event does once its object has been re-fetched (ADR 0171). This wave records and dispatches only: every handler is a
// no-op that logs, and the webhook_log row is closed as processed. Later waves install the real handlers through
// configureSquareRuntime({ ingest }) / the process wiring: payments and refunds (Q2b: the Square mirror, the classifier and matcher,
// the refund legs), cards (Q3a), subscription invoices and subscriptions (Q3b), customers (links).
//
// processSquareEvent() is the one path for a webhook delivery and a catch-up event: classify, refuse a foreign merchant, re-fetch the
// object by id (amounts in a payload are never trusted), refuse another location, then run the handler under an advisory lock per
// object so a webhook and the catch-up, or two deliveries of one object, never interleave.
import type { Env } from '../../config/env.js'
import type { SquareApi } from '../../integrations/ports/square.js'
import { squareLocationId } from '../../integrations/square/config.js'
import { SquareNotFound } from '../../integrations/square/errors.js'
import { classifySquareEvent, type SquareObjectKind } from '../../integrations/square/webhook.js'
import type { WireCard, WireCustomer, WireEvent, WireInvoice, WirePayment, WireRefund, WireSubscription } from '../../integrations/square/wire.js'
import type { Clock } from '../../platform/clock.js'
import { advisoryXactLock, type Db, type Tx } from '../../platform/db.js'
import type { Logger } from '../../platform/logging.js'

/** The logger calls the module makes (pino's Logger and Fastify's request logger both fit). */
export type SquareLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>

export interface IngestOutcome {
  status: 'processed' | 'ignored'
  /** Why it was ignored, or what was done (kept in webhook_log.error for an ignored row). */
  note?: string
}

export interface SquareIngestContext {
  tx: Tx
  clock: Clock
  logger: SquareLogger
  env: Env
  locationId: string
  event: WireEvent
}

export interface SquareIngest {
  payment(ctx: SquareIngestContext, payment: WirePayment): Promise<IngestOutcome>
  refund(ctx: SquareIngestContext, refund: WireRefund): Promise<IngestOutcome>
  invoice(ctx: SquareIngestContext, invoice: WireInvoice): Promise<IngestOutcome>
  subscription(ctx: SquareIngestContext, subscription: WireSubscription): Promise<IngestOutcome>
  card(ctx: SquareIngestContext, card: WireCard): Promise<IngestOutcome>
  /** null when the customer was deleted at Square. */
  customer(ctx: SquareIngestContext, customer: WireCustomer | null, customerId: string): Promise<IngestOutcome>
}

const stub =
  (kind: SquareObjectKind, wave: string) =>
  async (ctx: SquareIngestContext, obj: { id?: string; status?: string } | null): Promise<IngestOutcome> => {
    ctx.logger.info(
      { square: { event: ctx.event.event_id, type: ctx.event.type, kind, id: obj?.id ?? ctx.event.data.id, status: obj?.status } },
      'square event recorded (no ingest yet)',
    )
    return { status: 'processed', note: `recorded; the ${kind} ingest comes with ${wave}` }
  }

/** This wave's handlers: log and close the row. */
export const noopSquareIngest: SquareIngest = {
  payment: stub('payment', 'wave Q2b'),
  refund: stub('refund', 'wave Q2b'),
  invoice: stub('invoice', 'wave Q3b'),
  subscription: stub('subscription', 'wave Q3b'),
  card: stub('card', 'wave Q3a'),
  customer: (ctx, c) => stub('customer', 'wave Q3a')(ctx, c),
}

export interface ProcessDeps {
  db: Db
  clock: Clock
  logger: SquareLogger
  env: Env
  api: SquareApi
  ingest: SquareIngest
  locationId: string
  /** The merchant the connection test learned; a different one is ignored. */
  merchantId?: string | null
}

type Fetched =
  | { kind: 'payment'; obj: WirePayment }
  | { kind: 'refund'; obj: WireRefund }
  | { kind: 'invoice'; obj: WireInvoice }
  | { kind: 'subscription'; obj: WireSubscription }
  | { kind: 'card'; obj: WireCard }
  | { kind: 'customer'; obj: WireCustomer | null }

async function fetchObject(api: SquareApi, kind: SquareObjectKind, id: string, deleted: boolean): Promise<Fetched> {
  switch (kind) {
    case 'payment':
      return { kind, obj: await api.payments.get(id) }
    case 'refund':
      return { kind, obj: await api.refunds.get(id) }
    case 'invoice':
      return { kind, obj: await api.invoices.get(id) }
    case 'subscription':
      return { kind, obj: await api.subscriptions.retrieve(id, { includeActions: true }) }
    case 'card':
      return { kind, obj: await api.cards.retrieve(id) }
    case 'customer':
      return { kind, obj: deleted ? null : await api.customers.retrieve(id) }
  }
}

export async function processSquareEvent(d: ProcessDeps, event: WireEvent): Promise<IngestOutcome> {
  const c = classifySquareEvent(event)
  if (!c.kind) return { status: 'ignored', note: `event type ${event.type} is not handled` }
  if (d.merchantId && event.merchant_id && event.merchant_id !== d.merchantId)
    return { status: 'ignored', note: 'event of another merchant' }
  let fetched: Fetched
  try {
    fetched = await fetchObject(d.api, c.kind, c.objectId, c.deleted)
  } catch (e) {
    if (e instanceof SquareNotFound && c.kind === 'customer') fetched = { kind: 'customer', obj: null }
    else if (e instanceof SquareNotFound) return { status: 'ignored', note: `${c.kind} ${c.objectId} no longer exists at Square` }
    else throw e
  }
  const ours = squareLocationId(d.env)
  const loc = fetched.obj && 'location_id' in fetched.obj ? fetched.obj.location_id : undefined
  if (loc && ours && loc !== ours) return { status: 'ignored', note: `${c.kind} of another location` }
  return d.db.transaction().execute(async (tx) => {
    await advisoryXactLock(tx, `square:${c.kind}:${c.objectId}`)
    const ctx: SquareIngestContext = { tx, clock: d.clock, logger: d.logger, env: d.env, locationId: d.locationId, event }
    switch (fetched.kind) {
      case 'payment':
        return d.ingest.payment(ctx, fetched.obj)
      case 'refund':
        return d.ingest.refund(ctx, fetched.obj)
      case 'invoice':
        return d.ingest.invoice(ctx, fetched.obj)
      case 'subscription':
        return d.ingest.subscription(ctx, fetched.obj)
      case 'card':
        return d.ingest.card(ctx, fetched.obj)
      case 'customer':
        return d.ingest.customer(ctx, fetched.obj, c.objectId)
    }
  })
}
