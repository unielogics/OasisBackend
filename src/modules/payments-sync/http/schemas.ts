import { z } from '../../../http/zod.js'

const Uuid = z.string().uuid()
const Instant = z.string()

export const OrderParams = z.object({ id: z.string().min(1).max(64) })
export const AlertParams = z.object({ id: Uuid })
export const LinkParams = z.object({ sqspCustomerId: z.string().min(1).max(64) })

export const Connection = z.object({
  configured: z.boolean(),
  keySource: z.enum(['database', 'environment', 'simulator', 'none']),
  authKind: z.enum(['api_key', 'oauth']),
  status: z.enum(['connected', 'error', 'disconnected', 'unconfigured']),
  siteId: z.string().nullable(),
  lastError: z.string().nullable(),
  lastVerifiedAt: Instant.nullable(),
  updatedAt: Instant.nullable(),
})

const Resource = z.object({
  status: z.string(),
  watermark: Instant.nullable(),
  lastRunAt: Instant.nullable(),
  lastSuccessAt: Instant.nullable(),
  lagSeconds: z.number().int().nullable(),
  consecutiveFailures: z.number().int(),
  lastError: z.string().nullable(),
})

export const Alert = z.object({
  id: z.string(),
  code: z.string(),
  orderId: z.string().nullable(),
  transactionId: z.string().nullable(),
  invoiceId: z.string().nullable(),
  message: z.string(),
  variance: z.unknown().nullable(),
  createdAt: Instant,
})

export const Status = z.object({
  provider: z.enum(['sim', 'live']),
  pollIntervalSeconds: z.number().int(),
  connection: Connection,
  sync: z.object({ orders: Resource, transactions: Resource, contacts: Resource, reconcile: Resource }),
  /** Seconds since the orders poll last succeeded; null when it never has. */
  lagSeconds: z.number().int().nullable(),
  counts: z.object({
    orders: z.object({
      unmatched: z.number().int(),
      auto: z.number().int(),
      manual: z.number().int(),
      ignored: z.number().int(),
      membership: z.number().int(),
    }),
    transactions: z.object({
      new: z.number().int(),
      matched: z.number().int(),
      manual: z.number().int(),
      ignored: z.number().int(),
      deferred: z.number().int(),
      membership: z.number().int(),
    }),
    manualQueueOpen: z.number().int(),
    awaitingProcessor: z.object({ count: z.number().int(), cents: z.number().int() }),
    deadLetters: z.number().int(),
  }),
  productMap: z.object({ entries: z.number().int(), empty: z.boolean() }),
  webhook: z.object({
    subscriptions: z.number().int(),
    lastDeliveryAt: Instant.nullable(),
    secretConfigured: z.boolean(),
  }),
  alerts: z.array(Alert),
})

export const SyncNowBody = z
  .object({ resume: z.boolean().optional(), rematch: z.boolean().optional() })
  .strict()
export const SyncNowResult = z.object({
  mode: z.enum(['queued', 'inline']),
  queued: z.boolean(),
  result: z
    .object({
      status: z.string(),
      ordersSeen: z.number().int(),
      ordersChanged: z.boolean(),
      matched: z.object({
        ordersProcessed: z.number().int(),
        confirmedAwaiting: z.number().int(),
        paymentsRecorded: z.number().int(),
        externalRefunds: z.number().int(),
        manual: z.number().int(),
        ignored: z.number().int(),
        membership: z.number().int(),
      }),
    })
    .nullable(),
})

export const ConnectionBody = z
  .object({
    apiKey: z.string().trim().min(8).max(512),
    siteId: z.string().trim().min(1).max(100).optional(),
    /** Call Squarespace once with the key before storing it (default true). */
    verify: z.boolean().default(true),
  })
  .strict()

const Plan = z.enum(['essential', 'premium', 'executive', 'exotic'])

export const ProductInput = z
  .object({
    productId: z.string().trim().min(1).max(100).nullish(),
    sku: z.string().trim().min(1).max(100).nullish(),
    name: z.string().trim().max(200).nullish(),
    kind: z.enum(['membership', 'service']),
    plan: Plan.nullish(),
    planLabel: z.string().trim().min(1).max(40).nullish(),
    intervalMonths: z.number().int().min(1).max(12).nullish(),
    serviceId: Uuid.nullish(),
    active: z.boolean().optional(),
  })
  .strict()

