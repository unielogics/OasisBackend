// Request and response schemas of the public website routes (strict bodies; the serializer enforces the responses).
import { z } from '../../../http/zod.js'
import { TOKEN_SHAPE } from '../../auth/tokens.js'

export const BizDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
// the shape check is lenient on purpose: the normaliser answers "Enter a valid mobile number." for anything that is not one
const Phone = z.string().trim().min(1, 'Enter a valid mobile number.').max(32, 'Enter a valid mobile number.')
const Short = (n: number) => z.string().trim().max(n)

export const AvailabilityQuery = z.object({
  days: z.coerce.number().int().min(1).max(14).default(5),
  service: Short(80).optional(),
  addons: Short(400).optional(),
})

export const BoardSlot = z.object({
  startMin: z.number().int(),
  start: z.string(),
  state: z.enum(['open', 'last', 'vip', 'booked']),
  bays: z.number().int(),
})

export const BoardDay = z.object({
  date: z.string(),
  label: z.string(),
  dateLabel: z.string(),
  weekday: z.number().int().min(0).max(6),
  closed: z.boolean(),
  reason: z.string().nullable(),
  openCount: z.number().int(),
  slots: z.array(BoardSlot),
})

export const BoardView = z.object({
  tz: z.string(),
  generatedAt: z.iso.datetime(),
  serviceKey: z.string(),
  durationMin: z.number().int(),
  now: z.object({ open: z.boolean(), baysFree: z.number().int(), baysTotal: z.number().int() }),
  days: z.array(BoardDay),
})

export const CatalogView = z.object({
  generatedAt: z.iso.datetime(),
  services: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      shortName: z.string(),
      durationMin: z.number().int(),
      priceCents: z.number().int(),
      tags: z.array(z.string()),
    }),
  ),
  addons: z.array(z.object({ key: z.string(), name: z.string(), priceCents: z.number().int(), tags: z.array(z.string()) })),
  plans: z.array(
    z.object({
      key: z.enum(['gold', 'vip']),
      name: z.string(),
      planKey: z.string(),
      planName: z.string().nullable(),
      perks: z.array(z.string()),
      priceCents: z.null(),
    }),
  ),
})

export const OtpBody = z.object({ phone: Phone }).strict()
export const OtpRequested = z.object({ challengeId: z.string(), expiresInSec: z.number().int() })

export const OtpVerifyBody = z
  .object({ challengeId: z.string().uuid(), code: z.string().trim().min(4).max(12) })
  .strict()

export const MemberView = z.object({
  firstName: z.string(),
  tier: z.enum(['gold', 'vip']).nullable(),
  washesLeft: z.number().int().nullable(),
  plan: z.string().nullable(),
  active: z.boolean(),
})

export const OtpVerified = z.object({
  memberToken: z.string(),
  expiresInSec: z.number().int(),
  member: MemberView,
})

export const VehicleBody = z
  .object({
    year: z.number().int().min(1900).max(2100).optional(),
    make: Short(40).optional(),
    model: Short(60).optional(),
    label: Short(80).optional(),
    plate: Short(16).optional(),
  })
  .strict()

export const BookingBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    phone: Phone,
    email: z.string().trim().email().max(120).optional(),
    vehicle: VehicleBody.optional(),
    serviceKey: z.string().trim().min(1).max(80),
    addonKeys: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    date: BizDate,
    startMin: z.number().int().min(0).max(1439),
    smsConsent: z.boolean(),
    memberToken: z.string().regex(TOKEN_SHAPE).optional(),
    /** The honeypot: a human never fills it. */
    website: z.string().max(200).default(''),
  })
  .strict()

export const BookingResult = z.object({
  bookingRef: z.string(),
  status: z.literal('booked'),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  bayCount: z.number().int(),
  deposit: z.object({ dueCents: z.number().int(), how: z.enum(['counter', 'link']) }),
  confirmationBy: z.enum(['sms', 'none']),
  service: z.object({ key: z.string(), name: z.string() }),
  addons: z.array(z.object({ key: z.string(), name: z.string() })),
  when: z.string(),
  member: z.boolean(),
})

export const MembershipBody = z
  .object({
    tier: z.enum(['gold', 'vip']),
    name: z.string().trim().min(1).max(80),
    phone: Phone,
    email: z.string().trim().email().max(120),
    vehicles: z.array(z.object({ car: Short(80), plate: Short(16).optional() }).strict()).min(1).max(5),
    smsConsent: z.boolean(),
    agree: z.literal(true),
    website: z.string().max(200).default(''),
  })
  .strict()

export const MembershipResult = z.object({
  memberRef: z.string(),
  status: z.literal('pending_payment'),
  next: z.literal('checkout_link_by_sms'),
  tier: z.enum(['gold', 'vip']),
  plan: z.string(),
  confirmationBy: z.enum(['sms', 'none']),
})
