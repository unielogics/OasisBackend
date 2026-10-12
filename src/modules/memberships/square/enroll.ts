// Joining on a membership page (#/m) with Square (ADR 0171 D8, wave Q3b, design 5.3): the client picks a size, gives the email Square
// bills to, enters a card in Square's form and ticks the consent; Oasis saves the card and creates the Square subscription. The
// membership is active only once Square's first invoice is paid (billing.ts); the page polls GET /membership/status.
//
//   POST /public/links/membership/subscribe
//     checks first (nothing written): Square is the processor and writes are on, the email looks deliverable (Square deactivates a
//     subscription whose email bounces), the consent wording is the current one;
//     transaction 1: the membership page's guards (requireKind membership, requireFresh, the client proven, no PIN-reset hold), the
//     tier and size priced AND synced to Square, the client holds no live membership and shares none (household rule), one
//     completion of the link, the vehicles, a pending membership (source square; a pending one is reused) and an enrollment
//     (started). An attempt already past its card (card_saved, subscribed) is answered as it stands, nothing sent twice;
//     then, on the pool: ensureSquareCustomer with the email (customer_ready), saveCardOnFile with the consent membership_billing
//     and key cd_<enrollment> (card_saved), CreateSubscription with key sb_<enrollment>, today in the shop's time zone;
//     transaction 2: the ids (subscribed).
//   square.enrollments.resume (every 5 minutes, runEnrollmentJobs): an attempt younger than an hour is taken on with the same keys
//     (CreateSubscription after a lost answer; the first invoice read back when its event is late); an older one is abandoned. A
//     failed or abandoned attempt that left something at Square is cleaned up there (the subscription canceled, its open invoice
//     canceled, the card disabled), its membership canceled, and after a first payment that failed the client is texted a new
//     membership page. A pending membership whose last attempt failed an hour ago is closed. A member who saved a newer card for
//     their membership (the card page) has it put on the subscription (Square then retries a failed invoice with it).
import { sql } from 'kysely'
import type { SquareApi } from '../../../integrations/ports/square.js'
import { squareLocationId } from '../../../integrations/square/config.js'
import { SquareApiError, SquareNetworkError } from '../../../integrations/square/errors.js'
import { sqKey } from '../../../integrations/square/keys.js'
import type { WireEvent, WireSubscription } from '../../../integrations/square/wire.js'
import * as audit from '../../../platform/audit.js'
import { transaction, type Db, type Executor, type Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { upsertVehicleByPlate } from '../../customers/service.js'
import { consumeLink } from '../../identity/links.js'
import type { SessionView } from '../../identity/sessions.js'
import { notifyManagers } from '../../messaging/notify.js'
import { parseVehicleLabel } from '../../public/bookings.js'
import {
  linkAudit,
  linkLocation,
  requireFresh,
  requireKind,
  requireNoHold,
  requireProven,
  type LinkDeps,
  type LinkRequest,
} from '../../public/links/service.js'
import { memberRefOf } from '../../public/memberships.js'
import { disableCard, saveCardOnFile } from '../../square/cards.js'
import { consentText } from '../../square/consents.js'
import { ensureSquareCustomer } from '../../square/customers.js'
import type { SquareLogger } from '../../square/ingest.js'
import { squareProblem, squareProcessor, squareWritesOn } from '../../square/links.js'
import { squareApi, squareEnv } from '../../square/runtime.js'
import { sharedMembershipId } from '../household.js'
import { resolvePlanClass } from '../plan-class.js'
import { loadPlans, planByKey } from '../plans.js'
import { locationTz } from '../view.js'
import { ingestSquareSubscription, ingestSubscriptionInvoice, linkSubscription } from './billing.js'
import { sendJoinRetry } from './notify.js'
import { deliverableEmail, shopDate } from './policy.js'
import { LIVE_ENROLLMENT_STATES, type EnrollmentFailure } from './schema.js'
import type { SquareSteps } from './steps.js'
import '../../square/problems.js'
import '../../public/links/problems.js'
// LINK_ACTION_NOT_READY is registered with the declared card routes (the Q3 shared foundation)
import '../../public/links/http/card-routes.js'

const MIN = 60_000
/** An attempt is taken on by the job for this long; after it, it is abandoned. */
export const ENROLLMENT_RESUME_MS = 60 * MIN

export interface SubscribeInput {
  email: string
  planClass?: string
  vehicles?: { car: string; plate?: string }[]
  sourceId: string
  verificationToken?: string
  consentVersion: string
  cardholderName?: string
  postalCode?: string
}

export interface EnrollmentStatusView {
  status: 'none' | 'pending' | 'active' | 'failed'
  membershipRef: string | null
}

type SessionOf = (db: Executor, o: { forUpdate?: boolean }) => Promise<SessionView>

const bad = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path: `body.${path}`, message }] })

