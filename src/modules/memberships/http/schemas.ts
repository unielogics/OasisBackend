import { z } from '../../../http/zod.js'
import { AdjustResult } from '../../payments/http/schemas.js'

const Uuid = z.string().uuid()
export const IdParams = z.object({ id: Uuid })
/** A tier's key (gold, vip, …; ADR 0170). An input may name a tier by its old key (premium, executive). */
const PlanKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'Use a tier key such as gold')
const Status = z.enum(['pending', 'active', 'past_due', 'paused', 'canceled'])
const BizDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')

export const RuleCredit = z.object({
  ruleId: z.string(),
  label: z.string(),
  autoApply: z.boolean().describe('The rule redeems itself when a covered visit is completed'),
  unlimited: z.boolean(),
  granted: z.number().int().nullable(),
  used: z.number().int(),
  left: z.number().int().nullable(),
})

export const Retention = z.object({
  label: z.string(),
  desc: z.string(),
  tone: z.enum(['green', 'red']),
  state: z.enum(['loyal', 'watch', 'new']),
  cur30: z.number().int(),
  prev30: z.number().int(),
})

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** The billing block of a membership billed by Square (ADR 0171 wave Q3b). */
export const SquareBillingView = z.object({
  status: z.enum(['ok', 'failed']).describe('failed: a renewal Square could not charge (in grace until pastDueOn, past due until cancelOn)'),
  squareStatus: z.string().nullable().describe('Square’s status of the subscription: ACTIVE, PAUSED, CANCELED, DEACTIVATED, PENDING'),
  failedAt: z.string().nullable(),
  notifiedAt: z.string().nullable().describe('When the client was texted the card link (and emailed Square’s invoice page)'),
  pastDueOn: isoDate.nullable(),
  cancelOn: isoDate.nullable(),
  monthlyCents: z.number().int().nullable().describe('The monthly price billed (grandfathered until Move members)'),
  card: z
    .object({ brand: z.string().nullable(), last4: z.string().nullable(), expMonth: z.number().int().nullable(), expYear: z.number().int().nullable(), state: z.string() })
    .nullable(),
  cancelAt: isoDate.nullable().describe('Square ends the membership on this date (cancel at period end; undo while scheduled)'),
  pauseAt: isoDate.nullable().describe('Square pauses the membership on this date (the next billing date)'),
  change: z
    .object({
      kind: z.enum(['change', 'move']),
      planKey: z.string(),
      planClass: z.string(),
      monthlyCents: z.number().int(),
      effectiveDate: z.string().nullable(),
      swapAfter: z.string().nullable(),
    })
    .nullable()
    .describe('A tier or size change at the next billing date (staff), or a price move after its notice (Move members)'),
  lastInvoice: z
    .object({
      status: z.string(),
      amountCents: z.number().int(),
      dueDate: isoDate.nullable(),
      paidAt: z.string().nullable(),
      refundedCents: z.number().int(),
      payUrl: z.string().nullable().describe('Square’s own page for the invoice'),
    })
    .nullable(),
  enrollment: z.object({ state: z.string(), failure: z.string().nullable() }).nullable().describe('A membership that has not started: its latest enrollment'),
})

