// Zod schemas of the Payments API: request bodies (strict) and the response models documented in OpenAPI.
import { z } from '../../../http/zod.js'
import { FILTER_KEYS } from '../reports.js'
import { RANGE_KEYS } from '../ranges.js'

export const Uuid = z.string().uuid()
export const IdParams = z.object({ id: Uuid })
export const EventParams = z.object({ id: Uuid, eventId: Uuid })
export const EventOnlyParams = z.object({ id: Uuid })

/** Columns are int4: $21M is far above any invoice and keeps every sum inside the type. */
const Cents = z.number().int().max(2_000_000_000)
const PositiveCents = Cents.min(1)
const Reason = z.string().trim().min(1).max(80)
const Note = z.string().trim().max(500).nullable()

export const RangeQuery = z.object({ range: z.enum(RANGE_KEYS).default('7d') })
export const ListQuery = z.object({
  range: z.enum(RANGE_KEYS).default('7d'),
  filter: z.enum(FILTER_KEYS).default('all'),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().min(1).max(1024).optional(),
})
export const ExportQuery = ListQuery.omit({ limit: true, cursor: true })

export const CollectBody = z
  .object({
    method: z.enum(['card', 'cash', 'payment_link']),
    url: z.string().url().max(2000).optional(),
  })
  .strict()

export const RefundBody = z
  .object({
    mode: z.enum(['full', 'items', 'custom']),
    itemIds: z.array(Uuid).max(50).optional(),
    amountCents: PositiveCents.optional(),
    dest: z.enum(['card', 'credit', 'cash']),
    reason: Reason.optional(),
    note: Note.optional(),
  })
  .strict()

export const DenyBody = z.object({ note: Note.optional() }).strict()
export const ApproveBody = z.object({}).strict()

export const AdjustBody = z
  .object({
    kind: z.enum(['discount', 'surcharge']),
    unit: z.enum(['$', '%']),
    /** cents for '$'; basis points of the items subtotal for '%' (1000 = 10%) */
    value: PositiveCents,
    reason: Reason.optional(),
    note: Note.optional(),
    settle: z.enum(['credit', 'card']).optional(),
  })
  .strict()

export const EXPIRY_INPUTS = ['none', 'd30', 'd90', 'No expiry', '30 days', '90 days'] as const
export const CreditBody = z
  .object({
    amountCents: PositiveCents,
    reason: Reason.optional(),
    note: Note.optional(),
    expiry: z.enum(EXPIRY_INPUTS).default('d90'),
  })
  .strict()

export const VoidBody = z.object({ eventId: Uuid, note: Note.optional() }).strict()
export const TipBody = z.object({ tipCents: Cents.min(0) }).strict()
export const ReceiptBody = z.object({}).strict()
export const PaymentLinkBody = z
  .object({
    kind: z.enum(['balance', 'deposit']),
    amountCents: PositiveCents.optional(),
    url: z.string().url().max(2000).optional(),
  })
  .strict()
