// The public website's routes (ADR 0150): no session, a reason on every route, an in-memory per-address limit as the first ring
// and the durable per-phone / per-address counters behind the writes. GETs are cacheable for a minute (nginx caches them on the
// website's host); the two record-creating POSTs need an Idempotency-Key and run in the idempotency transaction, so the
// appointment, its invoice, its confirmation text, its audit row and its ops events commit together.
import { randomInt } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { access } from '../../../http/access.js'
import { canonicalQuery } from '../../../http/canonical-query.js'
import { idempotentHandler } from '../../../http/idempotent.js'
import { z } from '../../../http/zod.js'
import type { Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { getSetting } from '../../../platform/settings.js'
import { fmtT, wallToInstant } from '../../../platform/time.js'
import { MS_PER_MIN } from '../../scheduling/availability.js'
import { BOARD_DEFAULT_DAYS, loadBoard } from '../availability-loader.js'
import { bookingRefOf, chargeBookingLimits, createWebBooking, dollars } from '../bookings.js'
import { loadPublicCatalog } from '../catalog.js'
import { publicLocation, type PublicDeps, type PublicLocation, type PublicRequest } from '../deps.js'
import { chargeJoinLimits, joinWeb, memberRefOf } from '../memberships.js'
import { phoneOrThrow, requestOtp, verifyOtp } from '../otp.js'
import {
  AVAILABILITY_RAW_QUERY,
  AvailabilityQuery,
  BoardView,
  BookingBody,
  BookingResult,
  CatalogView,
  MembershipBody,
  MembershipResult,
  NoQuery,
  OtpBody,
  OtpRequested,
  OtpVerified,
  OtpVerifyBody,
} from './schemas.js'

const TAGS = ['public']
export const PUBLIC_MAX_AGE = 60

const idempotent = (h: ReturnType<typeof idempotentHandler>): never => h as never

const reqOf = (req: FastifyRequest): PublicRequest => {
  const key = req.headers['idempotency-key']
  return { ip: req.ip, requestId: req.id, idempotencyKey: typeof key === 'string' ? key : null }
}

export function registerPublicRoutes(d: PublicDeps): void {
  const { app } = d
  // The writes stay closed (the same 404 as an unknown route, before validation) until PUBLIC_WRITES_ENABLED: the website
  // composes texts instead (SITE_BOOKING=sms) until the SMS tablet and online booking are live.
  const writesOpen = {
    onRequest: (req: FastifyRequest, _reply: unknown, done: (err?: Error) => void): void => {
      if (app.env.PUBLIC_WRITES_ENABLED) return done()
      done(new AppError('ROUTE_NOT_FOUND', { meta: { method: req.method, path: req.url.split('?')[0] ?? '' } }))
    },
  }
  const loc = async (): Promise<PublicLocation> => {
    const l = await publicLocation(app.db, app.env.BUSINESS_TZ)
    if (!l) throw new AppError('SERVICE_UNAVAILABLE', { detail: 'The shop is not set up yet' })
    return l
  }

  app.get(
    '/public/availability',
    {
      config: {
        access: access.public('The website’s open-times board: slot states and free-bay counts, no names, ids or appointment data'),
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      preValidation: canonicalQuery(AVAILABILITY_RAW_QUERY),
      schema: {
        tags: TAGS,
        operationId: 'getPublicAvailability',
        summary: 'Open times for the website: the next days on the 30-minute grid with open / last / vip / booked and free bays',
        description:
          'No session. The slot engine’s answer for an online, non-VIP caller (lead time, cutoff, closures, emergency, VIP holds), reduced to the board’s four states; today drops starts before now plus the online lead time. ' +
          `\`days\` 1..14 (default ${BOARD_DEFAULT_DAYS}); \`service\` is a catalog key (the first package when absent); \`addons\` (catalog keys, comma-separated) is accepted and ignored (add-ons never change the duration). ` +
          'The query has one spelling: an unknown or repeated parameter, a percent-encoded name or value (but %2C between add-ons) or a number with a leading zero is a 422, so the 60-second cache in front cannot be bypassed. ' +
          `\`now\` is the "N of 3 bays open now" pill. \`Cache-Control: public, max-age=${PUBLIC_MAX_AGE}\`; 60 requests a minute per address.`,
        querystring: AvailabilityQuery,
        response: { 200: BoardView },
      },
    },
    async (req, reply) => {
      const l = await loc()
      const board = await loadBoard(app.db, {
        locationId: l.id,
        tz: l.tz,
        now: app.clock.now(),
        days: req.query.days === undefined ? BOARD_DEFAULT_DAYS : Number(req.query.days),
        serviceKey: req.query.service,
      })
      if (!board)
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Pick a wash from the catalog.',
          errors: [{ path: 'query.service', message: 'Pick a wash from the catalog.' }],
        })
      void reply.header('Cache-Control', `public, max-age=${PUBLIC_MAX_AGE}`)
      return board
    },
  )

  app.get(
    '/public/catalog',
    {
      config: {
        access: access.public('The website’s catalog: services, add-ons and the two plans with keys, durations and prices'),
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
      preValidation: canonicalQuery({}),
      schema: {
        tags: TAGS,
        operationId: 'getPublicCatalog',
        summary: 'Services, add-ons and plans for the website, with the keys the booking and join calls take',
        description:
          'No session. Live packages and add-ons from the real catalog (prices in cents, durations in minutes), keyed by the slug of their name; the plans are the website’s two tiers over the dashboard’s plans (no price: the site shows its own). ' +
          `\`Cache-Control: public, max-age=${PUBLIC_MAX_AGE}\`; 60 requests a minute per address.`,
        querystring: NoQuery,
        response: { 200: CatalogView },
      },
    },
    async (_req, reply) => {
      const l = await loc()
      void reply.header('Cache-Control', `public, max-age=${PUBLIC_MAX_AGE}`)
      return loadPublicCatalog(app.db, l.id, app.clock.now())
    },
  )

  app.post(
    '/public/otp',
    {
      ...writesOpen,
      config: {
        access: access.public('A one-time SMS code for a phone number the person typed; identifies a member without a session'),
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      schema: {
        tags: TAGS,
        operationId: 'requestPublicOtp',
        summary: 'Text a six-digit code to a mobile number (member identification)',
        description:
          'No session. 202 with the challenge id whether or not the number is known or the text could go out (nothing about the number leaks). The code lives 10 minutes, allows 3 tries and replaces any earlier code for the number. ' +
          '422 for a number that is not a US or Canadian mobile-capable number (another country, premium rate, toll free). Limits every 10 minutes: 10 per address, 3 per number from one address and 5 per number in all, charged in that order (a refused call charges nothing after the rule that refused it); 10 calls a minute per address (429 PUBLIC_RATE_LIMITED with Retry-After). ' +
          'At most PUBLIC_OTP_TEXTS_PER_HOUR codes are texted per rolling hour for every caller together: past it, 429 PUBLIC_CODES_PAUSED with Retry-After (the managers are told once an hour).',
        body: OtpBody,
        response: { 202: OtpRequested },
      },
    },
    async (req, reply) => {
      const l = await loc()
      const out = await requestOtp(d, l, reqOf(req), req.body)
      reply.status(202)
      return out
    },
  )

  app.post(
    '/public/otp/verify',
    {
      ...writesOpen,
      config: {
        access: access.public('Verifies a one-time SMS code and issues the opaque member token the booking call may carry'),
        rateLimit: { max: 20, timeWindow: '1 minute' },
      },
      schema: {
        tags: TAGS,
        operationId: 'verifyPublicOtp',
        summary: 'Verify a code: an opaque 30-minute member token and what the site may show about the member',
        description:
          'No session. 401 PUBLIC_OTP_INVALID (meta.attemptsLeft) for a wrong code, 429 PUBLIC_OTP_LOCKED after the third, 410 PUBLIC_OTP_EXPIRED for an expired, used or unknown code. The token is hashed at rest and bound to the number (and the customer owning it); `member` is the first name, the website tier (or null), the washes left this cycle and whether the membership is active (no booking fee).',
        body: OtpVerifyBody,
        response: { 200: OtpVerified },
      },
    },
    async (req) => verifyOtp(d, await loc(), reqOf(req), req.body),
  )

  app.post(
    '/public/bookings',
    {
      ...writesOpen,
      config: {
        access: access.public('The website books a real appointment for a guest or a verified member; no card data, Idempotency-Key required'),
        idempotency: 'required',
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      schema: {
        tags: TAGS,
        operationId: 'createPublicBooking',
        summary: 'Book a wash from the website',
        description:
          'No session; Idempotency-Key required (replay answers the stored response). A new number creates the customer (the transactional kind of SMS consent when asked for); the number of a customer the shop already has links the booking to them and changes their record (name, email, consent, vehicle) only with a member token issued for that customer, otherwise what was typed goes on the appointment’s internal log. Books through the same command as the dashboard with the online rules, on the board’s grid, creates the invoice, queues the confirmation text and the usual ops events. ' +
          'Member and VIP privileges (no fee, VIP-held times, the VIP booking window) need a member token for the customer: without one the booking is a guest’s, owes the fee at the counter or by payment link (`deposit`), and `member`, `deposit` and `confirmationBy` (what was asked for) answer the same for every number. ' +
          '409 PUBLIC_SLOT_TAKEN "That time was just taken. Pick another.", PUBLIC_SLOT_VIP, PUBLIC_SLOT_PAST, PUBLIC_SLOT_CLOSED, PUBLIC_SLOT_TOO_FAR; 401 PUBLIC_TOKEN_INVALID; 422 on validation (an impossible date, a start off the grid, a number the website does not text); 429 over 10 bookings an hour per address, 3 per number from one address or 5 per number. A non-empty `website` field (the honeypot) answers 202 with a fake reference and writes nothing.',
        body: BookingBody,
        response: { 201: BookingResult, 202: BookingResult },
      },
    },
    idempotent(
      idempotentHandler(
        async (req, tx, _reply, p: Prepared) => {
          const b = req.body as z.infer<typeof BookingBody>
          if (p.decoy) return { status: 202, body: await decoy(tx, p.loc, b) }
          return { status: 201, body: await createWebBooking(tx, d, p.loc, reqOf(req), b) }
        },
        {
          // on the pool, before the transaction opens: nothing inside it may wait for a second connection
          prepare: async (req): Promise<Prepared> => {
            const l = await loc()
            const b = req.body as z.infer<typeof BookingBody>
            if (b.website.trim() !== '') return { loc: l, decoy: true }
            await chargeBookingLimits(d, reqOf(req), phoneOrThrow(b.phone))
            return { loc: l, decoy: false }
          },
        },
      ),
    ),
  )

  app.post(
    '/public/memberships',
    {
      ...writesOpen,
      config: {
        access: access.public('The website’s join flow: a pending membership awaiting the Squarespace checkout link; no card data'),
        idempotency: 'required',
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
      schema: {
        tags: TAGS,
        operationId: 'createPublicMembership',
        summary: 'Join Gold or VIP from the website',
        description:
          'No session; Idempotency-Key required. A new number: the customer, their vehicles and a membership in the pending state tied to the tier’s Squarespace product (when the product map has none the membership still waits and an alert is raised); staff get a notification asking them to text the checkout link; the person gets a welcome text saying so. The membership activates when the Squarespace sync sees the paid order. ' +
          'The number of a customer the shop already has, without a member token issued for that customer: the same 201, nothing written to the record and no text; staff get the request to confirm with the customer. With the token: the full path, and 409 PUBLIC_ALREADY_MEMBER for a live membership. 422 on validation; 429 over 10 an hour per address, 2 a day per number from one address or 3 a day per number.',
        body: MembershipBody,
        response: { 201: MembershipResult, 202: MembershipResult },
      },
    },
    idempotent(
      idempotentHandler(
        async (req, tx, _reply, p: Prepared) => {
          const b = req.body as z.infer<typeof MembershipBody>
          if (p.decoy)
            return {
              status: 202,
              body: { memberRef: memberRefOf(app.newId()), status: 'pending_payment', next: 'checkout_link_by_sms', tier: b.tier, plan: b.tier === 'gold' ? 'Gold' : 'VIP', confirmationBy: 'sms' },
            }
          return { status: 201, body: await joinWeb(tx, d, p.loc, reqOf(req), b) }
        },
        {
          prepare: async (req): Promise<Prepared> => {
            const l = await loc()
            const b = req.body as z.infer<typeof MembershipBody>
            if (b.website.trim() !== '') return { loc: l, decoy: true }
            await chargeJoinLimits(d, reqOf(req), phoneOrThrow(b.phone))
            return { loc: l, decoy: false }
          },
        },
      ),
    ),
  )
}

/** What a record-creating POST resolved before its transaction: the location, and whether the honeypot was filled. */
interface Prepared {
  loc: PublicLocation
  decoy: boolean
}

/** The honeypot's answer: shaped like a booking, backed by nothing (read through the transaction, like everything in it). */
async function decoy(tx: Tx, l: PublicLocation, b: z.infer<typeof BookingBody>): Promise<z.infer<typeof BookingResult>> {
  const fee = await getSetting(tx, l.id, 'booking.guest_fee')
  const start = wallToInstant(b.date, b.startMin, l.tz)
  return {
    bookingRef: bookingRefOf(randomInt(10_000, 99_999)),
    status: 'booked',
    start: start.toISOString(),
    end: new Date(start.getTime() + 45 * MS_PER_MIN).toISOString(),
    bayCount: 1,
    deposit: { dueCents: fee.value.cents, how: fee.value.collect },
    confirmationBy: 'sms',
    service: { key: b.serviceKey, name: b.serviceKey },
    addons: [],
    when: `${b.date} · ${fmtT(b.startMin)} (${dollars(fee.value.cents)} fee)`,
    member: false,
  }
}