export const MembershipView = z.object({
  id: z.string(),
  customerId: z.string(),
  status: Status,
  source: z.enum(['squarespace', 'manual', 'square']).describe('square: billed by a Square subscription (ADR 0171 wave Q3b)'),
  plan: z.object({
    key: PlanKey,
    name: z.string(),
    label: z.string(),
    color: z.string(),
    bgColor: z.string(),
    tint: z.string(),
    perks: z.array(z.string()),
    addonDiscountBp: z.number().int(),
    serviceDiscountBp: z.number().int(),
    memberDiscountBp: z.number().int().describe('The member % off, in basis points (ADR 0170)'),
  }),
  planClass: z.string().describe('The size the membership is priced at: a covered line is covered up to this size’s price'),
  planClassLabel: z.string().nullable(),
  household: z
    .array(z.object({ customerId: z.string(), name: z.string(), addedAt: z.string() }))
    .describe('The other clients the membership covers (the holder is customerId); its credits are shared'),
  startedAt: z.string(),
  memberMonths: z.number().int(),
  currentPeriodStart: z.string().nullable(),
  renewsAt: z.string().nullable(),
  renewLabel: z.string().nullable(),
  inGrace: z.boolean(),
  canceledAt: z.string().nullable(),
  autoApply: z.boolean(),
  credits: z.object({
    cycleStart: z.string().nullable(),
    left: z.number().int().nullable(),
    used: z.number().int(),
    rules: z.array(RuleCredit),
  }),
  retention: Retention,
  flags: z.array(z.object({ code: z.string(), orderId: z.string().optional(), note: z.string() })),
  inferenceReason: z.string().nullable(),
  lastSqspOrderId: z.string().nullable(),
  checkout: z
    .object({
      id: z.string(),
      state: z.enum(['open', 'awaiting_match']),
      expectedEmail: z.string().nullable(),
      startedAt: z.string(),
      expiresAt: z.string(),
      order: z.object({ id: z.string(), number: z.string(), createdOn: z.string() }).nullable(),
    })
    .nullable()
    .describe(
      'The live Squarespace checkout: an open intent from a personal link waiting for its order, or a paid order that matches the client only through an unverified email and waits for staff (awaiting_match; confirm or reject it under /membership-checkouts)',
    ),
  billing: SquareBillingView.nullable().describe('How Square bills it (source square); null for any other membership'),
  version: z.number().int(),
})

export const Upgrade = z.object({
  candidate: z.boolean(),
  visits60: z.number().int(),
  copy: z.string().nullable(),
})

export const History = z.object({
  visitCount: z.number().int(),
  lifetimeSpendCents: z.number().int(),
  avgFreqDays: z.number().nullable(),
  favPackage: z.string().nullable(),
})

export const CustomerMembership = z.object({
  customerId: z.string(),
  membership: MembershipView.nullable(),
  sharedFrom: z
    .object({ customerId: z.string(), name: z.string() })
    .nullable()
    .describe('Set when the client is a household member of someone else’s membership (then `membership` is that one)'),
  upgrade: Upgrade.nullable(),
  history: History,
})

export const ListQuery = z.object({
  status: Status.optional(),
  plan: PlanKey.optional(),
  q: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(1024).optional(),
})

export const ListItem = MembershipView.extend({
  customer: z.object({ id: z.string(), name: z.string() }),
})

export const ListResult = z.object({
  items: z.array(ListItem),
  nextCursor: z.string().nullable(),
  counts: z.object({
    pending: z.number().int(),
    active: z.number().int(),
    past_due: z.number().int(),
    paused: z.number().int(),
    canceled: z.number().int(),
  }),
})

/** A vehicle size key (ADR 0170). */
const ClassKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'Pick one of the shop’s vehicle sizes.')

