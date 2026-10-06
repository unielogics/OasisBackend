// Payments HTTP API (permission map per backend.md 6.1): reads need pay.reports; each command needs the permission of what
// it does and an Idempotency-Key; commands answer with the refreshed invoice detail so the screen can redraw.
import type { FastifyRequest } from 'fastify'
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import { idempotentHandler } from '../../../http/idempotent.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import { AppError } from '../../../platform/errors.js'
import { getSetting } from '../../../platform/settings.js'
import { actorFromAuth } from '../actor.js'
import { PaymentsService, type CommandContext } from '../commands.js'
import { creditEntries, summarize } from '../credit-summary.js'
import { loadCreditLots } from '../credit.js'
import { invoiceDetail, type DetailContext } from '../detail.js'
import type { PaymentsPorts } from '../ports.js'
import {
  approvalsQueue,
  invoiceList,
  invoicesCsv,
  reconciliation,
  summary,
  type ReportContext,
} from '../reports.js'
import type { CreditExpiry } from '../schema.js'
import {
  AdjustBody,
  AdjustResult,
  ApprovalsResult,
  ApproveBody,
  ClientCreditResult,
  CollectBody,
  CollectResult,
  ConfirmBody,
  CreditBody,
  DenyBody,
  EventParams,
  EventResult,
  ExportQuery,
  IdParams,
  InvoiceDetail,
  InvoiceResult,
  ListQuery,
  ListResult,
  PaymentLinkBody,
  PaymentLinkResult,
  RangeQuery,
  ReceiptBody,
  ReceiptResult,
  ReconciliationResult,
  RefundBody,
  Summary,
  TipBody,
  VoidBody,
} from './schemas.js'

const TAG = 'payments'

const expiryOf = (v: string): CreditExpiry =>
  v === 'none' || v === 'No expiry' ? 'none' : v === 'd30' || v === '30 days' ? 'd30' : 'd90'

