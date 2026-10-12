// The "Square payments to match" queue and the POS app switch (ADR 0171, design 2.5 and 2.6; api-spec section 30):
//   GET  /payments/square/unmatched                    pay.reports  the payments a person has to match
//   POST /payments/square/:paymentId/apply             pay.collect  record it on an invoice (or confirm one of its staff card entries)
//   POST /payments/square/:paymentId/ignore            pay.collect  set it aside (not an Oasis sale, a duplicate, a test, other)
//   POST /payments/square/:paymentId/reassign          pay.void     move a matched payment to the right invoice
//   POST /invoices/:id/square-pos-intents              pay.collect  "Open Square POS" (SQUARE_POS_API_ENABLED, live production only)
//   POST /payments/square/pos-callback                 pay.collect  the POS app's answer, from the dashboard's callback page
// Every command is idempotent (Idempotency-Key) and takes the payment's advisory lock before anything else, like every other path
// that decides a payment, so a person and the matcher can never both record it.
import type { FastifyRequest } from 'fastify'
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import { idempotentHandler } from '../../../http/idempotent.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import * as audit from '../../../platform/audit.js'
import { AppError } from '../../../platform/errors.js'
import { actorFromAuth } from '../../payments/actor.js'
import { PaymentsService } from '../../payments/commands.js'
import { buildDetail } from '../../payments/detail.js'
import { InvoiceDetail as InvoiceDetailSchema, SquarePaymentToMatch } from '../../payments/http/schemas.js'
import { defaultPorts } from '../../payments/ports.js'
import { getInvoice } from '../../payments/repository.js'
import { getSetting } from '../../../platform/settings.js'
import { squarePaymentsToMatch } from '../db/alerts.js'
import { factsOfRow } from '../facts.js'
import { SquareLedgerOps, type SquareActor } from '../ledger.js'
import { applySquarePayment, lockPayment, type SquarePaymentDeps } from '../payments.js'
import { handlePosCallback, posEnabled, recordPosIntent } from '../pos.js'
import { squareApi, squareEnv } from '../runtime.js'
import '../problems.js'

const TAG = 'square'

const PaymentParams = z.object({ paymentId: z.string().trim().min(4).max(64).regex(/^[A-Za-z0-9_-]+$/) })
const IdParams = z.object({ id: z.string().uuid() })

const ApplyBody = z
  .object({
    invoiceId: z.string().uuid(),
    confirmEventId: z.string().uuid().nullable().optional().describe('A staff card entry of this amount on that invoice to confirm with it'),
  })
  .strict()
