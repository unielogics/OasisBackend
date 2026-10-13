// The personal-link API (ADR 0160, design section 5, wave W3c): /api/v1/public/links/*. The website's link pages
// (https://oasisautospanj.com/#/c|m|p|pin|v|k/<token>) exchange the token from the URL fragment, in a POST body and nowhere else, for a
// bearer session (Authorization: Bearer <session>, held in the page's memory) and act through it. Every route:
//   - answers the same 404 as an unknown route, before validation, any limit or any record, while PUBLIC_LINKS_ENABLED is false;
//   - is never cached (Cache-Control: no-store) and answers JSON only (a POST in another content type is 415), with <, > and & escaped
//     in the JSON text so no answer can be read as markup;
//   - refuses an Origin outside the allowlist when one is sent (403), on reads as well as writes, and sets or reads no cookie;
//   - is limited per client address in memory (the first ring) and by durable counters per address (an IPv6 address by its /64),
//     link, session and number.
import type { FastifyReply, FastifyRequest } from 'fastify'
import { access } from '../../../../http/access.js'
import { allowedOrigins } from '../../../../http/hooks.js'
import { idempotentHandler } from '../../../../http/idempotent.js'
import type { AppInstance } from '../../../../http/types.js'
import { z } from '../../../../http/zod.js'
import { transaction, type Executor } from '../../../../platform/db.js'
import { AppError } from '../../../../platform/errors.js'
import { ipLimitKey } from '../../../../platform/ip.js'
import type { ScryptParams } from '../../../auth/password.js'
import { consumeLink } from '../../../identity/links.js'
import { confirmStepUpCode, requestStepUpCode, type StepUpPurpose } from '../../../identity/codes.js'
import { identityDeps, type IdentityDeps, type IdentityQueue } from '../../../identity/deps.js'
import { resetSessionPin, setSessionPin, verifySessionPin } from '../../../identity/pin-service.js'
import { exchangeLink, resolveSession, type SessionView } from '../../../identity/sessions.js'
import { linkHostsFromEnv } from '../../../payments/ports.js'
import type { SchedulingPorts } from '../../../scheduling/ports.js'
import { BOARD_DEFAULT_DAYS } from '../../availability-loader.js'
import { enforceLimits, type LimitRule } from '../../limits.js'
import { AvailabilityQuery, BoardView } from '../../http/schemas.js'
import { loadLinkBoard } from '../board.js'
import { squareProcessor } from '../../../square/links.js'
import { startSquareDeposit, startSquarePayment } from '../../../square/public.js'
import { squareEnv } from '../../../square/runtime.js'
import {
  bookOnLink,
  linkLocation,
  linkState,
  privilegesOf,
  requireKind,
  rescheduleOnLink,
  startMembership,
  startPayment,
  type LinkDeps,
  type LinkRequest,
  type LinkState,
} from '../service.js'
import {
  BookingBody,
  BookingResult,
  CodeBody,
  CodeConfirmBody,
  CodeRequested,
  ExchangeBody,
  ExchangeResult,
  LinkStateView,
  MembershipStartBody,
  MembershipStartResult,
  DepositStartBody,
  DepositStartResult,
  PayStartBody,
  PayStartResult,
  PinBody,
  RefParams,
  RescheduleBody,
  RescheduleResult,
  StepResult,
} from './schemas.js'
import { registerCardLinkRoutes } from './card-routes.js'
import { registerSubscribeLinkRoutes } from './subscribe-routes.js'
import '../problems.js'

const TAGS = ['public-links']
export const LINKS_PREFIX = '/public/links'

/** Durable limits of the link routes (public_rate_limits, shared by every API process), on top of the identity core's own. */
export const LINK_LIMITS = {
  exchange: { ip: { max: 30, windowSec: 600 } },
  codeConfirm: { ip: { max: 30, windowSec: 600 } },
  pin: { ip: { max: 30, windowSec: 600 }, session: { max: 10, windowSec: 600 } },
  booking: { ip: { max: 10, windowSec: 3600 }, link: { max: 5, windowSec: 3600 }, phone: { max: 5, windowSec: 3600 } },
  reschedule: { ip: { max: 10, windowSec: 3600 }, phone: { max: 5, windowSec: 3600 } },
  membership: { ip: { max: 10, windowSec: 3600 }, phone: { max: 5, windowSec: 86_400 } },
  pay: { ip: { max: 20, windowSec: 3600 }, phone: { max: 10, windowSec: 3600 } },
} as const satisfies Record<string, Record<string, LimitRule>>