/** The request body of CreateSubscription (also used by pnpm verify:square against the sandbox). */
export function subscriptionInput(o: { squareLocationId: string; variationId: string; squareCustomerId: string; squareCardId: string | null; startDate: string; tz: string }) {
  return {
    location_id: o.squareLocationId,
    plan_variation_id: o.variationId,
    customer_id: o.squareCustomerId,
    // without a card Square emails each invoice instead of charging it (the sandbox verification uses one to test CancelInvoice)
    ...(o.squareCardId ? { card_id: o.squareCardId } : {}),
    start_date: o.startDate,
    timezone: o.tz,
  }
}

/** CreateSubscription with the enrollment's own key sb_<enrollment>: a repeat answers the same subscription. */
export function createMembershipSubscription(api: SquareApi, enrollmentId: string, input: ReturnType<typeof subscriptionInput>): Promise<WireSubscription> {
  return api.subscriptions.create(sqKey('sb', enrollmentId), input)
}

const statusOfState = (state: string): EnrollmentStatusView['status'] =>
  state === 'active' ? 'active' : state === 'failed' || state === 'abandoned' ? 'failed' : 'pending'

// ---- the page ----------------------------------------------------------------------------------------------------------------

/** GET membership/status: where this page's own enrollment stands (none before the client submits). */
export async function enrollmentStatus(db: Executor, s: SessionView): Promise<EnrollmentStatusView> {
  requireKind(s, ['membership'])
  if (!s.customerId) throw new AppError('LINK_WRONG_PURPOSE')
  const e = await db
    .selectFrom('square_enrollments')
    .select(['state', 'membership_id'])
    .where('customer_id', '=', s.customerId)
    .where('link_id', '=', s.link.id)
    .orderBy('started_at', 'desc')
    .executeTakeFirst()
  return e ? { status: statusOfState(e.state), membershipRef: memberRefOf(e.membership_id) } : { status: 'none', membershipRef: null }
}

type Started =
  | { kind: 'standing'; view: EnrollmentStatusView }
  | {
      kind: 'new'
      locationId: string
      enrollmentId: string
      membershipId: string
      customerId: string
      email: string
      linkId: string
      sessionHash: string
      startDate: string
      tz: string
      variationId: string
    }

