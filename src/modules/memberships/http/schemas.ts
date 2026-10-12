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

export const MembershipView = z.object({
  id: z.string(),
  customerId: z.string(),
  status: Status,
  source: z.enum(['squarespace', 'manual']),
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
  }),
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

export const PatchBody = z
  .object({
    status: Status.optional(),
    planKey: PlanKey.optional(),
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
    planLabel: z.string().trim().min(1).max(40).optional(),
    renewsOn: BizDate.optional(),
  })
  .strict()

export const MembershipResult = z.object({ membership: MembershipView })

export const ApplyBody = z.object({}).strict()

export const ApplyResult = AdjustResult.extend({
  membershipId: z.string(),
  appointmentId: z.string(),
  rule: z.object({ id: z.string(), label: z.string() }),
  discountCents: z.number().int(),
  credits: z.object({ left: z.number().int().nullable(), used: z.number().int() }),
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