export const ConfirmBody = z
  .object({
    processorRef: z.string().trim().min(1).max(200).nullable().optional(),
    sqspOrderId: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()

// --- responses ----------------------------------------------------------------------------------------------------

const InvoiceStatus = z.enum([
  'paid',
  'unpaid',
  'partially_paid',
  'partially_refunded',
  'refunded',
  'canceled',
  'canceled_kept',
  'canceled_refunded',
])

export const LedgerEvent = z.object({
  id: z.string(),
  seq: z.number().int(),
  type: z.enum(['pay', 'adjust', 'refund', 'credit_issue', 'credit_apply', 'void']),
  status: z.enum(['pending', 'done', 'denied']),
  amountCents: z.number().int(),
  method: z.string().nullable(),
  methodKind: z.enum(['card', 'apple_pay', 'cash', 'store_credit', 'other']).nullable(),
  brand: z.string().nullable(),
  last4: z.string().nullable(),
  dest: z.enum(['card', 'credit', 'cash']).nullable(),
  deposit: z.boolean(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  expiry: z.enum(['none', 'd30', 'd90']).nullable(),
  expiryLabel: z.string().nullable(),
  expiresAt: z.string().nullable(),
  itemIds: z.array(z.string()),
  parentEventId: z.string().nullable(),
  voidsEventId: z.string().nullable(),
  voided: z.boolean(),
  by: z.string().nullable(),
  byRole: z.string().nullable(),
  approvedBy: z.string().nullable(),
  deniedBy: z.string().nullable(),
  at: z.string(),
  atLabel: z.string(),
  resolvedAt: z.string().nullable(),
  source: z.enum(['oasis', 'squarespace', 'system', 'seed', 'square']),
  processorState: z.enum(['na', 'awaiting_processor', 'confirmed', 'failed']),
  awaitingProcessor: z.boolean(),
  processorRef: z.string().nullable(),
  sqspOrderId: z.string().nullable(),
  processor: z.enum(['squarespace', 'square']).nullable(),
  processorOrderId: z.string().nullable(),
  needsReview: z.boolean(),
  canApprove: z.boolean(),
  approveBlock: z.enum(['permission', 'limit', 'self']).nullable(),
})

export const Calc = z.object({
  items: z.number().int(),
  adj: z.number().int(),
  sub: z.number().int(),
  tax: z.number().int(),
  tip: z.number().int(),
  total: z.number().int(),
  paidOrig: z.number().int(),
  creditApplied: z.number().int(),
  paid: z.number().int(),
  refunded: z.number().int(),
  refOrig: z.number().int(),
  pendingAmt: z.number().int(),
  pendingN: z.number().int(),
  issued: z.number().int(),
  balance: z.number().int(),
  refundable: z.number().int(),
  toOrigMax: z.number().int(),
  net: z.number().int(),
  overpaid: z.number().int(),
  status: InvoiceStatus,
})

const ClientCredit = z.object({
  balanceCents: z.number().int(),
  nextExpiry: z.object({ at: z.string(), cents: z.number().int() }).nullable(),
})

export const InvoiceDetail = z.object({
  id: z.string(),
  invoiceNo: z.number().int(),
  label: z.string(),
  appointmentId: z.string().nullable(),
  customerId: z.string(),
  client: z.string(),
  vehicle: z.string(),
  staff: z.string(),
  occurredAt: z.string(),
  bizDate: z.string(),
  when: z.string(),
  status: InvoiceStatus,
  statusLabel: z.string(),
  refundPending: z.boolean(),
  canceled: z.boolean(),
  cancelReason: z.enum(['canceled', 'no_show']).nullable(),
  taxBp: z.number().int(),
  tipCents: z.number().int(),
  paymentLinkUrl: z.string().nullable(),
  awaitingProcessorCount: z.number().int(),
  processing: z.object({
    processor: z.enum(['squarespace', 'square']).describe('PAYMENT_PROCESSOR: who takes new card money, links and refunds'),
    squarePosAppSwitch: z.boolean().describe('SQUARE_POS_API_ENABLED: "Open Square POS" (POST /invoices/{id}/square-pos-intents)'),
  }),
  version: z.number().int(),
  items: z.array(
    z.object({
      id: z.string(),
      position: z.number().int(),
      kind: z.enum(['package', 'addon']),
      name: z.string(),
      priceCents: z.number().int().describe('What the line charges'),
      refunded: z.boolean(),
      listCents: z.number().int().nullable().describe('The regular price at the visit’s size (ADR 0170); null on a line priced before sizes'),
      discountBp: z.number().int().nullable().describe('The member % off applied, in basis points'),
      memberDiscountCents: z.number().int().describe('list - price: the member % off in cents'),
      classLabel: z.string().nullable().describe('The size the line is priced at ("Large SUV")'),
    }),
  ),
  adjustments: z.array(
    z.object({
      eventId: z.string(),
      kind: z.enum(['discount', 'surcharge']),
      reason: z.string().nullable(),
      note: z.string().nullable(),
      amountCents: z.number().int(),
      coverage: z
        .object({
          serviceName: z.string(),
          coveredCents: z.number().int(),
          lineCents: z.number().int().describe('The covered line’s regular price'),
          differenceCents: z.number().int().describe('line - covered: the size difference that stays due (no % off)'),
          planClassLabel: z.string().nullable().describe('The size the membership is priced at'),
        })
        .nullable()
        .describe('A membership’s coverage of one line (ADR 0170): "Covered $40 · $20 size difference due"; null for any other adjustment'),
    }),
  ),
  calc: Calc,
  // the caps the refund command applies, per destination, after done and pending refunds (detail.ts RefundCapsDto)
  refundCaps: z.object({
    cardCents: z.number().int(),
    otherCents: z.number().int(),
    totalCents: z.number().int(),
  }),
  clientCredit: ClientCredit,
  ledger: z.array(LedgerEvent),
  caller: z
    .object({
      canCollect: z.boolean(),
      canRefund: z.boolean(),
      canAdjust: z.boolean(),
      canCredit: z.boolean(),
      canVoid: z.boolean(),
      refundLimitCents: z.number().int().nullable(),
      adjustLimitCents: z.number().int().nullable(),
      creditLimitCents: z.number().int().nullable(),
    })
    .nullable(),
})

export const EventResult = z.object({ event: LedgerEvent, invoice: InvoiceDetail })
export const AdjustResult = z.object({
  event: LedgerEvent,
  settlement: LedgerEvent.nullable(),
  invoice: InvoiceDetail,
})
export const InvoiceResult = z.object({ invoice: InvoiceDetail })
export const PaymentLinkResult = z.object({
  invoice: InvoiceDetail,
  paymentLink: z.object({
    id: z.string(),
    url: z.string().nullable().describe('null for the client’s personal pay page (its link is a secret only their text carries)'),
    expectedCents: z.number().int(),
    purpose: z.enum(['balance', 'deposit']),
    sms: z.string(),
    provider: z
      .enum(['squarespace', 'square', 'personal'])
      .describe('squarespace: a pasted checkout link; square: a Square link for the exact amount; personal: the client’s own pay page'),
  }),
})
export const CollectResult = z.object({
  event: LedgerEvent.optional(),
  paymentLink: PaymentLinkResult.shape.paymentLink.optional(),
  invoice: InvoiceDetail,
})
export const ReceiptResult = z.object({ sms: z.string(), email: z.string(), invoice: InvoiceDetail })

const PendingApproval = z.object({
  eventId: z.string(),
  invoiceId: z.string(),
  invoiceNo: z.number().int(),
  label: z.string(),
  client: z.string(),
  amountCents: z.number().int(),
  dest: z.string().nullable(),
  method: z.string().nullable(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  requestedBy: z.string().nullable(),
  requestedByRole: z.string().nullable(),
  requestedAt: z.string(),
  atLabel: z.string(),
  bizDate: z.string(),
})

export const Summary = z.object({
  range: z.object({ key: z.enum(RANGE_KEYS), from: z.string(), to: z.string(), label: z.string() }),
  kpis: z.object({
    grossSales: z.number().int(),
    netRevenue: z.number().int(),
    refunds: z.number().int(),
    adjustments: z.number().int(),
    creditsIssued: z.number().int(),
    outstanding: z.number().int(),
    counts: z.object({
      invoices: z.number().int(),
      refunded: z.number().int(),
      adjusted: z.number().int(),
      creditInvoices: z.number().int(),
      creditClients: z.number().int(),
      openBalances: z.number().int(),
    }),
  }),
  chart: z.object({
    granularity: z.enum(['hour', 'day']),
    buckets: z.array(
      z.object({
        key: z.union([z.string(), z.number()]),
        label: z.string(),
        title: z.string(),
        netCents: z.number().int(),
        lossCents: z.number().int(),
      }),
    ),
    maxCents: z.number().int(),
  }),
  byMethod: z.object({
    card: z.number().int(),
    applePay: z.number().int(),
    cash: z.number().int(),
    storeCredit: z.number().int(),
    other: z.number().int(),
  }),
  filterCounts: z.object({
    all: z.number().int(),
    unpaid: z.number().int(),
    refunds: z.number().int(),
    adjusted: z.number().int(),
    credits: z.number().int(),
  }),
  pendingApprovals: z.object({
    count: z.number().int(),
    text: z.string(),
    first: PendingApproval.nullable(),
    all: z.array(PendingApproval),
  }),
  awaitingProcessor: z.object({ count: z.number().int(), cents: z.number().int() }),
  byCategory: z
    .array(
      z.object({
        key: z.string().describe('A category key, "mixed" (two or more categories other than add-ons), or "_none" (no category)'),
        label: z.string(),
        colour: z.string().nullable().describe('#RRGGBB of the category; null for "mixed", "_none" and an unknown key'),
        count: z.number().int().describe('Invoices of the range counted under it'),
        grossCents: z.number().int(),
        netCents: z.number().int(),
        outstandingCents: z.number().int(),
      }),
    )
    .describe('The range’s invoices split by visit category (ADR 0160, plan K), each once: every active category (zero included) in the categories’ order, then "mixed"; an inactive category and "_none" only when something counts under them'),
})

export const ListRow = z.object({
  id: z.string(),
  invoiceNo: z.number().int(),
  label: z.string(),
  bizDate: z.string(),
  date: z.string(),
  time: z.string(),
  client: z.string(),
  vehicle: z.string(),
  staff: z.string(),
  items: z.object({ first: z.string(), more: z.number().int() }),
  totalCents: z.number().int(),
  paidCents: z.number().int(),
  balanceCents: z.number().int(),
  status: InvoiceStatus,
  statusLabel: z.string(),
  refundPending: z.boolean(),
  awaiting: z.enum(['payment', 'refund']).nullable(),
  adjusted: z.boolean(),
  categories: z.array(z.string()).describe('The visit’s category keys (its appointment’s), in the categories’ order: the chips'),
  category: z
    .string()
    .nullable()
    .describe('The one word the visit counts under: its category ignoring add-ons, "mixed" for two or more, null for none'),
})
export const ListResult = z.object({ items: z.array(ListRow), nextCursor: z.string().nullable() })

export const ApprovalsResult = z.object({
  items: z.array(
    PendingApproval.extend({
      canApprove: z.boolean(),
      approveBlock: z.enum(['permission', 'limit', 'self']).nullable(),
    }),
  ),
})

/** One Square payment waiting for a person (GET /payments/square/unmatched, the reconciliation). */
export const SquareCandidate = z.object({
  invoiceId: z.string(),
  invoiceNo: z.number().int(),
  client: z.string(),
  balanceCents: z.number().int(),
  awaitingEventId: z.string().nullable().describe('The staff card entry of the same amount on that invoice: applying confirms it'),
  score: z.number(),
  why: z.array(z.string()),
})

export const SquarePaymentToMatch = z.object({
  paymentId: z.string().describe('Square payment id'),
  matchState: z.enum(['pending', 'unmatched']).describe('pending: the matcher has not decided yet (counter payments wait a little)'),
  classification: z.string().nullable(),
  amountCents: z.number().int().describe('The sale, tip excluded'),
  tipCents: z.number().int(),
  totalCents: z.number().int(),
  refundedCents: z.number().int(),
  method: z.string().describe('"Visa ••4242", "Cash", "Square"'),
  sourceType: z.string().nullable(),
  brand: z.string().nullable(),
  last4: z.string().nullable(),
  note: z.string().nullable(),
  receiptNumber: z.string().nullable(),
  product: z.string().nullable().describe('SQUARE_POS, ECOMMERCE_API, ...'),
  createdAt: z.string(),
  ageMinutes: z.number().int(),
  candidates: z.array(SquareCandidate).describe('Best first (at most 5)'),
})

export const ReconciliationResult = z.object({
  thresholdMinutes: z.number().int(),
  awaitingProcessor: z.array(
    z.object({
      eventId: z.string(),
      invoiceId: z.string(),
      label: z.string(),
      client: z.string(),
      type: z.enum(['pay', 'refund']),
      amountCents: z.number().int(),
      method: z.string().nullable(),
      occurredAt: z.string(),
      ageMinutes: z.number().int(),
    }),
  ),
  unmatchedOrders: z.array(
    z.object({
      sqspOrderId: z.string(),
      orderNumber: z.string().nullable(),
      customerEmail: z.string().nullable(),
      totalCents: z.number().int(),
      createdAt: z.string(),
    }),
  ),
  unmatchedTransactions: z.array(
    z.object({
      sqspTransactionId: z.string(),
      sqspOrderId: z.string().nullable(),
      kind: z.enum(['payment', 'refund']),
      amountCents: z.number().int(),
      createdAt: z.string(),
    }),
  ),
  overpaid: z.array(
    z.object({
      invoiceId: z.string(),
      label: z.string(),
      client: z.string(),
      overpaidCents: z.number().int(),
      bizDate: z.string(),
    }),
  ),
  square: z
    .object({
      paymentsToMatch: z.array(SquarePaymentToMatch),
      failedRefunds: z.array(
        z.object({
          eventId: z.string(),
          invoiceId: z.string(),
          label: z.string(),
          client: z.string(),
          amountCents: z.number().int(),
          occurredAt: z.string(),
          refundedCents: z.number().int().describe('What Square did give back (still counted as refunded, as its own refund row)'),
          uncoveredCents: z.number().int().describe('What did not go back to the card and is not on its way: give it back another way'),
          errors: z.array(z.string()),
        }),
      ),
      refundsInFlight: z.number().int(),
    })
    .describe('Square (ADR 0171): payments to match, card refunds Square refused (no longer counted as refunded), refund legs on their way'),
})

export const ClientCreditResult = z.object({
  customerId: z.string(),
  balanceCents: z.number().int(),
  nextExpiry: z.object({ at: z.string(), cents: z.number().int() }).nullable(),
  entries: z.array(
    z.object({
      lotEventId: z.string(),
      invoiceId: z.string(),
      kind: z.enum(['issue', 'refund']),
      reason: z.string().nullable(),
      issuedCents: z.number().int(),
      usedCents: z.number().int(),
      remainingCents: z.number().int(),
      expiresAt: z.string().nullable(),
      state: z.enum(['active', 'used', 'expired']),
    }),
  ),
})