/** Transaction 1 (see the header). */
async function startEnrollment(tx: Tx, d: LinkDeps, s: SessionView, r: LinkRequest, input: SubscribeInput, email: string): Promise<Started> {
  requireKind(s, ['membership'])
  const now = d.app.clock.now()
  requireFresh(s, now)
  if (!s.customerId || !s.link.planKey) throw new AppError('LINK_WRONG_PURPOSE')
  await requireProven(tx, s, now)
  const loc = await linkLocation(tx, s.link.locationId)
  await requireNoHold(tx, s.customerId, now, loc.tz)
  const plan = planByKey(await loadPlans(tx, loc.id), s.link.planKey)
  if (!plan || !plan.active) throw new AppError('LINK_CHECKOUT_UNAVAILABLE')
  let size
  try {
    size = await resolvePlanClass(tx, loc.id, plan.id, { requested: input.planClass, requirePrice: true, path: 'planClass' })
  } catch (e) {
    if (e instanceof AppError && e.code === 'VALIDATION_FAILED') throw bad('planClass', 'Pick one of the vehicle sizes.')
    throw e
  }
  const price = await tx
    .selectFrom('membership_tier_prices')
    .select(['id', 'monthly_cents', 'square_variation_id', 'square_state'])
    .where('id', '=', size.tierPriceId!)
    .executeTakeFirstOrThrow()
  // a size whose price is not at Square yet cannot be joined online (the sync makes it within minutes of a save)
  if (price.square_state !== 'synced' || !price.square_variation_id) throw new AppError('LINK_CHECKOUT_UNAVAILABLE')
  const customerId = s.customerId
  await tx.selectFrom('customers').select('id').where('id', '=', customerId).forUpdate().executeTakeFirstOrThrow()
  const live = await tx
    .selectFrom('memberships')
    .selectAll()
    .where('customer_id', '=', customerId)
    .where('status', 'in', ['pending', 'active', 'past_due', 'paused'])
    .forUpdate()
    .execute()
  // the household rule: a client who holds a live membership or shares one as a household member joins nothing else
  if (live.some((m) => m.status !== 'pending') || (await sharedMembershipId(tx, customerId))) throw new AppError('LINK_ALREADY_MEMBER')
  const pending = live.find((m) => m.status === 'pending')
  if (pending) {
    const enr = await tx
      .selectFrom('square_enrollments')
      .selectAll()
      .where('membership_id', '=', pending.id)
      .where('state', 'in', [...LIVE_ENROLLMENT_STATES])
      .forUpdate()
      .executeTakeFirst()
    // past its card: the attempt stands (the job finishes it); its page polls the status
    if (enr && (enr.state === 'card_saved' || enr.state === 'subscribed'))
      return { kind: 'standing', view: { status: 'pending', membershipRef: memberRefOf(pending.id) } }
    // an attempt that died before its card was saved cannot be resumed (the card's token is never kept): this one replaces it
    if (enr)
      await tx
        .updateTable('square_enrollments')
        .set({ state: 'abandoned', failure_code: 'superseded', failure_detail: 'Replaced by a new attempt', finished_at: now, updated_at: now })
        .where('id', '=', enr.id)
        .execute()
  }
  await consumeLink(tx, s.link.id, now)
  for (const v of input.vehicles ?? []) {
    const parsed = parseVehicleLabel(v.car)
    if (!parsed.make && !v.plate) continue
    await upsertVehicleByPlate(tx, { newId: d.app.newId, customerId, year: parsed.year, make: parsed.make, model: parsed.model, plate: v.plate ?? null })
  }
  const membershipId = pending?.id ?? d.app.newId()
  const fields = {
    plan_id: plan.id,
    plan_label: plan.name,
    plan_class: size.classKey,
    tier_price_id: price.id,
    source: 'square' as const,
    manual_status_at: null,
    in_grace: false,
    inference_reason: 'Joining online with a card, billed by Square',
    updated_at: now,
  }
  if (pending) await tx.updateTable('memberships').set((eb) => ({ ...fields, version: eb('version', '+', 1) })).where('id', '=', pending.id).execute()
  else
    await tx
      .insertInto('memberships')
      .values({
        id: membershipId,
        location_id: loc.id,
        customer_id: customerId,
        status: 'pending',
        sqsp_subscription_ref: null,
        sqsp_customer_id: null,
        sqsp_product_key: null,
        started_at: now,
        current_period_start: null,
        current_period_end: null,
        canceled_at: null,
        cancel_reason: null,
        last_sqsp_order_id: null,
        last_paid_at: null,
        review_flags: JSON.stringify([]),
        last_synced_at: null,
        created_at: now,
        ...fields,
      })
      .execute()
  const enrollmentId = d.app.newId()
  const startDate = shopDate(now, loc.tz)
  await tx
    .insertInto('square_enrollments')
    .values({
      id: enrollmentId,
      location_id: loc.id,
      customer_id: customerId,
      membership_id: membershipId,
      link_id: s.link.id,
      plan_id: plan.id,
      tier_price_id: price.id,
      plan_class: size.classKey,
      square_variation_id: price.square_variation_id,
      monthly_cents: price.monthly_cents,
      email,
      state: 'started',
      start_date: startDate,
      started_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute()
  await audit.record(tx, {
    locationId: loc.id,
    action: 'membership.square.enroll_started',
    entityType: 'membership',
    entityId: membershipId,
    after: { customerId, plan: plan.key, planClass: size.classKey, monthlyCents: price.monthly_cents, enrollment: enrollmentId },
    ctx: linkAudit(r),
  })
  return {
    kind: 'new',
    locationId: loc.id,
    enrollmentId,
    membershipId,
    customerId,
    email,
    linkId: s.link.id,
    sessionHash: s.tokenHash,
    startDate,
    tz: loc.tz,
    variationId: price.square_variation_id,
  }
}

async function setEnrollment(db: Db, now: Date, id: string, set: Record<string, unknown>): Promise<void> {
  await transaction(db, async (tx) => {
    await tx
      .updateTable('square_enrollments')
      .set({ ...(set as object), updated_at: now })
      .where('id', '=', id)
      .execute()
  })
}

async function failEnrollment(db: Db, now: Date, id: string, code: EnrollmentFailure, detail: string, cleanup: 'none' | 'pending' = 'none'): Promise<void> {
  await transaction(db, async (tx) => {
    const e = await tx.selectFrom('square_enrollments').select('state').where('id', '=', id).forUpdate().executeTakeFirstOrThrow()
    if (!(LIVE_ENROLLMENT_STATES as readonly string[]).includes(e.state)) return
    await tx
      .updateTable('square_enrollments')
      .set({ state: 'failed', failure_code: code, failure_detail: detail.slice(0, 300), cleanup, finished_at: now, updated_at: now })
      .where('id', '=', id)
      .execute()
  })
}

/** The subscription step (the command and the resume job): CreateSubscription with sb_<enrollment>, then the ids recorded. */
async function subscribeStep(
  x: SquareSteps,
  e: { id: string; squareCustomerId: string; squareCardId: string; variationId: string; startDate: string; tz: string },
): Promise<'subscribed' | 'retry' | 'refused'> {
  const now = x.clock.now()
  const location = squareLocationId(x.env)
  if (!location) return 'retry'
  await setEnrollment(x.db, now, e.id, { last_attempt_at: now })
  try {
    const sub = await createMembershipSubscription(
      x.api,
      e.id,
      subscriptionInput({ squareLocationId: location, variationId: e.variationId, squareCustomerId: e.squareCustomerId, squareCardId: e.squareCardId, startDate: e.startDate, tz: e.tz }),
    )
    await transaction(x.db, async (tx) => {
      await tx.updateTable('square_enrollments').set((eb) => ({ attempts: eb('attempts', '+', 1) })).where('id', '=', e.id).execute()
      await linkSubscription(tx, x, e.id, { id: sub.id, status: sub.status })
    })
    return 'subscribed'
  } catch (err) {
    await transaction(x.db, (tx) => tx.updateTable('square_enrollments').set((eb) => ({ attempts: eb('attempts', '+', 1) })).where('id', '=', e.id).execute())
    // no answer, a rate limit, Square down: the same key again later (the job)
    if (err instanceof SquareNetworkError || (err instanceof SquareApiError && err.retryable)) return 'retry'
    if (!(err instanceof SquareApiError)) return 'retry'
    x.logger?.warn({ enrollment: e.id, err: err.message }, 'square: CreateSubscription refused')
    await failEnrollment(x.db, x.clock.now(), e.id, 'subscription_refused', 'Square refused the subscription', 'pending')
    return 'refused'
  }
}

/**
 * POST membership/subscribe (see the header). Answers {status: pending} once the subscription exists or the attempt stands (the page
 * polls), 422 CARD_DECLINED with the reason the client may read, 409 LINK_ALREADY_MEMBER, 409 LINK_CHECKOUT_UNAVAILABLE (the size is
 * not sold online yet, Square watch-only), 503 SQUARE_UNAVAILABLE (Square did not answer: try again).
 */
export async function subscribeOnLink(d: LinkDeps, sessionOf: SessionOf, r: LinkRequest & { userAgent?: string | null }, input: SubscribeInput, log?: SquareLogger): Promise<EnrollmentStatusView> {
  const env = squareEnv()
  // the Squarespace checkout (membership/start) is the membership page's action until the cutover
  if (!squareProcessor(env)) throw new AppError('LINK_ACTION_NOT_READY')
  if (!squareWritesOn(env)) throw new AppError('LINK_CHECKOUT_UNAVAILABLE')
  const email = deliverableEmail(input.email)
  if (!email.ok) throw bad('email', email.message)
  // the wording the page showed must be the current one, before anything is written or sent
  consentText(input.consentVersion, ['membership_billing'])
  const db = d.app.db
  const first = await transaction(db, async (tx) => startEnrollment(tx, d, await sessionOf(tx, { forUpdate: true }), r, input, email.email))
  if (first.kind === 'standing') return first.view
  const x: SquareSteps = { db, clock: d.app.clock, newId: d.app.newId, env, api: squareApi(env), locationId: first.locationId, ...(log ? { logger: log } : {}) }
  const ref = memberRefOf(first.membershipId)
  // the client's Square customer, with the email Square bills to
  let squareCustomerId: string
  try {
    squareCustomerId = (await ensureSquareCustomer(x, { customerId: first.customerId, email: first.email })).squareCustomerId
  } catch (e) {
    await failEnrollment(db, x.clock.now(), first.enrollmentId, 'square_unavailable', 'Square did not set up the customer')
    throw e instanceof AppError ? e : squareProblem(e)
  }
  await setEnrollment(db, x.clock.now(), first.enrollmentId, { state: 'customer_ready', square_customer_id: squareCustomerId })
  // the card, with the client's consent to the monthly payment (cd_<enrollment>)
  let card
  try {
    card = await saveCardOnFile(
      { ...x },
      {
        customerId: first.customerId,
        sourceId: input.sourceId,
        verificationToken: input.verificationToken ?? null,
        postalCode: input.postalCode ?? null,
        cardholderName: input.cardholderName ?? null,
        purposes: ['membership_billing'],
        consentVersion: input.consentVersion,
        ip: r.ip,
        userAgent: r.userAgent ?? null,
        linkId: first.linkId,
        sessionHash: first.sessionHash,
        keyBase: first.enrollmentId,
        createdVia: 'membership_link',
        audit: linkAudit(r),
      },
    )
  } catch (e) {
    const code: EnrollmentFailure = e instanceof AppError && e.code === 'CARD_DECLINED' ? 'card_declined' : 'square_unavailable'
    await failEnrollment(db, x.clock.now(), first.enrollmentId, code, e instanceof AppError ? e.detail : 'Square did not save the card')
    throw e
  }
  await setEnrollment(db, x.clock.now(), first.enrollmentId, { state: 'card_saved', card_id: card.cardId, consent_id: card.consentId })
  const out = await subscribeStep(x, {
    id: first.enrollmentId,
    squareCustomerId,
    squareCardId: card.squareCardId,
    variationId: first.variationId,
    startDate: first.startDate,
    tz: first.tz,
  })
  if (out === 'refused') throw new AppError('LINK_CHECKOUT_UNAVAILABLE')
  // subscribed, or Square did not answer: the job takes it on with the same key; either way the page polls
  return { status: 'pending', membershipRef: ref }
}

// ---- the job --------------------------------------------------------------------------------------------------------------------

export interface EnrollmentJobReport {
  status: 'skipped' | 'done'
  reason?: string
  subscribed: number
  polled: number
  abandoned: number
  cleaned: number
  closed: number
  cardsMoved: number
}

const syntheticEvent = (type: string, kind: 'invoice' | 'subscription', id: string, now: Date): WireEvent =>
  ({ type, event_id: `resume:${kind}:${id}`, created_at: now.toISOString(), data: { type: kind, id } }) as WireEvent

/** Reads an attempt's subscription and its invoices back and runs them through the billing handlers (an event that is late). */
async function pollSubscription(x: SquareSteps, subscriptionId: string): Promise<void> {
  const sub = await x.api.subscriptions.retrieve(subscriptionId, { includeActions: true })
  const now = x.clock.now()
  const base = { clock: x.clock, logger: x.logger ?? silentLogger, env: x.env, locationId: x.locationId }
  await transaction(x.db, (tx) => ingestSquareSubscription({ ...base, tx, event: syntheticEvent('subscription.updated', 'subscription', sub.id, now) }, sub))
  for (const id of (sub.invoice_ids ?? []).slice(0, 3)) {
    const inv = await x.api.invoices.get(id)
    await transaction(x.db, (tx) =>
      ingestSubscriptionInvoice({ ...base, tx, event: syntheticEvent('invoice.updated', 'invoice', inv.id, now), related: { subscription: sub } }, inv),
    )
  }
}

const silentLogger: SquareLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

/** Cancels at Square what a failed or abandoned attempt left there, then closes its membership (and texts a new page after a failed first payment). */
async function cleanUp(x: SquareSteps, enrollmentId: string): Promise<boolean> {
  const e = await x.db.selectFrom('square_enrollments').selectAll().where('id', '=', enrollmentId).executeTakeFirstOrThrow()
  if (e.square_subscription_id) {
    await x.api.subscriptions.cancel(e.square_subscription_id)
    const open = await x.db
      .selectFrom('square_subscription_invoices')
      .select('square_invoice_id')
      .where('square_subscription_id', '=', e.square_subscription_id)
      .where('paid_at', 'is', null)
      .where('canceled_at', 'is', null)
      .execute()
    for (const o of open) {
      const inv = await x.api.invoices.get(o.square_invoice_id)
      if (['UNPAID', 'SCHEDULED', 'PARTIALLY_PAID'].includes(inv.status)) await x.api.invoices.cancel(inv.id, inv.version ?? 0)
    }
  }
  if (e.card_id) await disableCard({ ...x }, { cardId: e.card_id, by: 'system', reason: 'membership_failed' })
  const now = x.clock.now()
  return transaction(x.db, async (tx) => {
    const enr = await tx.selectFrom('square_enrollments').selectAll().where('id', '=', enrollmentId).forUpdate().executeTakeFirstOrThrow()
    if (enr.cleanup !== 'pending') return false
    await tx.updateTable('square_enrollments').set({ cleanup: 'done', updated_at: now }).where('id', '=', enr.id).execute()
    const m = await tx.selectFrom('memberships').selectAll().where('id', '=', enr.membership_id).forUpdate().executeTakeFirstOrThrow()
    if (m.status === 'pending') {
      const reason = enr.failure_code === 'first_payment_failed' ? 'first_payment_failed' : 'enrollment_failed'
      await tx
        .updateTable('memberships')
        .set((eb) => ({ status: 'canceled', canceled_at: now, cancel_reason: reason, square_status: e.square_subscription_id ? 'CANCELED' : m.square_status, updated_at: now, version: eb('version', '+', 1) }))
        .where('id', '=', m.id)
        .execute()
      await audit.record(tx, {
        locationId: x.locationId,
        action: 'membership.square.enroll_failed',
        entityType: 'membership',
        entityId: m.id,
        after: { enrollment: enr.id, reason: enr.failure_code, detail: enr.failure_detail },
        ctx: { actor: { name: 'Square' } },
      })
      if (enr.failure_code === 'first_payment_failed') {
        const plan = (await loadPlans(tx, x.locationId)).find((p) => p.id === enr.plan_id)
        if (plan) await sendJoinRetry(tx, x, { customerId: enr.customer_id, planKey: plan.key, tierName: plan.name, enrollmentId: enr.id })
        const cust = await tx.selectFrom('customers').select('full_name').where('id', '=', enr.customer_id).executeTakeFirst()
        await notifyManagers(
          tx,
          {
            locationId: x.locationId,
            kind: 'membership.first_payment_failed',
            title: `Membership did not start: ${cust?.full_name ?? 'a client'}`,
            body: `Square could not charge the first ${m.plan_label} payment of ${cust?.full_name ?? 'a client'}, so the membership did not start. We texted them a new link to try another card.`,
            entityType: 'membership',
            entityId: m.id,
          },
          { newId: x.newId, clock: x.clock },
        )
      }
    }
    return true
  })
}

/** Moves a Square membership's subscription to the newest card its client saved for membership billing (see the header). */
async function moveToNewerCards(x: SquareSteps): Promise<number> {
  const rows = await x.db
    .selectFrom('memberships as m')
    .innerJoin('customer_cards as c', 'c.customer_id', 'm.customer_id')
    .leftJoin('customer_cards as cur', 'cur.id', 'm.card_id')
    .select(['m.id', 'm.square_subscription_id', 'c.id as card_id', 'c.square_card_id', 'c.square_customer_id'])
    .where('m.location_id', '=', x.locationId)
    .where('m.source', '=', 'square')
    .where('m.status', 'in', ['active', 'past_due', 'paused'])
    .where('m.square_subscription_id', 'is not', null)
    .where('c.state', '=', 'active')
    .whereRef('c.square_customer_id', '=', 'm.square_customer_id')
    .where((eb) => eb.or([eb('m.card_id', 'is', null), eb('cur.state', '<>', 'active'), eb('c.created_at', '>', eb.ref('cur.created_at'))]))
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('card_consents as k')
          .select('k.id')
          .whereRef('k.card_id', '=', 'c.id')
          .where('k.revoked_at', 'is', null)
          .where(sql<boolean>`'membership_billing' = any(k.purposes)`),
      ),
    )
    .orderBy('c.created_at', 'desc')
    .execute()
  let moved = 0
  const seen = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    try {
      await x.api.subscriptions.update(r.square_subscription_id!, { card_id: r.square_card_id })
    } catch (e) {
      x.logger?.warn({ membership: r.id, err: e instanceof Error ? e.message : String(e) }, 'square: moving a membership to a newer card failed')
      continue
    }
    await transaction(x.db, async (tx) => {
      await tx.updateTable('memberships').set((eb) => ({ card_id: r.card_id, updated_at: x.clock.now(), version: eb('version', '+', 1) })).where('id', '=', r.id).execute()
      await audit.record(tx, {
        locationId: x.locationId,
        action: 'membership.square.card_changed',
        entityType: 'membership',
        entityId: r.id,
        after: { cardId: r.card_id },
        ctx: { actor: { name: 'Oasis' } },
      })
    })
    moved++
  }
  return moved
}

