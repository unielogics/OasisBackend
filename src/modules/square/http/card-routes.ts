// Staff routes of cards on file (ADR 0171 D7, plan decision 6, wave Q3a; api-spec section 30.11):
//   GET    /customers/:id/cards                                   cli.view     the client's saved cards and their consents
//   DELETE /customers/:id/cards/:cardId                           cli.edit     remove a saved card (DisableCard at Square)
//   POST   /customers/:id/card-link                               cli.edit     text the client a card link (#/k)
//   GET    /invoices/:id/card-charges                             pay.collect | pay.reports   the saved-card charges of an invoice
//   POST   /invoices/:id/card-charges                             pay.collect  charge a balance on a saved card (client's OK)
//   GET    /appointments/:id/fee-charges                          pay.collect | sched.cancel  the visit's no-show / late-cancel fees
//   POST   /appointments/:id/fee-charges/:chargeId/charge         pay.collect  charge a proposed (or declined) fee
//   POST   /appointments/:id/fee-charges/:chargeId/waive          pay.collect  waive it (audited)
//   GET    /settings/card-fees                                    set.billing | pay.reports   fees.card_on_file
//   PUT    /settings/card-fees                                    set.billing  set the amounts, turn the fees on or off
// A charge is sent to Square in the idempotency `prepare` hook (after the key is claimed, before the command's transaction) and
// never while the invoice is locked; a replay answers the stored result. Nothing is charged while PAYMENT_PROCESSOR is squarespace
// (409 CARD_PAYMENTS_OFF) or Square is watch-only (409 SQUARE_WRITES_OFF).
import type { FastifyRequest } from 'fastify'
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import { idempotentHandler } from '../../../http/idempotent.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import * as audit from '../../../platform/audit.js'
import { transaction, type Executor } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { getSetting, updateSetting } from '../../../platform/settings.js'
import { actorFromAuth } from '../../payments/actor.js'
import { buildDetail } from '../../payments/detail.js'
import { InvoiceDetail as InvoiceDetailSchema } from '../../payments/http/schemas.js'
import { cardLabel, getInvoice } from '../../payments/repository.js'
import { textCardLink } from '../card-events.js'
import { disableCard } from '../cards.js'
import { chargeBalance, chargeFee, chargeViews, chargeView, cardsOn, waiveFee, type ChargeOutcome } from '../charges.js'
import { CARD_PURPOSES } from '../consents.js'
import type { SquareActor } from '../ledger.js'
import { squareApi, squareEnv, type SquareQueue } from '../runtime.js'
import '../problems.js'

const TAG = 'square'
const IdParams = z.object({ id: z.string().uuid() })
const CardParams = z.object({ id: z.string().uuid(), cardId: z.string().uuid() })
const ChargeParams = z.object({ id: z.string().uuid(), chargeId: z.string().uuid() })
const iso = z.string().nullable()
const PURPOSE = z.enum(CARD_PURPOSES)

const ConsentDto = z.object({
  id: z.string(),
  version: z.string(),
  purposes: z.array(PURPOSE),
  acceptedAt: z.string(),
  revokedAt: iso,
  revokeReason: z.string().nullable(),
  via: z.enum(['link', 'staff']).describe('Given on a personal link page, or recorded by staff'),
})

const SavedCardDto = z.object({
  id: z.string(),
  brand: z.string().nullable(),
  last4: z.string().nullable(),
  label: z.string().describe('"Visa ••4242"'),
  expMonth: z.number().int().nullable(),
  expYear: z.number().int().nullable(),
  state: z.enum(['active', 'disabled', 'forgotten', 'expired']),
  createdVia: z.enum(['card_link', 'membership_link', 'staff', 'square']),
  createdAt: z.string(),
  disabledAt: iso,
  disabledReason: z.string().nullable(),
  purposes: z.array(PURPOSE).describe('What the live consents allow (empty once removed)'),
  consents: z.array(ConsentDto).describe('Every consent given for this card, newest first'),
})