export const ProductMapBody = z.object({ entries: z.array(ProductInput).max(300) }).strict()

export const ProductMapResult = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      productId: z.string().nullable(),
      sku: z.string().nullable(),
      name: z.string().nullable(),
      kind: z.enum(['membership', 'service']),
      plan: Plan.nullable(),
      planLabel: z.string().nullable(),
      intervalMonths: z.number().int(),
      serviceId: z.string().nullable(),
      active: z.boolean(),
    }),
  ),
  environmentEntries: z.number().int(),
  seen: z.array(
    z.object({
      productId: z.string().nullable(),
      sku: z.string().nullable(),
      name: z.string(),
      orders: z.number().int(),
      lastSeen: Instant,
      mapped: z.boolean(),
    }),
  ),
  plans: z.array(z.object({ key: Plan, name: z.string() })),
  reopenedOrders: z.number().int(),
})

export const OrdersQuery = z.object({
  state: z.enum(['unmatched', 'auto', 'manual', 'ignored', 'membership', 'all']).default('unmatched'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(1024).optional(),
})

export const OrderItem = z.object({
  sqspOrderId: z.string(),
  orderNumber: z.string(),
  createdOn: Instant,
  modifiedOn: Instant,
  customerEmail: z.string().nullable(),
  customerName: z.string().nullable(),
  customerPhone: z.string().nullable(),
  paymentState: z.string().nullable(),
  totalCents: z.number().int(),
  refundedCents: z.number().int(),
  currency: z.string(),
  matchState: z.enum(['unmatched', 'auto', 'manual', 'ignored', 'membership']),
  ignoreReason: z.string().nullable(),
  matchedInvoiceId: z.string().nullable(),
  lineItems: z.array(
    z.object({
      name: z.string(),
      sku: z.string().nullable(),
      productId: z.string().nullable(),
      qty: z.number().int(),
      unitCents: z.number().int(),
    }),
  ),
  transactions: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['payment', 'refund']),
      amountCents: z.number().int(),
      state: z.string(),
      createdOn: Instant,
      brand: z.string().nullable(),
    }),
  ),
  matches: z.array(
    z.object({
      kind: z.string(),
      transactionId: z.string().nullable(),
      eventId: z.string().nullable(),
      invoiceId: z.string().nullable(),
      rule: z.string().nullable(),
      confidence: z.number().nullable(),
      manual: z.boolean(),
      variance: z.unknown().nullable(),
      at: Instant,
    }),
  ),
  queue: z.array(
    z.object({
      id: z.string(),
      reason: z.string(),
      transactionId: z.string().nullable(),
      candidates: z.unknown(),
      variance: z.unknown().nullable(),
      createdAt: Instant,
    }),
  ),
})

export const OrdersResult = z.object({ items: z.array(OrderItem), nextCursor: z.string().nullable() })

export const MatchBody = z
  .object({
    invoiceId: Uuid.optional(),
    eventId: Uuid.optional(),
    force: z.boolean().optional(),
  })
  .strict()
export const MatchResult = z.object({
  orderId: z.string(),
  invoiceId: z.string(),
  applied: z.array(
    z.object({
      kind: z.enum(['payment', 'refund']),
      transactionId: z.string().nullable(),
      eventId: z.string(),
      how: z.enum(['confirmed', 'recorded']),
    }),
  ),
})

export const IgnoreBody = z.object({ reason: z.string().trim().max(200).optional() }).strict()
export const IgnoreResult = z.object({ orderId: z.string(), alreadyIgnored: z.boolean() })

export const LinkBody = z.object({ customerId: Uuid }).strict()
export const LinkResult = z.object({
  sqspCustomerId: z.string(),
  customerId: z.string(),
  membershipsCreated: z.number().int(),
  membershipsUpdated: z.number().int(),
})

export const ResolveResult = z.object({ resolved: z.boolean() })

export const EmptyBody = z.object({}).strict()