const SESSION_HEADER = /^Bearer ([A-Za-z0-9_-]{43})$/

/** The page's bearer session token, or 401 IDENTITY_SESSION_INVALID (no header, another scheme, not a token's shape). */
export function bearerOf(req: FastifyRequest): string {
  const h = req.headers.authorization
  const m = typeof h === 'string' ? SESSION_HEADER.exec(h) : null
  if (!m) throw new AppError('IDENTITY_SESSION_INVALID')
  return m[1]!
}

const reqOf = (req: FastifyRequest): LinkRequest => {
  const key = req.headers['idempotency-key']
  return { ip: req.ip, requestId: req.id, idempotencyKey: typeof key === 'string' ? key : null }
}

/** JSON text with <, > and & as \u escapes (still the same JSON): an answer read as HTML can never contain markup. */
export const escapeJson = (s: string): string =>
  s.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

export function stateDto(s: LinkState): z.infer<typeof LinkStateView> {
  return {
    kind: s.kind,
    expiresAt: s.expiresAt.toISOString(),
    idleExpiresAt: s.idleExpiresAt.toISOString(),
    link: { expiresAt: s.link.expiresAt.toISOString() },
    client: s.client,
    trust: { verified: s.trust.verified, by: s.trust.by, until: iso(s.trust.until) },
    stepUp: { method: s.stepUp.method, freshUntil: iso(s.stepUp.freshUntil), canSetPinUntil: iso(s.stepUp.canSetPinUntil) },
    appointments: s.appointments,
    invoice: s.invoice,
    plan: s.plan,
    cards: s.cards,
    cardSetup: s.cardSetup,
  }
}

const PURPOSE: Record<'verify' | 'pin_set' | 'pin_reset', StepUpPurpose> = { verify: 'link_verify', pin_set: 'pin_set', pin_reset: 'pin_reset' }
const PURPOSE_OUT: Record<StepUpPurpose, 'verify' | 'pin_set' | 'pin_reset'> = { link_verify: 'verify', pin_set: 'pin_set', pin_reset: 'pin_reset' }

export interface LinkRoutesDeps {
  app: AppInstance
  /** The messaging queue the step-up codes are texted through. */
  queue: IdentityQueue
  /** The scheduling ports a link booking is created with (the dashboard's invoice gateway, memberships, queue). */
  scheduling: SchedulingPorts
  /** The PIN hasher's scrypt cost (tests pass a cheap one; production the auth default). */
  scrypt?: ScryptParams
}

/**
 * What every link route is built with, handed to the route files of later waves (card-routes.ts: cards on file, wave Q3a;
 * subscribe-routes.ts: memberships on Square, wave Q3b) so they follow the same rules as the routes here.
 */
