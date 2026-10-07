// The outbox for staff: texts that failed or expired (with retry and cancel), what is still waiting, and the quarantine of
// texts from numbers that are not customers.
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import * as audit from '../../../platform/audit.js'
import { transaction } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { decodeCursor, keysetCondition, paginationQuery, toPage } from '../../../platform/pagination.js'
import { canSeeContact } from '../../people/redact.js'
import { maskPhone } from '../../../platform/phone.js'
import { SENSITIVE_CLASSES, REDACTED_BODY } from '../db/messages.js'
import { PgOutboxRepository } from '../db/outbox-repo.js'
import type { MessagingRuntime } from '../runtime.js'
import './problems.js'

const TAGS = ['messages']
const Uuid = z.string().uuid()
const IdParams = z.object({ id: Uuid })

const OutboxItemOut = z.object({
  id: z.string(),
  state: z.enum(['pending', 'inflight', 'accepted', 'sent', 'delivered', 'failed', 'expired', 'cancelled']),
  klass: z.string(),
  lane: z.number().int(),
  to: z.string(),
  text: z.string(),
  segments: z.number().int(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  queuedAt: z.string(),
  ttlAt: z.string(),
  nextAttemptAt: z.string().nullable(),
  customerId: z.string().nullable(),
  customerName: z.string().nullable(),
  appointmentId: z.string().nullable(),
  canRetry: z.boolean(),
  canCancel: z.boolean(),
})

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

export function registerOutboxRoutes(app: AppInstance, rt: MessagingRuntime): void {
  app.get(
    '/messages/outbox',
    {
      config: { access: access.perm('msg.send') },
      schema: {
        tags: TAGS,
        summary: 'Texts by queue state (default failed), newest first',
        description:
          '`state` is pending, failed, expired, cancelled, delivered or all. A failed text is one the device or the network refused after the retries; an expired one outlived its class TTL (a welcome text is worth 15 minutes). The number is masked without cli.contact; staff invites and resets never show their link.',
        querystring: paginationQuery.extend({
          state: z.enum(['pending', 'failed', 'expired', 'cancelled', 'delivered', 'all']).default('failed'),
        }),
        response: { 200: z.object({ items: z.array(OutboxItemOut), nextCursor: z.string().nullable() }) },
      },
    },
    async (req) => {
      const { state, limit, cursor } = req.query
      let q = app.db
        .selectFrom('sms_outbox as o')
        .innerJoin('messages as m', 'm.id', 'o.message_id')
        .leftJoin('customers as c', 'c.id', 'm.customer_id')
        .select([
          'o.id',
          'o.state',
          'o.klass',
          'o.priority',
          'o.to_e164',
          'o.body',
          'o.segments',
          'o.attempts',
          'o.last_error',
          'o.queued_at',
          'o.ttl_at',
          'o.next_attempt_at',
          'm.customer_id',
          'm.appointment_id',
          'c.full_name',
        ])
        .where('m.location_id', '=', req.auth!.locationId)
      if (state !== 'all') q = q.where('o.state', '=', state)
      if (cursor) {
        const [at, id] = decodeCursor(cursor, 2)
        q = q.where(keysetCondition(['o.queued_at', 'o.id'], [at as string, id as string], 'desc') as never)
      }
      const rows = await q
        .orderBy('o.queued_at', 'desc')
        .orderBy('o.id', 'desc')
        .limit(limit + 1)
        .execute()
      const contact = canSeeContact(req.auth!)
      const page = toPage(rows, limit, (r) => [r.queued_at.toISOString(), r.id])
      return {
        items: page.items.map((r) => ({
          id: r.id,
          state: r.state,
          klass: r.klass,
          lane: r.priority,
          to: contact ? r.to_e164 : maskPhone(r.to_e164),
          text: SENSITIVE_CLASSES.has(r.klass) ? REDACTED_BODY : r.body,
          segments: r.segments,
          attempts: r.attempts,
          lastError: r.last_error,
          queuedAt: r.queued_at.toISOString(),
          ttlAt: r.ttl_at.toISOString(),
          nextAttemptAt: iso(r.next_attempt_at),
          customerId: r.customer_id,
          customerName: r.full_name,
          appointmentId: r.appointment_id,
          canRetry: (r.state === 'failed' || r.state === 'expired') && !SENSITIVE_CLASSES.has(r.klass),
          canCancel: r.state === 'pending',
        })),
        nextCursor: page.nextCursor,
      }
    },
  )

  const Acted = z.object({ id: z.string(), state: z.string() })

  app.post(
    '/messages/:id/retry',
    {
      config: { access: access.perm('msg.send') },
      schema: {
        tags: TAGS,
        summary:
          'Send a failed or expired text again (a fresh attempt under a new device id, with a fresh TTL)',
        params: IdParams,
        response: { 200: Acted },
      },
    },
    async (req) =>
      transaction(app.db, async (tx) => {
        const row = await tx
          .selectFrom('sms_outbox as o')
          .innerJoin('messages as m', 'm.id', 'o.message_id')
          .select(['o.id', 'o.state', 'o.klass', 'm.location_id'])
          .where('o.id', '=', req.params.id)
          .where('m.location_id', '=', req.auth!.locationId)
          .forUpdate()
          .executeTakeFirst()
        if (!row) throw new AppError('NOT_FOUND')
        if ((row.state !== 'failed' && row.state !== 'expired') || SENSITIVE_CLASSES.has(row.klass))
          throw new AppError('MESSAGE_NOT_RETRYABLE')
        const device = (await rt.store.listEnabled(row.location_id))[0]
        if (!device) throw new AppError('SMS_NO_DEVICE')
        const { dispatcher } = rt.dispatcherFor(device, tx)
        if (!(await dispatcher.retryFailed(row.id))) throw new AppError('MESSAGE_NOT_RETRYABLE')
        await audit.record(tx, {
          locationId: row.location_id,
          action: 'message.retry',
          entityType: 'message',
          entityId: row.id,
          before: { state: row.state },
          after: { state: 'pending' },
          ctx: auditContextOf(req),
        })
        return { id: row.id, state: 'pending' }
      }),
  )

  app.post(
    '/messages/:id/cancel',
    {
      config: { access: access.perm('msg.send') },
      schema: {
        tags: TAGS,
        summary: 'Cancel a text that has not been handed to the device yet',
        params: IdParams,
        response: { 200: Acted },
      },
    },
    async (req) =>
      transaction(app.db, async (tx) => {
        const repo = new PgOutboxRepository(tx, { deviceId: null })
        const row = await tx
          .selectFrom('sms_outbox as o')
          .innerJoin('messages as m', 'm.id', 'o.message_id')
          .select(['o.id', 'o.state', 'm.location_id'])
          .where('o.id', '=', req.params.id)
          .where('m.location_id', '=', req.auth!.locationId)
          .forUpdate()
          .executeTakeFirst()
        if (!row) throw new AppError('NOT_FOUND')
        if (row.state !== 'pending') throw new AppError('MESSAGE_NOT_CANCELABLE')
        await repo.update(row.id, { state: 'cancelled', lastError: 'cancelled by staff' })
        await audit.record(tx, {
          locationId: row.location_id,
          action: 'message.cancel',
          entityType: 'message',
          entityId: row.id,
          before: { state: 'pending' },
          after: { state: 'cancelled' },
          ctx: auditContextOf(req),
        })
        return { id: row.id, state: 'cancelled' }
      }),
  )

  const InboxRow = z.object({
    id: z.string(),
    from: z.string(),
    text: z.string(),
    receivedAt: z.string(),
    reason: z.string(),
  })

  app.get(
    '/messages/inbox',
    {
      config: { access: access.perm('msg.send') },
      schema: {
        tags: TAGS,
        summary:
          'Quarantine: texts from numbers that are not customers (no customer row is ever created for them)',
        description:
          'Carrier notices, one-time codes and strangers land here and are reviewed or ignored. A STOP, START or HELP from a stranger was still honoured by number. The sender is masked without cli.contact.',
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: z.object({ items: z.array(InboxRow) }) },
      },
    },
    async (req) => {
      const rows = await app.db
        .selectFrom('sms_inbox as i')
        .innerJoin('sms_devices as d', 'd.id', 'i.device_id')
        .select(['i.id', 'i.from_raw', 'i.from_e164', 'i.body', 'i.received_at', 'i.decision'])
        .where('d.location_id', '=', req.auth!.locationId)
        .where('i.quarantined', '=', true)
        .where('i.reviewed_at', 'is', null)
        .orderBy('i.received_at', 'desc')
        .limit(req.query.limit)
        .execute()
      const contact = canSeeContact(req.auth!)
      return {
        items: rows.map((r) => ({
          id: r.id,
          from: contact ? (r.from_e164 ?? r.from_raw) : maskPhone(r.from_e164 ?? r.from_raw),
          text: r.body,
          receivedAt: r.received_at.toISOString(),
          reason: r.from_e164 ? 'unknown_sender' : 'not_a_phone_number',
        })),
      }
    },
  )

  app.post(
    '/messages/inbox/:id/review',
    {
      config: { access: access.perm('msg.send') },
      schema: {
        tags: TAGS,
        summary: 'Mark a quarantined text as reviewed',
        params: IdParams,
        response: { 200: z.object({ id: z.string() }) },
      },
    },
    async (req) => {
      const r = await app.db
        .updateTable('sms_inbox')
        .set({ reviewed_at: app.clock.now() })
        .where('id', '=', req.params.id)
        .where('quarantined', '=', true)
        .where(
          'device_id',
          'in',
          app.db.selectFrom('sms_devices').select('id').where('location_id', '=', req.auth!.locationId),
        )
        .returning('id')
        .executeTakeFirst()
      if (!r) throw new AppError('NOT_FOUND')
      return { id: r.id }
    },
  )
}