export function registerPaymentsRoutes(
  app: AppInstance,
  service: PaymentsService,
  ports: PaymentsPorts,
): void {
  const auth = (req: FastifyRequest) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED')
    return req.auth
  }
  const tzOf = async (locationId: string): Promise<string> =>
    (await app.db.selectFrom('locations').select('timezone').where('id', '=', locationId).executeTakeFirst())
      ?.timezone ?? 'America/New_York'
  const reportCtx = async (req: FastifyRequest): Promise<ReportContext> => {
    const a = auth(req)
    return { locationId: a.locationId, now: app.clock.now(), tz: await tzOf(a.locationId) }
  }
  const rulesOf = async (locationId: string) => ({
    allowSelf: (await getSetting(app.db, locationId, 'approvals.allow_self')).value,
  })
  const detailCtx = async (req: FastifyRequest): Promise<DetailContext> => {
    const r = await reportCtx(req)
    return { ...r, actor: actorFromAuth(auth(req)), rules: await rulesOf(r.locationId) }
  }
  const commandCtx = (req: FastifyRequest): CommandContext => {
    const a = auth(req)
    const key = req.headers['idempotency-key']
    return {
      locationId: a.locationId,
      actor: actorFromAuth(a),
      audit: auditContextOf(req),
      idempotencyKey: typeof key === 'string' ? key : null,
    }
  }
  const mutate = { idempotency: 'required' as const }
  // The wrapper writes the reply itself (status, replay header), which the response-schema typing of the route cannot see.
  const idem = (fn: Parameters<typeof idempotentHandler<FastifyRequest>>[0]): never =>
    idempotentHandler(fn) as never

  // --- reads --------------------------------------------------------------------------------------------------------

  app.get(
    '/payments/summary',
    {
      config: { access: access.perm('pay.reports') },
      schema: {
        tags: [TAG],
        summary: 'KPIs, chart, collected-by-method, filter counts and pending approvals for a range',
        description:
          'Ranges are inclusive business days ending today in the business timezone (`today`, `7d`, `30d`, `mtd`). All amounts are integer cents. ' +
          'Net revenue = gross + adjustments - refunds with their tax portion removed (half-up). `pendingApprovals` and `awaitingProcessor` are global, not range-filtered.',
        querystring: RangeQuery,
        response: { 200: Summary },
      },
    },
    async (req) => summary(app.db, await reportCtx(req), req.query.range),
  )

  app.get(
    '/payments/invoices',
    {
      config: { access: access.perm('pay.reports') },
      schema: {
        tags: [TAG],
        summary: 'Invoice list of a range, newest business day first',
        description:
          'Sorted by `bizDate desc, invoiceNo desc`; keyset pagination (`nextCursor`). `filter`: all, unpaid (balance > 0), refunds (refunded or pending), adjusted, credits (credit issued or applied). ' +
          '`q` searches invoice id, client, vehicle and item names (case-insensitive, over the joined text like the design).',
        querystring: ListQuery,
        response: { 200: ListResult },
      },
    },
    async (req) => invoiceList(app.db, await reportCtx(req), req.query),
  )

  app.get(
    '/invoices/:id',
    {
      config: { access: access.perm('pay.reports') },
      schema: {
        tags: [TAG],
        summary: 'One invoice: items, adjustment lines, calc, ledger (newest first) and client credit',
        description:
          'Ledger order is `occurredAt desc, seq desc`. `canApprove` / `approveBlock` on each pending refund are evaluated for the caller (limit, self-approval).',
        params: IdParams,
        response: { 200: InvoiceDetail },
      },
    },
    async (req) => invoiceDetail(app.db, await detailCtx(req), req.params.id),
  )

  app.get(
    '/payments/approvals',
    {
      config: { access: access.perm('pay.reports') },
      schema: {
        tags: [TAG],
        summary: 'Refunds waiting for approval, oldest first',
        response: { 200: ApprovalsResult },
      },
    },
    async (req) => {
      const r = await reportCtx(req)
      return { items: await approvalsQueue(app.db, r, actorFromAuth(auth(req)), await rulesOf(r.locationId)) }
    },
  )

  app.get(
    '/payments/export.csv',
    {
      config: { access: access.perm('pay.reports') },
      schema: {
        tags: [TAG],
        summary: 'CSV of the invoices in the range (narrowed by filter and search)',
        description:
          'UTF-8 with BOM, CRLF, RFC 4180 quoting, money as plain decimals, text cells starting with = + - @ prefixed with an apostrophe. ' +
          'Filename `oasis-invoices_{from}_{to}.csv`. At most 20,000 rows.',
        querystring: ExportQuery,
      },
    },
    async (req, reply) => {
      const csv = await invoicesCsv(app.db, await reportCtx(req), req.query)
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${csv.filename}"`)
        .header('X-Row-Count', String(csv.rows))
        .send(csv.body)
    },
  )

  app.get(
    '/payments/reconciliation',
    {
      config: { access: access.anyPerm('pay.reports', 'set.billing') },
      schema: {
        tags: [TAG],
        summary:
          'Card money waiting on Squarespace for more than 2 hours, unmatched Squarespace records, overpaid invoices',
        response: { 200: ReconciliationResult },
      },
    },
    async (req) => reconciliation(app.db, await reportCtx(req), ports.unmatched),
  )

  app.get(
    '/clients/:id/credit',
    {
      config: { access: access.perm('pay.reports') },
      schema: {
        tags: [TAG],
        summary: 'Store-credit balance and lots of a client (expired lots leave the balance)',
        params: IdParams,
        response: { 200: ClientCreditResult },
      },
    },
    async (req) => {
      const known = await app.db
        .selectFrom('customers')
        .select('id')
        .where('id', '=', req.params.id)
        .executeTakeFirst()
      if (!known) throw new AppError('NOT_FOUND', { detail: 'That client does not exist' })
      const now = app.clock.now()
      const lots = await loadCreditLots(app.db, req.params.id)
      const s = summarize(lots, now)
      return { customerId: req.params.id, ...s, entries: creditEntries(lots, now) }
    },
  )

  // --- commands -----------------------------------------------------------------------------------------------------

  type P = { id: string }
  type PE = { id: string; eventId: string }

  app.post(
    '/invoices/:id/payments',
    {
      config: { access: access.perm('pay.collect'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Collect the full balance: card, cash or a payment link',
        description:
          'Cash records a `pay`. Card records a `pay` that counts immediately with `processorState: awaiting_processor` (completed in Squarespace; label is the card brand only). ' +
          '`payment_link` creates a payment link and queues the SMS; no ledger event. 422 `PAY_NOTHING_TO_COLLECT` when the balance is 0.',
        params: IdParams,
        body: CollectBody,
        response: { 201: CollectResult },
      },
    },
    idem(async (req, tx) => {
      const r = await service.collect(
        tx,
        commandCtx(req),
        (req.params as P).id,
        req.body as z.infer<typeof CollectBody>,
      )
      return { status: 201, body: r }
    }),
  )

  app.post(
    '/invoices/:id/credit-applications',
    {
      config: { access: access.perm('pay.collect'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Apply store credit to the invoice: min(usable credit, balance)',
        params: IdParams,
        body: z.object({}).strict(),
        response: { 201: EventResult },
      },
    },
    idem(async (req, tx) => ({
      status: 201,
      body: await service.applyCredit(tx, commandCtx(req), (req.params as P).id),
    })),
  )

  app.post(
    '/invoices/:id/refunds',
    {
      config: { access: access.perm('pay.refund'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Refund (full, by item or custom) to the original card, store credit or cash',
        description:
          "Pending (waiting for approval) exactly when the amount is strictly greater than the caller's refund limit; otherwise done. " +
          'Errors: 422 `REFUND_EXCEEDS_CARD` (card cap), `REFUND_EXCEEDS_REFUNDABLE`, `ITEM_ALREADY_REFUNDED`, `PAY_AMOUNT_INVALID`.',
        params: IdParams,
        body: RefundBody,
        response: { 201: EventResult },
      },
    },
    idem(async (req, tx) => ({
      status: 201,
      body: await service.refund(
        tx,
        commandCtx(req),
        (req.params as P).id,
        req.body as z.infer<typeof RefundBody>,
      ),
    })),
  )

  app.post(
    '/invoices/:id/refunds/:eventId/approve',
    {
      config: { access: access.perm('pay.refund'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Approve a pending refund',
        description:
          'Needs pay.refund and a limit of at least the amount (403 `CANT_APPROVE`); the requester cannot approve their own request unless they have no limit or approvals.allow_self is on (403 `SELF_APPROVAL`). ' +
          "Refundable and card cap are re-validated without this request's own reservation. 409 `REFUND_NOT_PENDING`.",
        params: EventParams,
        body: ApproveBody,
        response: { 200: EventResult },
      },
    },
    idem(async (req, tx) => {
      const p = req.params as PE
      return { status: 200, body: await service.approveRefund(tx, commandCtx(req), p.id, p.eventId) }
    }),
  )

  app.post(
    '/invoices/:id/refunds/:eventId/deny',
    {
      config: { access: access.perm('pay.refund'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Deny a pending refund (the requester may withdraw their own)',
        params: EventParams,
        body: DenyBody,
        response: { 200: EventResult },
      },
    },
    idem(async (req, tx) => {
      const p = req.params as PE
      return {
        status: 200,
        body: await service.denyRefund(
          tx,
          commandCtx(req),
          p.id,
          p.eventId,
          req.body as z.infer<typeof DenyBody>,
        ),
      }
    }),
  )

  app.post(
    '/invoices/:id/adjustments',
    {
      config: { access: access.perm('pay.adjust'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Discount or surcharge before tax, in $ (cents) or % (basis points) of the items subtotal',
        description:
          'Blocked over the adjust limit (422 `OVER_LIMIT`: "Over your {limit} as {Role}. Ask Management or a Super Admin."). A discount that leaves a paid invoice overpaid creates a settlement refund (`settle`: credit by default) as a normal refund event with the refund limit and processor rules.',
        params: IdParams,
        body: AdjustBody,
        response: { 201: AdjustResult },
      },
    },
    idem(async (req, tx) => ({
      status: 201,
      body: await service.adjust(
        tx,
        commandCtx(req),
        (req.params as P).id,
        req.body as z.infer<typeof AdjustBody>,
      ),
    })),
  )

  app.post(
    '/invoices/:id/credits',
    {
      config: { access: access.perm('pay.credit'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Issue account credit linked to the invoice (no expiry, 30 or 90 days)',
        description:
          '`expiry` accepts `none|d30|d90` or the design labels `No expiry|30 days|90 days`. Over the credit limit: 422 `OVER_LIMIT`.',
        params: IdParams,
        body: CreditBody,
        response: { 201: EventResult },
      },
    },
    idem(async (req, tx) => {
      const b = req.body as z.infer<typeof CreditBody>
      return {
        status: 201,
        body: await service.issueCredit(tx, commandCtx(req), (req.params as P).id, {
          amountCents: b.amountCents,
          reason: b.reason,
          note: b.note,
          expiry: expiryOf(b.expiry),
        }),
      }
    }),
  )

  app.post(
    '/invoices/:id/void',
    {
      config: { access: access.perm('pay.void'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Void a cash payment or a card payment still awaiting Squarespace',
        params: IdParams,
        body: VoidBody,
        response: { 201: EventResult },
      },
    },
    idem(async (req, tx) => ({
      status: 201,
      body: await service.voidPayment(
        tx,
        commandCtx(req),
        (req.params as P).id,
        req.body as z.infer<typeof VoidBody>,
      ),
    })),
  )

  app.put(
    '/invoices/:id/tip',
    {
      config: { access: access.perm('pay.collect'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Set the tip (untaxed, added after tax)',
        params: IdParams,
        body: TipBody,
        response: { 200: InvoiceResult },
      },
    },
    idem(async (req, tx) => ({
      status: 200,
      body: await service.setTip(
        tx,
        commandCtx(req),
        (req.params as P).id,
        (req.body as z.infer<typeof TipBody>).tipCents,
      ),
    })),
  )

  app.post(
    '/invoices/:id/receipt',
    {
      config: { access: access.anyPerm('msg.send', 'pay.collect'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Queue the receipt by SMS (opted-in clients) and email',
        params: IdParams,
        body: ReceiptBody,
        response: { 200: ReceiptResult },
      },
    },
    idem(async (req, tx) => ({
      status: 200,
      body: await service.sendReceipt(tx, commandCtx(req), (req.params as P).id),
    })),
  )

  app.post(
    '/invoices/:id/payment-links',
    {
      config: { access: access.perm('pay.collect'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Attach a Squarespace checkout or invoice link and text it to the client',
        description:
          'The link must be HTTPS on an allowed host. `balance` expects the current balance (or `amountCents`); `deposit` needs `amountCents`. No ledger event until the sync or staff record the payment.',
        params: IdParams,
        body: PaymentLinkBody,
        response: { 201: PaymentLinkResult },
      },
    },
    idem(async (req, tx) => ({
      status: 201,
      body: await service.attachPaymentLink(
        tx,
        commandCtx(req),
        (req.params as P).id,
        req.body as z.infer<typeof PaymentLinkBody>,
      ),
    })),
  )

  app.post(
    '/ledger-events/:id/confirm-processor',
    {
      config: { access: access.anyPerm('pay.collect', 'pay.refund'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Confirm that a card payment or refund was completed in Squarespace',
        description:
          'Needs the permission of the original action: pay.collect for a payment, pay.refund for a refund.',
        params: z.object({ id: z.string().uuid() }),
        body: ConfirmBody,
        response: { 200: EventResult },
      },
    },
    idem(async (req, tx) => ({
      status: 200,
      body: await service.confirmProcessor(
        tx,
        commandCtx(req),
        (req.params as P).id,
        req.body as z.infer<typeof ConfirmBody>,
      ),
    })),
  )
}
