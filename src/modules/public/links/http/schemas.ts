// Request and response schemas of the personal-link API (ADR 0160, design section 5). Bodies are strict except the code request's,
// which ignores what it does not know (a `phone` sent with it is dropped: the code only ever goes to the link's own number).
import { z } from '../../../../http/zod.js'
import { BizDate, TierKey, VehicleClassKey, WebPricing } from '../../http/schemas.js'

const iso = z.string()
const isoOrNull = z.string().nullable()

export const ExchangeBody = z
  .object({ token: z.string().min(1).max(200).describe('The token from the link’s fragment (#/c/<token>): sent only here, never in a URL') })
  .strict()

export const ClientView = z.object({
  firstName: z.string().describe('Empty for a stranger’s link, a name the shop does not have yet, or a record the stale-record rule hides'),
  last2: z.string().describe('The last two digits of the number the link was texted to'),
  tier: TierKey.nullable(),
})

export const AppointmentView = z.object({
  ref: z.string(),
  start: iso,
  end: iso,
  when: z.string(),
  service: z.string(),
  addons: z.array(z.string()),
  status: z.string(),
  canReschedule: z.boolean(),
})

export const InvoiceView = z.object({
  number: z.number().int(),
  date: z.string(),
  items: z.array(
    z.object({
      name: z.string(),
      priceCents: z.number().int().describe('What the line charges'),
      listCents: z.number().int().nullable().describe('The regular price at the size (ADR 0170); null on a line priced before sizes'),
      discountBp: z.number().int().nullable().describe('The member % off applied, in basis points'),
      memberDiscountCents: z.number().int(),
      classLabel: z.string().nullable().describe('The size the line is priced at'),
    }),
  ),
  coverage: z
    .array(
      z.object({
        serviceName: z.string(),
        coveredCents: z.number().int(),
        lineCents: z.number().int(),
        differenceCents: z.number().int(),
        planClassLabel: z.string().nullable(),
      }),
    )
    .describe('What the membership covered ("Covered $40 · $20 size difference due")'),
  subtotalCents: z.number().int(),
  taxCents: z.number().int(),
  tipCents: z.number().int(),
  totalCents: z.number().int(),
  paidCents: z.number().int(),
  balanceCents: z.number().int(),
})

export const PlanView = z.object({
  tier: TierKey.nullable(),
  planKey: z.string(),
  name: z.string(),
  monthlyPriceCents: z.number().int().nullable(),
  perks: z.array(z.string()),
  billing: z
    .enum(['square', 'squarespace'])
    .describe('square: the page joins with a card here (membership/subscribe, ADR 0171 wave Q3b); squarespace: the checkout (membership/start)'),
  prices: z
    .array(z.object({ class: z.string(), label: z.string(), monthlyCents: z.number().int(), joinable: z.boolean() }))
    .describe('The tier’s monthly price at each size it is sold at; joinable: set up at Square (always true for squarespace)'),
})

const CARD_PURPOSE = z.enum(['membership_billing', 'no_show_fee', 'late_cancel_fee', 'balance'])

export const SavedCardView = z.object({
  id: z.string().uuid(),
  brand: z.string().nullable().describe('VISA, MASTERCARD, AMERICAN_EXPRESS, ... as Square names it'),
  last4: z.string().nullable(),
  expMonth: z.number().int().nullable(),
  expYear: z.number().int().nullable(),
  purposes: z.array(CARD_PURPOSE).describe('What the client agreed the card may be charged for (live consents)'),
})

export const CardSetupView = z.object({
  consent: z.object({
    version: z.string().describe('Send it back as consentVersion'),
    text: z.string().describe('The wording; {purposes} is replaced by the ticked purposes, joined as "a, b and c"'),
    purposes: z.array(z.object({ key: CARD_PURPOSE, words: z.string() })).describe('Every purpose in the order the text lists them'),
    checkedByDefault: z.boolean().describe('Always false: the box starts unchecked'),
  }),
  square: z
    .object({
      applicationId: z.string(),
      locationId: z.string(),
      environment: z.enum(['sandbox', 'production']),
      sdkUrl: z.string().describe('Square’s Web Payments SDK, loaded only on this page'),
    })
    .nullable()
    .describe('Square’s Web Payments SDK settings (no secret); null when Square is not configured'),
})

export const LinkStateView = z.object({
  kind: z.enum(['calendar', 'verify', 'pin', 'membership', 'pay', 'book_again', 'card']),
  expiresAt: iso.describe('The session’s hard end (one hour after the exchange)'),
  idleExpiresAt: iso.describe('The session’s idle end (15 minutes after the last request)'),
  link: z.object({ expiresAt: iso }),
  client: ClientView,
  trust: z.object({
    verified: z.boolean().describe('This page is verified: by a PIN or code entered here, or by the number’s live 30-day trust'),
    by: z.enum(['pin', 'code']).nullable(),
    until: isoOrNull.describe('The end of the number’s 30-day trust, when it has one'),
  }),
  stepUp: z.object({
    method: z.enum(['pin', 'code']).describe('pin: the client has a PIN (enter it, or reset it with a code); code: a texted code'),
    freshUntil: isoOrNull.describe('Memberships and payments need a PIN or code entered here; until then the last one counts'),
    canSetPinUntil: isoOrNull.describe('A code confirmed here lets the page choose a PIN (or a new one after a reset code) until then'),
  }),
  appointments: z.array(AppointmentView).nullable().describe('The client’s upcoming visits; null until the page is verified'),
  invoice: InvoiceView.nullable(),
  plan: PlanView.nullable(),
  cards: z.array(SavedCardView).nullable().describe('The client’s active saved cards (ADR 0171 D7); card and membership pages, verified, the client proven; null otherwise'),
  cardSetup: CardSetupView.nullable().describe('What a card or membership page needs to take a card; null when saved cards are off'),
})