export interface LinkRouteKit {
  app: AppInstance
  deps: LinkDeps
  /** Spread into every route's options: closed = the unknown-route 404, no-store, the Origin allowlist, JSON only, escaped JSON. */
  guard: {
    onRequest: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    preValidation: (req: FastifyRequest) => Promise<void>
    onSend: (req: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown>
  }
  /** The route config: public with a reason, the in-memory per-address limit per minute, optionally a required Idempotency-Key. */
  cfg: typeof linkRouteConfig
  /** The page's session from its bearer header (401 IDENTITY_SESSION_INVALID). */
  session: (db: Executor, req: FastifyRequest, o?: { touch?: boolean; forUpdate?: boolean }) => Promise<SessionView>
  /** Durable limits (public_rate_limits): 429 PUBLIC_RATE_LIMITED. */
  limit: (checks: { key: string; rule: LimitRule }[]) => Promise<void>
  /** `/public/links` + path. */
  path: (p: string) => string
  reqOf: (req: FastifyRequest) => LinkRequest
  tags: string[]
  bearerNote: string
}

export function linkRouteConfig(reason: string, max: number, extra: { idempotency?: 'required' } = {}) {
  return { access: access.public(reason), rateLimit: { max, timeWindow: '1 minute' }, ...extra }
}

export function registerLinkRoutes(d: LinkRoutesDeps): void {
  const { app } = d
  const origins = allowedOrigins(app.env)
  // built on first use, only once the routes are open: PIN_PEPPER is required (and present) only while PUBLIC_LINKS_ENABLED is true
  let identity: IdentityDeps | null = null
  const id = (): IdentityDeps =>
    (identity ??= identityDeps({ db: app.db, clock: app.clock, newId: app.newId, env: app.env, queue: d.queue, log: app.log, scrypt: d.scrypt }))
  const deps: LinkDeps = {
    app,
    scheduling: d.scheduling,
    linkHosts: linkHostsFromEnv(app.env.PAYMENT_LINK_HOSTS, {
      processor: app.env.PAYMENT_PROCESSOR,
      production: app.env.NODE_ENV === 'production',
    }),
  }

  const guard = {
    onRequest: async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
      // closed: exactly the answer of an unknown route (no header of ours, nothing validated, limited or written); the API version
      // header the app hook sets on matched /api/ routes goes too, so a prober cannot tell which paths exist
      if (!app.env.PUBLIC_LINKS_ENABLED) {
        void reply.removeHeader('X-API-Version')
        throw new AppError('ROUTE_NOT_FOUND', { meta: { method: req.method, path: req.url.split('?')[0] ?? '' } })
      }
      void reply.header('Cache-Control', 'no-store')
      const origin = req.headers.origin
      if (origin !== undefined && (origin === 'null' || !origins.has(origin))) throw new AppError('ORIGIN_NOT_ALLOWED')
    },
    preValidation: async (req: FastifyRequest): Promise<void> => {
      if (req.method !== 'POST') return
      if (!/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] ?? '').trim())) throw new AppError('UNSUPPORTED_MEDIA_TYPE')
    },
    onSend: async (_req: FastifyRequest, reply: FastifyReply, payload: unknown): Promise<unknown> => {
      if (!app.env.PUBLIC_LINKS_ENABLED || typeof payload !== 'string') return payload
      return /json/i.test(String(reply.getHeader('content-type') ?? '')) ? escapeJson(payload) : payload
    },
  }
  const cfg = linkRouteConfig
  const session = (db: Executor, req: FastifyRequest, o: { touch?: boolean; forUpdate?: boolean } = {}): Promise<SessionView> =>
    resolveSession(db, bearerOf(req), app.clock.now(), o)
  const limit = (checks: { key: string; rule: LimitRule }[]): Promise<void> => enforceLimits(app.db, app.clock, checks)
  /** A verify (or PIN) link is used up by the step that verified its page; a second page of the same link still verified. */
  const complete = async (s: SessionView, kinds: readonly string[]): Promise<void> => {
    if (!kinds.includes(s.link.kind)) return
    try {
      await transaction(app.db, (tx) => consumeLink(tx, s.link.id, app.clock.now()))
    } catch (e) {
      if (!(e instanceof AppError) || (e.code !== 'IDENTITY_LINK_USED' && e.code !== 'IDENTITY_LINK_INVALID')) throw e
    }
  }
  const stateOf = async (s: SessionView) => stateDto(await linkState(app.db, s, app.clock.now()))
  const P = (path: string): string => `${LINKS_PREFIX}${path}`
  const bearerNote = 'Bearer session (`Authorization: Bearer <session>` from the exchange); no cookie.'

  app.post(
    P('/exchange'),
    {
      ...guard,
      config: cfg('A personal link page trades the token from its URL fragment (POST body only) for a short bearer session', 20),
      schema: {
        tags: TAGS,
        operationId: 'exchangeClientLink',
        summary: 'Open a personal link: the token for a bearer session and what the page may show',
        description:
          'The token is the 43-character value after `#/c/`, `#/m/`, `#/p/`, `#/pin/`, `#/v/` or `#/k/`; it is sent only in this body and never logged. Opening uses nothing of the link. ' +
          '401 `IDENTITY_LINK_INVALID` (`meta.reason` `not_found` | `expired` | `used` | `revoked`) for a token that is unknown, of another shape, expired, used up, superseded, revoked (STOP, a PIN or phone change, a links-epoch bump, staff) or past its exchanges. 30 exchanges per address every 10 minutes.',
        body: ExchangeBody,
        response: { 200: ExchangeResult },
      },
    },
    async (req) => {
      await limit([{ key: `link_exchange:ip:${ipLimitKey(req.ip)}`, rule: LINK_LIMITS.exchange.ip }])
      const ex = await exchangeLink(app.db, { token: req.body.token, ip: req.ip, now: app.clock.now() })
      return { session: ex.session, ...(await stateOf(ex.view)) }
    },
  )

  app.get(
    P('/me'),
    {
      ...guard,
      config: cfg('The state of a personal link page for its bearer session: first name, trust, step-up, own visits once verified', 60),
      schema: {
        tags: TAGS,
        operationId: 'getClientLinkState',
        summary: 'The page’s state (slides the 15-minute idle window)',
        description: `${bearerNote} 401 \`IDENTITY_SESSION_INVALID\` for a session that is unknown, idle, past its hour, locked after five wrong entries, or whose link died.`,
        response: { 200: LinkStateView },
      },
    },
    async (req) => stateOf(await session(app.db, req)),
  )

  app.get(
    P('/availability'),
    {
      ...guard,
      config: cfg('The open times of a calendar link page for its client: never cached, VIP-aware only when the page is verified', 60),
      schema: {
        tags: TAGS,
        operationId: 'getClientLinkAvailability',
        summary: 'Open times for the page’s client (calendar and book-again links)',
        description:
          `${bearerNote} The website’s board (section 26.1, the same query) evaluated for this client: the VIP rules (VIP-held times, the VIP window) only when the page is verified and its client is a VIP client or an active member of the VIP plan, never during the 72 hours after a PIN reset (\`vip\` says which). \`Cache-Control: no-store\`. 401 \`LINK_WRONG_PURPOSE\` on another kind of link.`,
        querystring: AvailabilityQuery,
        response: { 200: BoardView.extend({ vip: z.boolean() }) },
      },
    },
    async (req) => {
      const now = app.clock.now()
      const s = await session(app.db, req)
      requireKind(s, ['calendar', 'book_again'])
      const loc = await linkLocation(app.db, s.link.locationId)
      const { vip } = await privilegesOf(app.db, s, now)
      const board = await loadLinkBoard(app.db, {
        locationId: loc.id,
        tz: loc.tz,
        now,
        days: req.query.days === undefined ? BOARD_DEFAULT_DAYS : Number(req.query.days),
        serviceKey: req.query.service,
        vip,
      })
      if (!board) throw new AppError('VALIDATION_FAILED', { detail: 'Pick a wash from the catalog.', errors: [{ path: 'query.service', message: 'Pick a wash from the catalog.' }] })
      return { ...board, vip }
    },
  )

  app.post(
    P('/verify/code'),
    {
      ...guard,
      config: cfg('Texts a one-time code to the number the personal link was sent to (never to a number in the request)', 10),
      schema: {
        tags: TAGS,
        operationId: 'requestClientLinkCode',
        summary: 'Text a code to the link’s own number',
        description:
          `${bearerNote} The six-digit code (10 minutes, 3 tries) goes to the number the link was texted to and nowhere else: the body takes no number, and a \`phone\` sent with it is ignored. ` +
          '`verify` is refused once the client has a PIN (409 `IDENTITY_PIN_REQUIRED`: a PIN outranks a code; on a stranger’s link, the PIN of the client who owns the number now); `pin_set` needs no PIN yet (409 `IDENTITY_PIN_EXISTS`), `pin_reset` a PIN (409 `IDENTITY_PIN_NOT_SET`); a PIN purpose on a stranger’s link 409 `IDENTITY_UNKNOWN_CLIENT`. ' +
          'Limits: 10 per address, 3 per page and 5 per number every 10 minutes (429 `PUBLIC_RATE_LIMITED`), and the website’s shared `PUBLIC_OTP_TEXTS_PER_HOUR` ceiling (429 `PUBLIC_CODES_PAUSED`).',
        body: CodeBody,
        response: { 202: CodeRequested },
      },
    },
    async (req, reply) => {
      const s = await session(app.db, req, { touch: false })
      const out = await requestStepUpCode(id(), { session: bearerOf(req), purpose: PURPOSE[req.body.purpose], ip: req.ip, requestId: req.id })
      reply.status(202)
      return { challengeId: out.challengeId, expiresInSec: out.expiresInSec, purpose: PURPOSE_OUT[out.purpose], to: s.phone.slice(-2) }
    },
  )

  app.post(
    P('/verify/code/confirm'),
    {
      ...guard,
      config: cfg('Checks the code this personal link page asked for', 20),
      schema: {
        tags: TAGS,
        operationId: 'confirmClientLinkCode',
        summary: 'Confirm the texted code',
        description:
          `${bearerNote} A \`verify\` or \`pin_set\` code verifies the page by code and trusts the number 30 days (a client’s link), and opens 10 minutes to choose a PIN; a \`pin_reset\` code only opens the 10 minutes to choose a new PIN (\`verified\` false). A verify link is used up by the step that verified it. ` +
          '401 `PUBLIC_OTP_INVALID` (`meta.attemptsLeft`), 429 `PUBLIC_OTP_LOCKED` after the code’s third wrong try, 429 `IDENTITY_SESSION_LOCKED` after the page’s fifth wrong PIN or code, 410 `PUBLIC_OTP_EXPIRED` for an expired, used or another page’s code, 409 `IDENTITY_PIN_REQUIRED` when a PIN was set meanwhile. 30 per address every 10 minutes.',
        body: CodeConfirmBody,
        response: { 200: StepResult },
      },
    },
    async (req) => {
      await limit([{ key: `link_code_confirm:ip:${ipLimitKey(req.ip)}`, rule: LINK_LIMITS.codeConfirm.ip }])
      const out = await confirmStepUpCode(id(), { session: bearerOf(req), challengeId: req.body.challengeId, code: req.body.code, ip: req.ip, requestId: req.id })
      if (out.verified) await complete(out.session, ['verify'])
      return { verified: out.verified, ...(await stateOf(await session(app.db, req, { touch: false }))) }
    },
  )

  app.post(
    P('/verify/pin'),
    {
      ...guard,
      config: cfg('Checks the client’s website PIN on their personal link page', 20),
      schema: {
        tags: TAGS,
        operationId: 'verifyClientLinkPin',
        summary: 'Enter the PIN',
        description:
          `${bearerNote} A right PIN verifies the page by PIN (a fresh step-up for memberships and payments) and trusts the number 30 days. A wrong PIN and a PIN where none exists answer alike: 401 \`IDENTITY_PIN_INVALID\` (\`meta.attemptsLeft\` of the page), after the same work. ` +
          '429 `IDENTITY_SESSION_LOCKED` (the page’s fifth wrong entry), 429 `IDENTITY_PIN_LOCKED` with Retry-After (5 wrong: 15 minutes, 3 more: 1 hour; 10 wrong in 24 hours), 423 `IDENTITY_PIN_DISABLED` (3 more: until a reset; staff are told), 429 `IDENTITY_TOO_MANY_TRIES` (20 wrong an hour from one address). 30 per address every 10 minutes.',
        body: PinBody,
        response: { 200: StepResult },
      },
    },
    async (req) => {
      await limit([{ key: `link_pin:ip:${ipLimitKey(req.ip)}`, rule: LINK_LIMITS.pin.ip }])
      const s = await verifySessionPin(id(), { session: bearerOf(req), pin: req.body.pin, ip: req.ip, requestId: req.id })
      await complete(s, ['verify'])
      return { verified: true, ...(await stateOf(await session(app.db, req, { touch: false }))) }
    },
  )

  app.post(
    P('/pin'),
    {
      ...guard,
      config: cfg('Creates the client’s website PIN after a code confirmed on the same personal link page', 10),
      schema: {
        tags: TAGS,
        operationId: 'setClientLinkPin',
        summary: 'Choose a first PIN (after a code confirmed here within 10 minutes)',
        description:
          `${bearerNote} 4 to 6 digits; refused (422 \`IDENTITY_PIN_REJECTED\` with the reason): one digit repeated, a run like 1234, a common PIN, a year 1940-2015, the end of the client’s own number. 403 \`IDENTITY_CODE_REQUIRED\` without a code confirmed on this page in the last 10 minutes, 409 \`IDENTITY_PIN_EXISTS\` when a PIN is set, 409 \`IDENTITY_UNKNOWN_CLIENT\` on a stranger’s link. Every other link and page of the client stops working (this one is kept). A PIN link is used up by it.`,
        body: PinBody,
        response: { 200: StepResult },
      },
    },
    async (req) => {
      const s0 = await session(app.db, req, { touch: false })
      await limit([
        { key: `link_pin:ip:${ipLimitKey(req.ip)}`, rule: LINK_LIMITS.pin.ip },
        { key: `link_pin_set:session:${s0.tokenHash}`, rule: LINK_LIMITS.pin.session },
      ])
      const s = await setSessionPin(id(), { session: bearerOf(req), pin: req.body.pin, ip: req.ip, requestId: req.id })
      await complete(s, ['pin', 'verify'])
      return { verified: true, ...(await stateOf(await session(app.db, req, { touch: false }))) }
    },
  )

  app.post(
    P('/pin/reset'),
    {
      ...guard,
      config: cfg('Replaces a forgotten website PIN after a reset code confirmed on the same personal link page', 10),
      schema: {
        tags: TAGS,
        operationId: 'resetClientLinkPin',
        summary: 'Choose a new PIN (after a pin_reset code confirmed here within 10 minutes)',
        description:
          `${bearerNote} The same PIN rules as above. 403 \`IDENTITY_CODE_REQUIRED\` without a \`pin_reset\` code confirmed on this page in the last 10 minutes, 409 \`IDENTITY_PIN_NOT_SET\` without a PIN. Every other link, page and the number’s trust end; this page is verified by the code and the number trusted again; memberships and payments through links wait 72 hours (403 \`LINK_PRIVILEGES_HELD\`), the client is emailed (when an address is on file) and the managers notified.`,
        body: PinBody,
        response: { 200: StepResult },
      },
    },
    async (req) => {
      const s0 = await session(app.db, req, { touch: false })
      await limit([
        { key: `link_pin:ip:${ipLimitKey(req.ip)}`, rule: LINK_LIMITS.pin.ip },
        { key: `link_pin_set:session:${s0.tokenHash}`, rule: LINK_LIMITS.pin.session },
      ])
      const s = await resetSessionPin(id(), { session: bearerOf(req), pin: req.body.pin, ip: req.ip, requestId: req.id })
      await complete(s, ['pin', 'verify'])
      return { verified: true, ...(await stateOf(await session(app.db, req, { touch: false }))) }
    },
  )

  app.post(
    P('/bookings'),
    {
      ...guard,
      config: cfg('A verified personal link page books a real visit for its client; Idempotency-Key required', 10, { idempotency: 'required' }),
      schema: {
        tags: TAGS,
        operationId: 'createClientLinkBooking',
        summary: 'Book a visit from a calendar or book-again link (verified page)',
        description:
          `${bearerNote} Idempotency-Key required. 403 \`IDENTITY_STEP_UP_REQUIRED\` until the page is verified (a PIN or code here, or the number’s live 30-day trust); 401 \`LINK_WRONG_PURPOSE\` on another kind of link; 409 \`IDENTITY_LINK_USED\` once the link’s bookings are spent (calendar 3, book-again 1). ` +
          'Books through the dashboard’s createAppointment with channel `online` (lead time, windows, paused days, no overrides) and source `link`, on the board’s grid (422 otherwise), the categories of the package and add-ons, the invoice and the `booking_confirmed_web` text. The fee and the VIP rules follow the page’s own client (an active member: no fee; VIP client or VIP-plan member: the VIP rules), never during a PIN reset’s 72-hour hold. On a stranger’s link `name` is required and creates the client (source online, `smsConsent` their consent); when a client owns the number by then the booking is theirs, and if they have a PIN only their PIN verifies such a page (409 `IDENTITY_PIN_REQUIRED` for a page verified by code); on a client’s link `name` only fills a placeholder name and `email` only fills an empty one (never replaces the email on file, so a PIN reset’s notice still reaches the owner). ' +
          'Slot refusals in the website’s words (409 `PUBLIC_SLOT_TAKEN`, `PUBLIC_SLOT_VIP`, `PUBLIC_SLOT_PAST`, `PUBLIC_SLOT_CLOSED`, `PUBLIC_SLOT_TOO_FAR`). Limits: 10 an hour per address, 5 per link and 5 per number.',
        body: BookingBody,
        response: { 201: BookingResult },
      },
    },
    idempotentHandler(
      async (req, tx) => {
        const s = await session(tx, req, { forUpdate: true })
        return { status: 201, body: await bookOnLink(tx, deps, s, reqOf(req), req.body as z.infer<typeof BookingBody>) }
      },
      {
        // the key belongs to the LINK (resolved from the page's session before the key is claimed), not to the address or the page:
        // the body names no client, so two links behind one address never get each other's stored booking, and a retry from a
        // re-opened page of the same link (a new session) replays its stored booking instead of booking twice (W4c fixes)
        actor: async (req) => `link:${(await session(app.db, req, { touch: false })).link.id}`,
        // on the pool, before the transaction opens: the session (401 first) and the durable limits (a refused booking still counts)
        prepare: async (req) => {
          const s = await session(app.db, req, { touch: false })
          await limit([
            { key: `link_booking:ip:${ipLimitKey(req.ip)}`, rule: LINK_LIMITS.booking.ip },
            { key: `link_booking:link:${s.link.id}`, rule: LINK_LIMITS.booking.link },
            { key: `link_booking:phone:${s.phone}`, rule: LINK_LIMITS.booking.phone },
          ])
          return undefined
        },
      },
    ) as never,
  )

  app.post(
    P('/appointments/:ref/reschedule'),
    {
      ...guard,
      config: cfg('A verified calendar link page moves one of its client’s own upcoming visits', 10),
      schema: {
        tags: TAGS,
        operationId: 'rescheduleClientLinkAppointment',
        summary: 'Move one of the client’s own upcoming visits (verified calendar page)',
        description:
          `${bearerNote} \`ref\` is a booking reference from \`me.appointments\` (\`OAS-00042\`): only the page’s own client’s visits (a calendar link sent for one visit: only that one), 404 \`LINK_APPOINTMENT_NOT_FOUND\` otherwise. A visit that started, ended or was canceled: 409 \`LINK_CANT_RESCHEDULE\`. ` +
          'The online rules apply (as for a booking, the page’s VIP privileges included) and the start is on the board’s grid; the client is texted the new time as for a desk reschedule. 403 `IDENTITY_STEP_UP_REQUIRED` until verified; 401 `LINK_WRONG_PURPOSE` on another kind of link. Limits: 10 an hour per address, 5 per number.',
        params: RefParams,
        body: RescheduleBody,
        response: { 200: RescheduleResult },
      },
    },
    async (req) => {
      const s0 = await session(app.db, req, { touch: false })
      await limit([
        { key: `link_reschedule:ip:${ipLimitKey(req.ip)}`, rule: LINK_LIMITS.reschedule.ip },
        { key: `link_reschedule:phone:${s0.phone}`, rule: LINK_LIMITS.reschedule.phone },
      ])
      return transaction(app.db, async (tx) => rescheduleOnLink(tx, deps, await session(tx, req, { forUpdate: true }), reqOf(req), req.params.ref, req.body))
    },
  )

  app.post(
    P('/membership/start'),
    {
      ...guard,
      config: cfg('A membership link page with a fresh PIN or code starts the plan’s Squarespace checkout for its client', 10),
      schema: {
        tags: TAGS,
        operationId: 'startClientLinkMembership',
        summary: 'Start the plan’s Squarespace checkout (membership link, fresh PIN or code)',
        description:
          `${bearerNote} Needs a PIN or code entered on this page in the last 5 minutes (403 \`IDENTITY_STEP_UP_REQUIRED\`, \`meta.need\` \`fresh\`); 403 \`LINK_PRIVILEGES_HELD\` within 72 hours of a PIN reset; 401 \`LINK_WRONG_PURPOSE\` on another kind of link. ` +
          'A pending membership of the link’s plan (reused when one is pending) and a checkout intent: the typed `email` (the one they will pay with), the plan’s Squarespace product, 72 hours. The email is never stored as the client’s verified email (an unverified email never links an order by itself). `vehicles` are added to the client. 409 `LINK_ALREADY_MEMBER` for a live membership (held, or shared as a household member), 409 `LINK_CHECKOUT_UNAVAILABLE` when the plan has no checkout link. `redirectUrl` is the plan’s checkout (https, squarespace.com only). One completion of the link (3). Limits: 10 an hour per address, 5 a day per number.',
        body: MembershipStartBody,
        response: { 200: MembershipStartResult },
      },
    },
    async (req) => {
      const s0 = await session(app.db, req, { touch: false })
      await limit([
        { key: `link_membership:ip:${ipLimitKey(req.ip)}`, rule: LINK_LIMITS.membership.ip },
        { key: `link_membership:phone:${s0.phone}`, rule: LINK_LIMITS.membership.phone },
      ])
      const out = await transaction(app.db, async (tx) => startMembership(tx, deps, await session(tx, req, { forUpdate: true }), reqOf(req), req.body))
      return { ...out, checkoutExpiresAt: out.checkoutExpiresAt.toISOString() }
    },
  )

  app.post(
    P('/pay/start'),
    {
      ...guard,
      config: cfg('A payment link page with a fresh PIN or code goes to the invoice’s payment URL, or asks the shop for one', 10),
      schema: {
        tags: TAGS,
        operationId: 'startClientLinkPayment',
        summary: 'Pay the invoice (payment link, fresh PIN or code)',
        description:
          `${bearerNote} Needs a PIN or code entered on this page in the last 5 minutes (403 \`IDENTITY_STEP_UP_REQUIRED\`); 403 \`LINK_PRIVILEGES_HELD\` within 72 hours of a PIN reset; 401 \`LINK_WRONG_PURPOSE\` on another kind of link; a paid or voided invoice has ended the page already (401 \`IDENTITY_SESSION_INVALID\`). ` +
          '`{status: "redirect", redirectUrl}`: the payment URL staff attached to the invoice, only https on a `PAYMENT_LINK_HOSTS` host (default squarespace.com and its subdomains, exactly square.link and checkout.square.site; never a sandbox host in production); one completion of the link (3). 409 `CARD_CHARGE_IN_PROGRESS` while a saved-card charge of the invoice waits for Square. `{status: "link_pending", redirectUrl: null}`: the invoice has no allowed URL; the managers get one `payments.link_requested` notice (until they read it) to text the client a payment link. ' +
          'With PAYMENT_PROCESSOR=square (ADR 0171 D3): a Square link for exactly the current balance (its lines, tax and tip, or one "Balance due" line), reused while it is active for that amount, else made now (409 `CONCURRENT_UPDATE` if the balance changed during the call, 422 `PAY_NOTHING_TO_COLLECT` when nothing is owed); `link_pending` only when Square does not answer or is watch-only. Limits: 20 an hour per address, 10 per number.',
        body: PayStartBody,
        response: { 200: PayStartResult },
      },
    },
    async (req) => {
      const s0 = await session(app.db, req, { touch: false })
      await limit([
        { key: `link_pay:ip:${ipLimitKey(req.ip)}`, rule: LINK_LIMITS.pay.ip },
        { key: `link_pay:phone:${s0.phone}`, rule: LINK_LIMITS.pay.phone },
      ])
      // with Square (ADR 0171 D3): a Square link for the exact balance, made or reused now, in two transactions around the call
      if (squareProcessor(squareEnv()))
        return startSquarePayment(deps, (db, o) => session(db, req, o), reqOf(req), req.log)
      return transaction(app.db, async (tx) => startPayment(tx, deps, await session(tx, req, { forUpdate: true }), reqOf(req)))
    },
  )

  app.post(
    P('/deposit/start'),
    {
      ...guard,
      config: cfg('A verified calendar page pays the deposit of one of its client’s visits through a Square link', 10),
      schema: {
        tags: TAGS,
        operationId: 'startClientLinkDeposit',
        summary: 'Pay the booking deposit now (verified calendar page, Square)',
        description:
          `${bearerNote} The booking fee is a deposit toward the visit (ADR 0150, ADR 0171 D2). For one of the page's client's upcoming visits (\`bookingRef\` OAS-n, booked or confirmed) whose booking asked for a deposit link (booking.guest_fee.collect \`link\` with PAYMENT_PROCESSOR=square): ` +
          '`{status: "redirect", redirectUrl}` a Square quick-pay link for exactly the deposit (an active one is reused); `paid` the deposit is already paid; `none` no deposit link is owed for that visit; `link_pending` Square did not answer (the shop texts the link). Needs a verified page (401 `LINK_WRONG_PURPOSE` on another kind of link, 403 `IDENTITY_STEP_UP_REQUIRED`); 404 for a booking that is not the page client’s. Uses no completion of the link. Limits as pay/start.',
        body: DepositStartBody,
        response: { 200: DepositStartResult },
      },
    },
    async (req) => {
      const s0 = await session(app.db, req, { touch: false })
      await limit([
        { key: `link_pay:ip:${ipLimitKey(req.ip)}`, rule: LINK_LIMITS.pay.ip },
        { key: `link_pay:phone:${s0.phone}`, rule: LINK_LIMITS.pay.phone },
      ])
      if (!squareProcessor(squareEnv())) return { status: 'none' as const, redirectUrl: null, amountCents: 0 }
      return startSquareDeposit(deps, (db, o) => session(db, req, o), reqOf(req), req.body.bookingRef, req.log)
    },
  )

  // Square on the link pages (ADR 0171 D7, D8): cards on file (wave Q3a) and memberships billed by Square (wave Q3b)
  const kit: LinkRouteKit = { app, deps, guard, cfg, session, limit, path: P, reqOf, tags: TAGS, bearerNote }
  registerCardLinkRoutes(kit)
  registerSubscribeLinkRoutes(kit)
}