/** square.enrollments.resume for one location (see the header). Skipped while Square writes are off. */
export async function runEnrollmentJobs(x: SquareSteps): Promise<EnrollmentJobReport> {
  const report: EnrollmentJobReport = { status: 'done', subscribed: 0, polled: 0, abandoned: 0, cleaned: 0, closed: 0, cardsMoved: 0 }
  if (!squareWritesOn(x.env)) return { ...report, status: 'skipped', reason: 'Square writes are off (SQUARE_WRITES_ENABLED=false)' }
  const now = x.clock.now()
  const cutoff = new Date(now.getTime() - ENROLLMENT_RESUME_MS)
  const tz = await locationTz(x.db, x.locationId)
  const open = await x.db
    .selectFrom('square_enrollments as e')
    .innerJoin('customer_cards as c', 'c.id', 'e.card_id')
    .select(['e.id', 'e.state', 'e.started_at', 'e.square_customer_id', 'c.square_card_id', 'e.square_variation_id', 'e.start_date', 'e.square_subscription_id'])
    .where('e.location_id', '=', x.locationId)
    .where('e.state', 'in', ['card_saved', 'subscribed'])
    .where('e.started_at', '>', cutoff)
    .execute()
  for (const e of open) {
    try {
      if (e.state === 'card_saved') {
        const out = await subscribeStep(x, { id: e.id, squareCustomerId: e.square_customer_id!, squareCardId: e.square_card_id, variationId: e.square_variation_id, startDate: e.start_date, tz })
        if (out === 'subscribed') report.subscribed++
      } else if (e.square_subscription_id) {
        await pollSubscription(x, e.square_subscription_id)
        report.polled++
      }
    } catch (err) {
      x.logger?.warn({ enrollment: e.id, err: err instanceof Error ? err.message : String(err) }, 'square: resuming an enrollment failed')
    }
  }
  // older than an hour and not done: abandoned (what it left at Square is cleaned up below)
  const stale = await x.db
    .selectFrom('square_enrollments')
    .select(['id', 'card_id', 'square_subscription_id'])
    .where('location_id', '=', x.locationId)
    .where('state', 'in', [...LIVE_ENROLLMENT_STATES])
    .where('started_at', '<=', cutoff)
    .execute()
  for (const s of stale) {
    await transaction(x.db, async (tx) => {
      const e = await tx.selectFrom('square_enrollments').select('state').where('id', '=', s.id).forUpdate().executeTakeFirstOrThrow()
      if (!(LIVE_ENROLLMENT_STATES as readonly string[]).includes(e.state)) return
      await tx
        .updateTable('square_enrollments')
        .set({
          state: 'abandoned',
          failure_code: 'expired',
          failure_detail: 'Not finished within an hour',
          cleanup: s.card_id || s.square_subscription_id ? 'pending' : 'none',
          finished_at: now,
          updated_at: now,
        })
        .where('id', '=', s.id)
        .execute()
    })
    report.abandoned++
  }
  const dirty = await x.db.selectFrom('square_enrollments').select('id').where('location_id', '=', x.locationId).where('cleanup', '=', 'pending').execute()
  for (const c of dirty) {
    try {
      if (await cleanUp(x, c.id)) report.cleaned++
    } catch (err) {
      x.logger?.warn({ enrollment: c.id, err: err instanceof Error ? err.message : String(err) }, 'square: cleaning up an enrollment failed')
    }
  }
  report.closed = await closeStalePending(x, cutoff)
  report.cardsMoved = await moveToNewerCards(x)
  return report
}