export const ChargeDto = z.object({
  id: z.string(),
  purpose: z.enum(['no_show_fee', 'late_cancel_fee', 'balance']),
  state: z.enum(['proposed', 'charging', 'charged', 'declined', 'unknown', 'waived']),
  amountCents: z.number().int(),
  reason: z.string(),
  card: z.object({ id: z.string(), label: z.string(), brand: z.string().nullable(), last4: z.string().nullable() }).nullable(),
  invoiceId: z.string().nullable(),
  appointmentId: z.string().nullable(),
  squarePaymentId: z.string().nullable(),
  error: z.string().nullable().describe('Why it was declined (plain words), or that Square did not answer'),
  declineCode: z.string().nullable(),
  attempts: z.number().int(),
  proposedBy: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: iso,
  chargedAt: iso,
  waiveReason: z.string().nullable(),
  createdAt: z.string(),
})

const ChargeResult = z.object({ charge: ChargeDto, invoice: InvoiceDetailSchema.nullable() })

const BalanceBody = z
  .object({
    cardId: z.string().uuid(),
    amountCents: z.number().int().min(1).max(10_000_000).describe('At most the balance'),
  })
  .strict()
const FeeChargeBody = z.object({ cardId: z.string().uuid().nullable().optional().describe('Another of the client’s cards whose consent covers the fee') }).strict()
const WaiveBody = z.object({ reason: z.string().trim().min(2).max(300) }).strict()

const FeeSettings = z
  .object({
    enabled: z.boolean().describe('Off by default: no fee is proposed'),
    noShowCents: z.number().int().min(0).max(100_000).describe('The no-show fee; what is proposed is the fee beyond the deposit kept'),
    lateCancelCents: z.number().int().min(0).max(100_000).describe('The fee of a cancel inside the free-cancellation window'),
  })
  .strict()
const FeeSettingsReply = z.object({ fees: FeeSettings, version: z.number().int(), active: z.boolean().describe('Fees are proposed now: enabled and Square is the processor') })

const LinkResult = z.object({
  sent: z.boolean(),
  reason: z.string().nullable().describe('Why no text went: opted_out, no_phone, ... (sent false)'),
  linkId: z.string().nullable(),
  expiresAt: iso,
})

export interface SquareCardRoutesWiring {
  /** The messaging queue the card link and the fee text go through (default: the process's, configureSquareQueue). */
  queue?: () => SquareQueue | undefined
}