export const ExchangeResult = LinkStateView.extend({
  session: z.string().describe('The bearer token of the page: keep it in memory and send it as Authorization: Bearer <session>'),
})

export const CodeBody = z.object({
  purpose: z
    .enum(['verify', 'pin_set', 'pin_reset'])
    .default('verify')
    .describe('verify: confirm the page (refused once a PIN exists); pin_set: confirm, then choose a first PIN; pin_reset: replace a forgotten PIN'),
})

export const CodeRequested = z.object({
  challengeId: z.string(),
  expiresInSec: z.number().int(),
  purpose: z.enum(['verify', 'pin_set', 'pin_reset']),
  to: z.string().describe('The last two digits of the number the code was texted to'),
})

export const CodeConfirmBody = z.object({ challengeId: z.string().uuid(), code: z.string().trim().min(4).max(12) }).strict()

export const PinBody = z.object({ pin: z.string().trim().min(1).max(12) }).strict()

export const StepResult = LinkStateView.extend({
  verified: z.boolean().describe('This step verified the page (a pin_reset code verifies nothing by itself)'),
})

const VehicleBody = z
  .object({
    year: z.number().int().min(1900).max(2100).optional(),
    make: z.string().trim().max(40).optional(),
    model: z.string().trim().max(60).optional(),
    color: z.string().trim().max(30).optional(),
    label: z.string().trim().max(80).optional(),
    plate: z.string().trim().max(15).optional(),
  })
  .strict()

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const BookingBody = z
  .object({
    serviceKey: z.string().max(80).regex(KEY, 'Pick a wash from the catalog.'),
    addonKeys: z.array(z.string().max(80).regex(KEY, 'Pick add-ons from the catalog.')).max(12).default([]),
    date: BizDate,
    startMin: z.number().int().min(0).max(24 * 60),
    vehicle: VehicleBody.optional(),
    vehicleClass: VehicleClassKey.nullable()
      .optional()
      .describe('The size chip (ADR 0170): prices the visit and is recorded on the car; absent: the car’s size on file, else unknown'),
    name: z.string().trim().max(80).optional().describe('Required on a stranger’s link; fills a name the shop does not have yet'),
    email: z.string().trim().email('Enter a valid email.').max(254).optional(),
    smsConsent: z.boolean().optional().describe('A stranger’s consent to the texts about this booking'),
  })
  .strict()

export const BookingResult = z.object({
  bookingRef: z.string(),
  status: z.literal('booked'),
  start: iso,
  end: iso,
  deposit: z.object({ dueCents: z.number().int(), how: z.enum(['counter', 'link']) }),
  confirmationBy: z.enum(['sms', 'none']),
  service: z.object({ key: z.string(), name: z.string() }),
  addons: z.array(z.object({ key: z.string(), name: z.string() })),
  when: z.string(),
  member: z.boolean(),
  bayCount: z.number().int(),
  pricing: WebPricing,
})

export const RefParams = z.object({ ref: z.string().regex(/^OAS-\d{1,9}$/, 'A booking reference such as OAS-00042') })

export const RescheduleBody = z.object({ date: BizDate, startMin: z.number().int().min(0).max(24 * 60) }).strict()

export const RescheduleResult = z.object({ bookingRef: z.string(), status: z.string(), start: iso, end: iso, when: z.string() })

export const MembershipStartBody = z
  .object({
    email: z.string().trim().email('Enter a valid email.').max(254).describe('The email the client will pay with at Squarespace'),
    planClass: VehicleClassKey.optional().describe(
      'The vehicle size the membership is priced at (ADR 0170): a size the tier has a price for (422 TIER_CLASS_UNPRICED); absent: the tier’s cheapest priced size',
    ),
    vehicles: z
      .array(z.object({ car: z.string().trim().min(1).max(80), plate: z.string().trim().max(15).optional() }).strict())
      .max(5)
      .optional(),
  })
  .strict()

export const MembershipStartResult = z.object({
  redirectUrl: z.string().describe('The plan’s Squarespace checkout (https, squarespace.com only)'),
  membershipRef: z.string(),
  checkoutExpiresAt: iso,
})

export const PayStartBody = z.object({}).strict()

export const DepositStartBody = z.object({ bookingRef: z.string().trim().min(5).max(16).describe('OAS-n, as the booking answered') }).strict()

export const DepositStartResult = z.object({
  status: z
    .enum(['redirect', 'paid', 'none', 'link_pending'])
    .describe('redirect: go to redirectUrl (Square); paid: nothing owed; none: no deposit link for that visit; link_pending: the shop will text it'),
  redirectUrl: z.string().nullable(),
  amountCents: z.number().int().describe('The deposit (0 when none)'),
})

export const PayStartResult = z.object({
  status: z.enum(['redirect', 'link_pending']).describe('redirect: go to redirectUrl; link_pending: the shop will text a payment link'),
  redirectUrl: z
    .string()
    .nullable()
    .describe('The payment URL (https on an allowed host only): with Square a link for the exact balance; null when link_pending'),
})