const IgnoreBody = z
  .object({
    reason: z.enum(['not_oasis_sale', 'duplicate', 'test', 'other']),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict()
const ReassignBody = z.object({ toInvoiceId: z.string().uuid() }).strict()

const DecidedResult = z.object({
  paymentId: z.string(),
  matchState: z.enum(['matched', 'ignored']),
  invoiceId: z.string().nullable(),
  eventId: z.string().nullable(),
  invoice: InvoiceDetailSchema.nullable(),
})

const PosIntentResult = z.object({
  intent: z.object({
    id: z.string(),
    code: z.string().describe('OAS-PI-xxxxxx: in the payment note, it ties the POS payment to this invoice (rule R2)'),
    amountCents: z.number().int(),
    note: z.string(),
    expiresAt: z.string(),
    appSwitch: z.object({ ios: z.string(), android: z.string() }),
  }),
  invoice: InvoiceDetailSchema,
})

const PosCallbackBody = z
  .object({
    state: z.string().min(16).max(128),
    transactionId: z.string().max(128).nullable().optional(),
    clientTransactionId: z.string().max(128).nullable().optional(),
    errorCode: z.string().max(128).nullable().optional(),
  })
  .strict()
const PosCallbackResult = z.object({
  status: z.enum(['recorded', 'error', 'waiting']),
  invoiceId: z.string(),
  errorCode: z.string().nullable(),
  payments: z.number().int(),
})

export function registerSquarePaymentRoutes(app: AppInstance): void {
  const auth = (req: FastifyRequest) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED')
    return req.auth
  }
  const mutate = { idempotency: 'required' as const }
  const deps = (locationId: string): SquarePaymentDeps => ({ locationId, clock: app.clock, newId: app.newId, env: squareEnv() })
  const actorOf = (req: FastifyRequest, perm: string): SquareActor => {
    const a = actorFromAuth(auth(req))
    return { userId: a.userId, employeeId: a.employeeId, name: a.name, roles: a.rolesFor(perm) || null, audit: auditContextOf(req), manual: true }
  }
  const tzOf = async (locationId: string): Promise<string> =>
    (await app.db.selectFrom('locations').select('timezone').where('id', '=', locationId).executeTakeFirst())?.timezone ?? 'America/New_York'
  const detailOf = async (req: FastifyRequest, tx: Parameters<typeof buildDetail>[0], invoiceId: string) => {
    const a = auth(req)
    const inv = await getInvoice(tx, a.locationId, invoiceId)
    return buildDetail(
      tx,
      {
        locationId: a.locationId,
        now: app.clock.now(),
        tz: await tzOf(a.locationId),
        actor: actorFromAuth(a),
        rules: { allowSelf: (await getSetting(tx, a.locationId, 'approvals.allow_self')).value },
      },
      inv,
    )
  }
  const mirrorOf = async (tx: Parameters<typeof lockPayment>[0], locationId: string, paymentId: string) => {
    await lockPayment(tx, paymentId)
    const row = await tx
      .selectFrom('square_payments')
      .selectAll()
      .where('location_id', '=', locationId)
      .where('square_payment_id', '=', paymentId)
      .forUpdate()
      .executeTakeFirst()
    if (!row) throw new AppError('SQUARE_PAYMENT_NOT_FOUND')
    return row
  }

  app.get(
    '/payments/square/unmatched',
    {
      config: { access: access.perm('pay.reports') },
      schema: {
        tags: [TAG],
        summary: 'Square payments to match: counter payments Oasis could not record on strong evidence',
        description:
          'Oldest first. `unmatched`: the matcher found no strong evidence (plan decision 5); `pending`: a counter payment still inside SQUARE_MATCH_DELAY_SECONDS (or waiting for the next matching run). Each lists up to 5 candidate invoices, best first (`awaitingEventId` = a staff card entry of this amount there, which applying confirms).',
        response: { 200: z.object({ items: z.array(SquarePaymentToMatch) }) },
      },
    },
    async (req) => ({ items: await squarePaymentsToMatch(app.db, auth(req).locationId, app.clock.now()) }),
  )

  app.post(
    '/payments/square/:paymentId/apply',
    {
      config: { access: access.perm('pay.collect'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Record a Square payment on an invoice (or confirm one of its staff card entries with it)',
        description:
          'The payment is recorded as a `pay` (source and processor square; its tip as its own `pay` "Tip" on top, which raises the invoice tip), or, with `confirmEventId`, the staff card entry waiting on the processor is confirmed with it (same amount). 404 `SQUARE_PAYMENT_NOT_FOUND`; 409 `SQUARE_PAYMENT_DECIDED` when it was matched or set aside already (also by the matcher in the meantime); 422 `SQUARE_CONFIRM_MISMATCH` when the entry is not a waiting card entry of this amount on that invoice. Audited (`square.record_payment` / `square.confirm_awaiting`, rule `manual`).',
        params: PaymentParams,
        body: ApplyBody,
        response: { 200: DecidedResult },
      },
    },
    idempotentHandler(async (req, tx) => {
      const a = auth(req)
      const { paymentId } = req.params as z.infer<typeof PaymentParams>
      const b = req.body as z.infer<typeof ApplyBody>
      const row = await mirrorOf(tx, a.locationId, paymentId)
      if (row.status !== 'COMPLETED') throw new AppError('SQUARE_PAYMENT_DECIDED', { detail: 'Only a completed Square payment can be recorded' })
      const r = await applySquarePayment(tx, deps(a.locationId), factsOfRow(row), {
        invoiceId: b.invoiceId,
        confirmEventId: b.confirmEventId ?? null,
        actor: actorOf(req, 'pay.collect'),
      })
      return { status: 200, body: { paymentId, matchState: 'matched', invoiceId: r.invoiceId, eventId: r.eventId, invoice: await detailOf(req, tx, r.invoiceId) } }
    }) as never,
  )

  app.post(
    '/payments/square/:paymentId/ignore',
    {
      config: { access: access.perm('pay.collect'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Set a Square payment aside: not an Oasis sale, a duplicate, a test, or another reason',
        description: 'Nothing is written to the ledger. 409 `SQUARE_PAYMENT_DECIDED` once matched or set aside. Audited (`square.payment_ignored`).',
        params: PaymentParams,
        body: IgnoreBody,
        response: { 200: DecidedResult },
      },
    },
    idempotentHandler(async (req, tx) => {
      const a = auth(req)
      const { paymentId } = req.params as z.infer<typeof PaymentParams>
      const b = req.body as z.infer<typeof IgnoreBody>
      const row = await mirrorOf(tx, a.locationId, paymentId)
      if (row.match_state === 'matched' || row.match_state === 'ignored') throw new AppError('SQUARE_PAYMENT_DECIDED')
      const actor = actorOf(req, 'pay.collect')
      const now = app.clock.now()
      await tx
        .updateTable('square_payments')
        .set({
          match_state: 'ignored',
          ignore_reason: b.reason,
          ignore_note: b.note ?? null,
          decided_by: actor.name,
          decided_by_user_id: actor.userId ?? null,
          decided_at: now,
          updated_at: now,
        })
        .where('id', '=', row.id)
        .execute()
      await audit.record(tx, {
        locationId: a.locationId,
        action: 'square.payment_ignored',
        entityType: 'square_payment',
        entityId: paymentId,
        after: { reason: b.reason, note: b.note ?? null, amountCents: row.amount_cents },
        ctx: auditContextOf(req),
      })
      return { status: 200, body: { paymentId, matchState: 'ignored', invoiceId: null, eventId: null, invoice: null } }
    }) as never,
  )

  app.post(
    '/payments/square/:paymentId/reassign',
    {
      config: { access: access.perm('pay.void'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Move a matched Square payment to the right invoice',
        description:
          'A `void` of what it wrote on the wrong invoice (its tip too, which leaves that invoice\'s tip), then the payment recorded on the right one (rule `reassign`). 409 `SQUARE_PAYMENT_NOT_MATCHED` unless matched; 409 `SQUARE_REASSIGN_REFUNDED` once money was refunded against it. Audited (`square.reassign_from`, `square.record_payment`).',
        params: PaymentParams,
        body: ReassignBody,
        response: { 200: DecidedResult },
      },
    },
    idempotentHandler(async (req, tx) => {
      const a = auth(req)
      const { paymentId } = req.params as z.infer<typeof PaymentParams>
      const b = req.body as z.infer<typeof ReassignBody>
      const row = await mirrorOf(tx, a.locationId, paymentId)
      if (row.match_state !== 'matched' || !row.event_id) throw new AppError('SQUARE_PAYMENT_NOT_MATCHED')
      await getInvoice(tx, a.locationId, b.toInvoiceId)
      const ops = new SquareLedgerOps(deps(a.locationId))
      const r = await ops.reassign(tx, { facts: factsOfRow(row), fromEventId: row.event_id, toInvoiceId: b.toInvoiceId, actor: actorOf(req, 'pay.void') })
      return { status: 200, body: { paymentId, matchState: 'matched', invoiceId: b.toInvoiceId, eventId: r.eventId, invoice: await detailOf(req, tx, b.toInvoiceId) } }
    }) as never,
  )

  app.post(
    '/invoices/:id/square-pos-intents',
    {
      config: { access: access.perm('pay.collect'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'Open the Square POS app for the balance (app switch, production only)',
        description:
          'Only with SQUARE_POS_API_ENABLED, live production Square and an application id (404 `SQUARE_POS_DISABLED` otherwise). Records the staff card entry for the whole balance (as the "Square reader" tender: it counts at once, waiting on Square) and an intent with a random state and a short code for the payment note (`INV-20640 · OAS-PI-xxxxxx`), then answers the iOS and Android app-switch URLs. The payment is recorded on that entry when the app answers (POST /payments/square/pos-callback) or the webhook brings it (rule R2). 422 `PAY_NOTHING_TO_COLLECT`.',
        params: IdParams,
        body: z.object({}).strict(),
        response: { 201: PosIntentResult },
      },
    },
    idempotentHandler(async (req, tx) => {
      const env = squareEnv()
      if (!posEnabled(env)) throw new AppError('SQUARE_POS_DISABLED')
      const a = auth(req)
      const { id } = req.params as z.infer<typeof IdParams>
      const key = req.headers['idempotency-key']
      const service = new PaymentsService({ clock: app.clock, newId: app.newId, ports: defaultPorts() })
      const r = await service.collect(
        tx,
        { locationId: a.locationId, actor: actorFromAuth(a), audit: auditContextOf(req), idempotencyKey: typeof key === 'string' ? key : null },
        id,
        { method: 'card' },
      )
      if (!('event' in r)) throw new AppError('PAY_NOTHING_TO_COLLECT')
      const inv = await getInvoice(tx, a.locationId, id)
      const intent = await recordPosIntent(tx, { clock: app.clock, newId: app.newId, env }, {
        locationId: a.locationId,
        invoiceId: id,
        invoiceNo: inv.invoice_no,
        ledgerEventId: r.event.id,
        amountCents: r.event.amountCents,
        createdBy: a.userId,
      })
      return { status: 201, body: { intent, invoice: r.invoice } }
    }) as never,
  )

  app.post(
    '/payments/square/pos-callback',
    {
      config: { access: access.perm('pay.collect'), ...mutate },
      schema: {
        tags: [TAG],
        summary: 'The Square POS app’s answer, posted by the dashboard’s callback page',
        description:
          '`state` must be an intent\'s (404 `SQUARE_POS_INTENT_UNKNOWN`). An `errorCode` is kept (the staff entry stays waiting: void it if nothing was charged). With a `transactionId` the order\'s payments are fetched and recorded at once on the intent\'s entry (rule R2); if Square cannot be read now, the webhook records them later (`waiting`).',
        body: PosCallbackBody,
        response: { 200: PosCallbackResult },
      },
    },
    // the work runs in the prepare hook (its own short transactions and the Square reads, outside the idempotency transaction)
    idempotentHandler<FastifyRequest, Awaited<ReturnType<typeof handlePosCallback>>>(async (_req, _tx, _reply, out) => ({ status: 200, body: out }), {
      prepare: async (req) => {
        const a = auth(req)
        const env = squareEnv()
        return handlePosCallback(
          { db: app.db, clock: app.clock, newId: app.newId, env, api: squareApi(env), logger: req.log, locationId: a.locationId },
          req.body as z.infer<typeof PosCallbackBody>,
        )
      },
    }) as never,
  )
}