/** A pending Square membership with no attempt in flight and none for an hour: canceled (the client can start again from a new link). */
async function closeStalePending(x: SquareSteps, cutoff: Date): Promise<number> {
  const rows = await x.db
    .selectFrom('memberships as m')
    .select('m.id')
    .where('m.location_id', '=', x.locationId)
    .where('m.source', '=', 'square')
    .where('m.status', '=', 'pending')
    .where('m.updated_at', '<=', cutoff)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('square_enrollments as e')
            .select('e.id')
            .whereRef('e.membership_id', '=', 'm.id')
            .where((eb) => eb.or([eb('e.state', 'in', [...LIVE_ENROLLMENT_STATES, 'active']), eb('e.cleanup', '=', 'pending'), eb('e.updated_at', '>', cutoff)])),
        ),
      ),
    )
    .execute()
  let n = 0
  for (const r of rows)
    await transaction(x.db, async (tx) => {
      const now = x.clock.now()
      const m = await tx.selectFrom('memberships').select(['status', 'source']).where('id', '=', r.id).forUpdate().executeTakeFirstOrThrow()
      if (m.status !== 'pending' || m.source !== 'square') return
      await tx
        .updateTable('memberships')
        .set((eb) => ({ status: 'canceled', canceled_at: now, cancel_reason: 'enrollment_failed', updated_at: now, version: eb('version', '+', 1) }))
        .where('id', '=', r.id)
        .execute()
      await audit.record(tx, { locationId: x.locationId, action: 'membership.square.enroll_closed', entityType: 'membership', entityId: r.id, ctx: { actor: { name: 'Square' } } })
      n++
    })
  return n
}