export const PatchBody = z
  .object({
    status: Status.optional(),
    planKey: PlanKey.optional(),
    planClass: ClassKey.optional().describe('The size the membership is priced at (a size of the shop)'),
    planLabel: z.string().trim().min(1).max(40).optional(),
    renewsOn: BizDate.optional(),
    autoApply: z.boolean().optional(),
    note: z.string().trim().max(200).nullable().optional(),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict()

export const CreateBody = z
  .object({
    customerId: Uuid,
    planKey: PlanKey,
    planClass: ClassKey.optional().describe(
      'The size the membership is priced at (a size of the shop that is on); absent: the smallest size the tier has a price for, else the smallest size',
    ),
    planLabel: z.string().trim().min(1).max(40).optional(),
    renewsOn: BizDate.optional(),
  })
  .strict()

export const HouseholdBody = z.object({ customerId: Uuid }).strict()
export const HouseholdParams = z.object({ id: Uuid, customerId: Uuid })

export const MembershipResult = z.object({ membership: MembershipView })

export const ApplyBody = z.object({}).strict()

export const ApplyResult = AdjustResult.extend({
  membershipId: z.string(),
  appointmentId: z.string(),
  rule: z.object({ id: z.string(), label: z.string() }),
  discountCents: z.number().int().describe('What the membership covered on the visit, all lines together'),
  credits: z.object({ left: z.number().int().nullable(), used: z.number().int() }),
  lines: z
    .array(
      z.object({
        inclusionId: z.string(),
        label: z.string(),
        serviceId: z.string(),
        serviceName: z.string(),
        kind: z.enum(['package', 'addon']),
        lineCents: z.number().int().describe('The line’s regular price'),
        coveredCents: z.number().int(),
        differenceCents: z.number().int().describe('The size difference that stays due (no % off)'),
        planClass: z.string(),
        visitClass: z.string().nullable(),
        eventId: z.string().describe('The adjust event'),
        redeemId: z.string(),
      }),
    )
    .describe('One entry per covered line (ADR 0170)'),
  repriced: z.boolean().describe('A line’s price changed before the coverage (covered at the regular price, others at the member price)'),
})

export const PlanRule = z.object({
  id: z.string(),
  label: z.string(),
  mode: z.enum(['per_cycle', 'every_visit']).describe('per_cycle: perCycle visits a billing cycle; every_visit: on every visit'),
  perCycle: z.number().int().nullable().describe('null = unlimited (always null for every_visit)'),
  autoApply: z.boolean(),
  active: z.boolean(),
  serviceIds: z.array(z.string()).describe('The services the inclusion covers'),
})

export const PlanView = z.object({
  id: z.string(),
  key: PlanKey,
  name: z.string(),
  active: z.boolean(),
  perks: z.array(z.string()),
  addonDiscountBp: z.number().int(),
  serviceDiscountBp: z.number().int(),
  memberDiscountBp: z.number().int().describe('The member % off, in basis points (ADR 0170)'),
  vipBooking: z.boolean(),
  inclusions: z.array(PlanRule),
  rules: z.array(PlanRule).describe('The inclusions under their old name (deprecated)'),
})

export const PlansResult = z.object({ plans: z.array(PlanView) })

export const RuleParams = z.object({ id: Uuid })
export const RulePatch = z.object({ autoApply: z.boolean() }).strict()

// ---- membership checkouts (ADR 0160) --------------------------------------------------------------------------------

export const CheckoutState = z.enum(['open', 'matched', 'awaiting_match', 'expired', 'superseded', 'abandoned', 'rejected'])

export const CheckoutView = z.object({
  id: z.string(),
  membershipId: z.string(),
  customer: z.object({ id: z.string(), name: z.string() }),
  state: CheckoutState,
  origin: z.enum(['link', 'sync']).describe('link: started on the membership page of a personal link; sync: opened by the order sync for staff'),
  planKey: z.string(),
  productKey: z.string().nullable(),
  expectedEmail: z.string().nullable(),
  startedAt: z.string(),
  expiresAt: z.string(),
  matchedAt: z.string().nullable(),
  order: z
    .object({
      id: z.string().describe('Squarespace order id'),
      number: z.string(),
      createdOn: z.string(),
      email: z.string().nullable(),
      totalCents: z.number().int(),
    })
    .nullable()
    .describe('The order the row is matched to, or waits for (awaiting_match)'),
  version: z.number().int(),
})

export const CheckoutListQuery = z.object({
  state: CheckoutState.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const CheckoutListResult = z.object({
  items: z.array(CheckoutView),
  awaitingMatch: z.number().int().describe('Rows waiting for staff at this location'),
})

export const CheckoutDecisionBody = z.object({ note: z.string().trim().max(200).nullable().optional() }).strict()

export const CheckoutDecisionResult = z.object({
  checkout: CheckoutView,
  membership: MembershipView.nullable(),
})