export function registerSquareCardRoutes(app: AppInstance, w: SquareCardRoutesWiring = {}): void {
  const auth = (req: FastifyRequest) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED')
    return req.auth
  }
  const queue = (): SquareQueue | undefined => (w.queue ? w.queue() : undefined)
  const actorOf = (req: FastifyRequest, perm: string): SquareActor => {
    const a = actorFromAuth(auth(req))
    return { userId: a.userId, employeeId: a.employeeId, name: a.name, roles: a.rolesFor(perm) || null, audit: auditContextOf(req), manual: true }
  }
  const deps = (req: FastifyRequest) => {
    const env = squareEnv()
    return { db: app.db, clock: app.clock, newId: app.newId, env, api: squareApi(env), locationId: auth(req).locationId, logger: req.log, queue: queue() }
  }
  const tzOf = async (db: Executor, locationId: string): Promise<string> =>
    (await db.selectFrom('locations').select('timezone').where('id', '=', locationId).executeTakeFirst())?.timezone ?? 'America/New_York'
  const detailOf = async (req: FastifyRequest, db: Parameters<typeof buildDetail>[0], invoiceId: string | null) => {
    if (!invoiceId) return null
    const a = auth(req)
    const inv = await getInvoice(db, a.locationId, invoiceId)
    return buildDetail(
      db,
      { locationId: a.locationId, now: app.clock.now(), tz: await tzOf(db, a.locationId), actor: actorFromAuth(a), rules: { allowSelf: (await getSetting(db, a.locationId, 'approvals.allow_self')).value } },
      inv,
    )
  }
  const customerOf = async (db: Executor, id: string): Promise<void> => {
    const c = await db.selectFrom('customers').select(['id', 'merged_into']).where('id', '=', id).executeTakeFirst()
    if (!c || c.merged_into) throw new AppError('NOT_FOUND', { detail: 'That client does not exist' })
  }
  /** What a charge attempt answered, as the route says it: charged 201, unknown 202, declined 422 CARD_DECLINED (key released). */
  const settled = (o: ChargeOutcome): ChargeOutcome => {
    if (o.state === 'declined')
      throw new AppError('CARD_DECLINED', { title: 'Card declined', detail: o.error ?? 'The card was declined.', meta: { chargeId: o.chargeId } })
    return o
  }
  const chargeReply = async (req: FastifyRequest, db: Executor, o: ChargeOutcome) => ({
    status: o.state === 'charged' ? 201 : 202,
    body: { charge: await chargeView(db, o.chargeId), invoice: await detailOf(req, db as never, o.invoiceId) },
  })

  // ---- the client's saved cards ---------------------------------------------------------------------------------------------

  app.get(
    '/customers/:id/cards',
    {
      config: { access: access.perm('cli.view') },
      schema: {
        tags: [TAG],
        summary: 'The client’s saved cards and their consents',
        description:
          'Every card saved with Square for the client (active first, then removed), with what each consent allows: version, purposes, when, and when it was revoked. Only Square’s card id, brand, last 4 and expiry are kept; never a card number. `charge` tells whether the "Saved card" tender may be offered (PAYMENT_PROCESSOR=square).',
        params: IdParams,
        response: { 200: z.object({ cards: z.array(SavedCardDto), charge: z.boolean() }) },
      },
    },
    async (req) => {
      const a = auth(req)
      const { id } = req.params as z.infer<typeof IdParams>
      await customerOf(app.db, id)
      const cards = await app.db
        .selectFrom('customer_cards')
        .selectAll()
        .where('location_id', '=', a.locationId)
        .where('customer_id', '=', id)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .execute()
      const consents = cards.length
        ? await app.db.selectFrom('card_consents').selectAll().where('card_id', 'in', cards.map((c) => c.id)).orderBy('accepted_at', 'desc').execute()
        : []
      const out = cards
        .map((c) => {
          const mine = consents.filter((k) => k.card_id === c.id)
          const live = new Set(mine.filter((k) => !k.revoked_at).flatMap((k) => k.purposes))
          return {
            id: c.id,
            brand: c.brand,
            last4: c.last4,
            label: cardLabel(c.brand, c.last4).label,
            expMonth: c.exp_month,
            expYear: c.exp_year,
            state: c.state,
            createdVia: c.created_via,
            createdAt: c.created_at.toISOString(),
            disabledAt: c.disabled_at ? c.disabled_at.toISOString() : null,
            disabledReason: c.disabled_reason,
            purposes: CARD_PURPOSES.filter((p) => live.has(p)),
            consents: mine.map((k) => ({
              id: k.id,
              version: k.text_version,
              purposes: CARD_PURPOSES.filter((p) => k.purposes.includes(p)),
              acceptedAt: k.accepted_at.toISOString(),
              revokedAt: k.revoked_at ? k.revoked_at.toISOString() : null,
              revokeReason: k.revoke_reason,
              via: (k.link_id || k.session_hash ? 'link' : 'staff') as 'link' | 'staff',
            })),
          }
        })
        .sort((x, y) => Number(y.state === 'active') - Number(x.state === 'active'))
      return { cards: out, charge: cardsOn(squareEnv()) }
    },
  )

  app.delete(
    '/customers/:id/cards/:cardId',
    {
      config: { access: access.perm('cli.edit') },
      schema: {
        tags: [TAG],
        summary: 'Remove a saved card',
        description:
          'DisableCard at Square first (nothing changes when Square does not answer: 503 `SQUARE_UNAVAILABLE`, or is watch-only: 409 `SQUARE_WRITES_OFF`), then the card `disabled` and its live consents revoked by staff (audit `card.disabled`). Removing a removed card answers its state again. 404 `CARD_NOT_FOUND` for another client’s card.',
        params: CardParams,
        response: { 200: z.object({ cardId: z.string(), state: SavedCardDto.shape.state, revokedConsents: z.number().int() }) },
      },
    },
    async (req) => {
      const { id, cardId } = req.params as z.infer<typeof CardParams>
      const actor = actorOf(req, 'cli.edit')
      const out = await disableCard(deps(req), { cardId, customerId: id, by: 'staff', actorName: actor.name, audit: auditContextOf(req) })
      return { cardId: out.cardId, state: out.state, revokedConsents: out.revokedConsents }
    },
  )

  app.post(
    '/customers/:id/card-link',
    {
      config: { access: access.perm('cli.edit') },
      schema: {
        tags: [TAG],
        summary: 'Text the client a link to save a card (#/k)',
        description:
          'Issues a card link (24 hours, 3 cards, a fresh PIN or code on the page) and texts it with template `personal_link_card` ("Save a card with Oasis Auto Spa on this secure page: <link> It expires in 24 hours."); the link is stored masked. It replaces the client’s earlier card link. `sent: false` with the reason when the text could not go (opted out, no number). 409 `CARD_LINK_UNAVAILABLE` while personal links are off (PUBLIC_LINKS_ENABLED=false), 409 `CARD_PAYMENTS_OFF` before Square is the processor. Audited (`card.link_sent`).',
        params: IdParams,
        body: z.object({}).strict(),
        response: { 200: LinkResult },
      },
    },
    async (req) => {
      const a = auth(req)
      const { id } = req.params as z.infer<typeof IdParams>
      const env = squareEnv()
      if (!app.env.PUBLIC_LINKS_ENABLED) throw new AppError('CARD_LINK_UNAVAILABLE')
      if (!cardsOn(env)) throw new AppError('CARD_PAYMENTS_OFF')
      await customerOf(app.db, id)
      return transaction(app.db, async (tx) => {
        const out = await textCardLink(
          tx,
          { clock: app.clock, newId: app.newId, env: app.env, queue: queue(), logger: req.log },
          { locationId: a.locationId, customerId: id, issuedBy: 'staff', senderKind: 'staff' },
        )
        if (!out.sent && out.reason === 'no_queue') throw new AppError('SERVICE_UNAVAILABLE', { detail: 'Text messaging is not connected yet' })
        if (!out.sent && out.reason === 'not_found') throw new AppError('NOT_FOUND', { detail: 'That client does not exist' })
        await audit.record(tx, {
          locationId: a.locationId,
          action: 'card.link_sent',
          entityType: 'customer',
          entityId: id,
          after: out.sent ? { linkId: out.linkId, expiresAt: out.expiresAt.toISOString() } : { sent: false, reason: out.reason },
          ctx: auditContextOf(req),
        })
        return out.sent
          ? { sent: true, reason: null, linkId: out.linkId, expiresAt: out.expiresAt.toISOString() }
          : { sent: false, reason: out.reason, linkId: null, expiresAt: null }
      })
    },
  )

  // ---- charges --------------------------------------------------------------------------------------------------------------

  app.get(
    '/invoices/:id/card-charges',
    {
      config: { access: access.anyPerm('pay.collect', 'pay.reports') },
      schema: {
        tags: [TAG],
        summary: 'The saved-card charges of an invoice (balances and fees), newest first',
        params: IdParams,
        response: { 200: z.object({ items: z.array(ChargeDto) }) },
      },
    },
    async (req) => {
      const a = auth(req)
      const { id } = req.params as z.infer<typeof IdParams>
      await getInvoice(app.db, a.locationId, id)
      const rows = await app.db.selectFrom('square_charges').selectAll().where('invoice_id', '=', id).where('location_id', '=', a.locationId).orderBy('created_at', 'desc').execute()
      return { items: await chargeViews(app.db, rows) }
    },
  )

  app.post(
    '/invoices/:id/card-charges',
    {
      config: { access: access.perm('pay.collect'), idempotency: 'required' as const },
      schema: {
        tags: [TAG],
        summary: 'Charge a saved card for the balance (the client said yes)',
        description:
          'Staff confirm a charge on one of the client’s saved cards whose consent covers `balance` (plan decision 6: only after staff confirm, with the client’s OK). CreatePayment (the card, its Square customer, autocomplete, `reference_id` the charge, a note naming the invoice) is sent before the command’s transaction and never while the invoice is locked; the payment is recorded as a confirmed Square `pay` (rule `charge`, the ledger reason "Balance"). ' +
          '201 `{charge, invoice}` charged; 202 the same with `charge.state` `unknown` when Square did not answer (the job square.charges.resolve sends the same request with the same key and records it; nothing is charged twice). 422 `CARD_DECLINED` with the plain reason in `detail` (the charge is kept as `declined`); 422 `CARD_NOT_USABLE` (removed, expired, or no consent for balances), 422 `PAY_AMOUNT_INVALID` (more than the balance), 422 `PAY_NOTHING_TO_COLLECT`, 409 `CARD_CHARGE_IN_PROGRESS` (another charge waits for Square), 409 `CARD_PAYMENTS_OFF`, 409 `SQUARE_WRITES_OFF`. Idempotent: the same key answers the stored result. Audited (`card.charge_started`, `card.charged` / `card.charge_declined`).',
        params: IdParams,
        body: BalanceBody,
        response: { 201: ChargeResult, 202: ChargeResult },
      },
    },
    idempotentHandler<FastifyRequest, ChargeOutcome>(async (req, tx, _reply, outcome) => chargeReply(req, tx, outcome), {
      prepare: async (req) => {
        const { id } = req.params as z.infer<typeof IdParams>
        const b = req.body as z.infer<typeof BalanceBody>
        return settled(await chargeBalance(deps(req), { invoiceId: id, cardId: b.cardId, amountCents: b.amountCents, actor: actorOf(req, 'pay.collect') }))
      },
    }) as never,
  )

  app.get(
    '/appointments/:id/fee-charges',
    {
      config: { access: access.anyPerm('pay.collect', 'sched.cancel') },
      schema: {
        tags: [TAG],
        summary: 'The visit’s no-show and late-cancel fees on a saved card',
        description: 'Proposed by the cancel or no-show (fees.card_on_file on, Square the processor), then charged, declined, unanswered or waived. Newest first.',
        params: IdParams,
        response: { 200: z.object({ items: z.array(ChargeDto) }) },
      },
    },
    async (req) => {
      const a = auth(req)
      const { id } = req.params as z.infer<typeof IdParams>
      const rows = await app.db
        .selectFrom('square_charges')
        .selectAll()
        .where('appointment_id', '=', id)
        .where('location_id', '=', a.locationId)
        .where('purpose', 'in', ['no_show_fee', 'late_cancel_fee'])
        .orderBy('created_at', 'desc')
        .execute()
      return { items: await chargeViews(app.db, rows) }
    },
  )

  app.post(
    '/appointments/:id/fee-charges/:chargeId/charge',
    {
      config: { access: access.perm('pay.collect'), idempotency: 'required' as const },
      schema: {
        tags: [TAG],
        summary: 'Charge a proposed no-show or late-cancel fee on the saved card',
        description:
          'The fee the cancel or no-show proposed, charged now on its card (or `cardId`, another of the client’s cards whose consent covers that fee). A declined fee may be charged again (a new attempt with a new key). The payment is recorded on the visit’s canceled invoice (the ledger reason "No-show fee" / "Late-cancel fee": the invoice reads canceled, kept) and the client is texted `card_fee_charged`. 201 charged, 202 Square did not answer (`unknown`: the job resolves it), 422 `CARD_DECLINED`, 422 `CARD_NOT_USABLE`, 409 `CARD_CHARGE_DECIDED` (charged or waived), 409 `CARD_CHARGE_IN_PROGRESS`, 409 `CARD_PAYMENTS_OFF`, 409 `SQUARE_WRITES_OFF`, 404 `CARD_CHARGE_NOT_FOUND`. Idempotent.',
        params: ChargeParams,
        body: FeeChargeBody,
        response: { 201: ChargeResult, 202: ChargeResult },
      },
    },
    idempotentHandler<FastifyRequest, ChargeOutcome>(async (req, tx, _reply, outcome) => chargeReply(req, tx, outcome), {
      prepare: async (req) => {
        const { id, chargeId } = req.params as z.infer<typeof ChargeParams>
        const b = req.body as z.infer<typeof FeeChargeBody>
        return settled(await chargeFee(deps(req), { appointmentId: id, chargeId, cardId: b.cardId ?? null, actor: actorOf(req, 'pay.collect') }))
      },
    }) as never,
  )

  app.post(
    '/appointments/:id/fee-charges/:chargeId/waive',
    {
      config: { access: access.perm('pay.collect'), idempotency: 'required' as const },
      schema: {
        tags: [TAG],
        summary: 'Waive a proposed (or declined) no-show or late-cancel fee',
        description: 'Nothing is charged; the reason is kept (audit `card.fee_waived`, an activity line). 409 `CARD_CHARGE_DECIDED` once charged or waived, 409 `CARD_CHARGE_IN_PROGRESS`, 404 `CARD_CHARGE_NOT_FOUND`.',
        params: ChargeParams,
        body: WaiveBody,
        response: { 200: z.object({ charge: ChargeDto }) },
      },
    },
    idempotentHandler(async (req, tx) => {
      const { id, chargeId } = req.params as z.infer<typeof ChargeParams>
      const b = req.body as z.infer<typeof WaiveBody>
      await waiveFee(tx, { clock: app.clock, locationId: auth(req).locationId }, { appointmentId: id, chargeId, reason: b.reason, actor: actorOf(req, 'pay.collect') })
      return { status: 200, body: { charge: await chargeView(tx, chargeId) } }
    }) as never,
  )

  // ---- the fee settings -----------------------------------------------------------------------------------------------------

  app.get(
    '/settings/card-fees',
    {
      config: { access: access.anyPerm('set.billing', 'pay.reports') },
      schema: {
        tags: ['settings'],
        summary: 'No-show and late-cancel fees on a saved card',
        description: 'fees.card_on_file. version 0: never saved (off, $0). `active`: fees are proposed now (enabled and PAYMENT_PROCESSOR=square).',
        response: { 200: FeeSettingsReply },
      },
    },
    async (req) => {
      const r = await getSetting(app.db, auth(req).locationId, 'fees.card_on_file')
      return { fees: r.value, version: r.version, active: r.value.enabled && cardsOn(squareEnv()) }
    },
  )

  app.put(
    '/settings/card-fees',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: ['settings'],
        summary: 'Set the no-show and late-cancel fees on a saved card',
        description:
          'Send the version you read (412 `VERSION_CONFLICT` when stale). A fee is only ever PROPOSED (the fee beyond the deposit kept, on a saved card whose consent covers it); staff charge or waive it. Audited (`settings.update`).',
        body: FeeSettings.extend({ version: z.number().int().min(0) }).strict(),
        response: { 200: FeeSettingsReply },
      },
    },
    async (req) => {
      const { version, ...fees } = req.body as z.infer<typeof FeeSettings> & { version: number }
      const saved = await transaction(app.db, (tx) =>
        updateSetting(tx, {
          locationId: auth(req).locationId,
          key: 'fees.card_on_file',
          value: fees,
          expectedVersion: version,
          updatedBy: req.auth?.realUserId ?? req.auth?.userId ?? null,
          audit: auditContextOf(req),
        }),
      )
      return { fees: saved.value, version: saved.version, active: saved.value.enabled && cardsOn(squareEnv()) }
    },
  )
}
