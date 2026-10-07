// The conversation endpoints of the Operations Messages tab: the thread of an appointment or a customer, sending a text,
// the quick replies and automations, and marking a thread read.
import { sql } from 'kysely'
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import { idempotentHandler } from '../../../http/idempotent.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import { AppError } from '../../../platform/errors.js'
import { transaction, type Executor, type Tx } from '../../../platform/db.js'
import * as realtime from '../../../platform/realtime.js'
import { actorName, type Actor } from '../../scheduling/context.js'
import { loadCustomerTarget } from '../db/recipients.js'
import { listThreadMessages, loadMessageDto, locationTz, type MessageDto } from '../db/messages.js'
import { classSpec, isTransactional, type SmsClass } from '../policy/classes.js'
import type { MessagingRuntime } from '../runtime.js'
import { formatAppointmentTime, formatWhen } from '../templates/format.js'
import { isTemplateKey, QUICK_REPLIES, TEMPLATES, type TemplateKey } from '../templates/registry.js'
import { problemForSkip } from './problems.js'
import { Message } from './schemas.js'
import './problems.js'

const TAGS = ['messages']
const Uuid = z.string().uuid()
const IdParams = z.object({ id: Uuid })

/** Templates staff may send by key from the composer; system replies, emergency and account messages stay out. */
export const STAFF_SENDABLE: readonly TemplateKey[] = [
  'booking_thanks',
  'confirm_request',
  'confirmed',
  'reminder',
  'welcome',
  'in_progress',
  'ready',
  'reschedule',
  'review',
  'late_nudge',
  'payment_link',
  'addon_approval',
]

const idempotent = (h: ReturnType<typeof idempotentHandler>): never => h as never

const ThreadCustomer = z.object({
  id: z.string(),
  name: z.string(),
  smsOptedIn: z.boolean(),
  optedOut: z.boolean(),
  hasPhone: z.boolean(),
  /** False when a text to this customer would be refused right now (opted out, not opted in, no number). */
  canMessage: z.boolean(),
})

const Thread = z.object({ items: z.array(Message), customer: ThreadCustomer.nullable(), unread: z.number().int() })

const SendBody = z
  .object({
    text: z.string().max(1000).optional(),
    templateKey: z.string().max(64).optional(),
    vars: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  })
  .strict()
  .refine((b) => (b.text !== undefined) !== (b.templateKey !== undefined), { message: 'Send either text or templateKey' })

const SendResult = z.object({
  message: Message,
  queued: z.literal(true),
  held: z.boolean(),
  holdUntil: z.string().nullable(),
  segments: z.number().int(),
})

async function customerFlags(db: Executor, locationId: string, customerId: string): Promise<z.infer<typeof ThreadCustomer> | null> {
  const t = await loadCustomerTarget(db, locationId, customerId)
  if (!t) return null
  const r = t.recipient
  return {
    id: customerId,
    name: t.name,
    smsOptedIn: r.smsOptIn,
    optedOut: r.activeOptOut,
    hasPhone: Boolean(r.phone),
    canMessage: Boolean(r.phone) && r.smsOptIn && !r.activeOptOut,
  }
}

async function markRead(tx: Tx, locationId: string, where: { customerId?: string; appointmentId?: string }, now: Date): Promise<number> {
  let q = tx
    .updateTable('messages')
    .set({ read_at: now })
    .where('location_id', '=', locationId)
    .where('direction', '=', 'in')
    .where('read_at', 'is', null)
  if (where.customerId) q = q.where('customer_id', '=', where.customerId)
  if (where.appointmentId) q = q.where('appointment_id', '=', where.appointmentId)
  const rows = await q.returning(['id', 'customer_id']).execute()
  const customers = [...new Set(rows.map((r) => r.customer_id).filter((x): x is string => x !== null))]
  for (const customerId of customers)
    await sql`update message_threads set unread_count = (
        select count(*) from messages where customer_id = ${customerId} and direction = 'in' and read_at is null)
      where location_id = ${locationId} and customer_id = ${customerId}`.execute(tx)
  if (rows.length > 0)
    await realtime.publish(tx, { locationId, channel: 'ops', type: 'alerts.changed', payload: { source: 'sms', kind: 'read' } })
  return rows.length
}

export function registerThreadRoutes(app: AppInstance, rt: MessagingRuntime): void {
  app.get(
    '/appointments/:id/messages',
    {
      config: { access: access.perm('cli.view') },
      schema: {
        tags: TAGS,
        summary: 'The Messages tab: every text filed under this appointment, oldest first',
        description:
          'Outbound texts the app sent for the appointment and inbound replies attributed to it (a job in progress, else the nearest upcoming booking within 72 hours, else the last completed one within 14 days). `customer.canMessage` is false when a send would be refused. No phone number is returned. `markRead=true` clears the customer\'s unread replies.',
        params: IdParams,
        querystring: z.object({ markRead: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(500).default(200) }),
        response: { 200: Thread },
      },
    },
    async (req) => {
      const locationId = req.auth!.locationId
      const appt = await app.db.selectFrom('appointments').select(['id', 'customer_id']).where('id', '=', req.params.id).where('location_id', '=', locationId).executeTakeFirst()
      if (!appt) throw new AppError('NOT_FOUND')
      if (req.query.markRead && req.auth!.permissions.has('msg.send')) await transaction(app.db, (tx) => markRead(tx, locationId, { appointmentId: appt.id }, app.clock.now()))
      const items = await listThreadMessages(app.db, locationId, { appointmentId: appt.id, limit: req.query.limit })
      const customer = await customerFlags(app.db, locationId, appt.customer_id)
      return { items, customer, unread: items.filter((m) => !m.read).length }
    },
  )

  app.get(
    '/customers/:id/messages',
    {
      config: { access: access.perm('cli.view') },
      schema: {
        tags: TAGS,
        summary: 'A customer\'s whole thread across appointments, oldest first',
        params: IdParams,
        querystring: z.object({ markRead: z.coerce.boolean().default(false), limit: z.coerce.number().int().min(1).max(500).default(200) }),
        response: { 200: Thread },
      },
    },
    async (req) => {
      const locationId = req.auth!.locationId
      const customer = await customerFlags(app.db, locationId, req.params.id)
      if (!customer) throw new AppError('NOT_FOUND')
      if (req.query.markRead && req.auth!.permissions.has('msg.send')) await transaction(app.db, (tx) => markRead(tx, locationId, { customerId: req.params.id }, app.clock.now()))
      const items = await listThreadMessages(app.db, locationId, { customerId: req.params.id, limit: req.query.limit })
      return { items, customer, unread: items.filter((m) => !m.read).length }
    },
  )

  app.post(
    '/customers/:id/messages/read',
    {
      config: { access: access.perm('msg.send') },
      schema: {
        tags: TAGS,
        summary: 'Mark the customer\'s unread replies as read',
        params: IdParams,
        response: { 200: z.object({ marked: z.number().int() }) },
      },
    },
    async (req) => ({
      marked: await transaction(app.db, (tx) => markRead(tx, req.auth!.locationId, { customerId: req.params.id }, app.clock.now())),
    }),
  )

  app.post(
    '/appointments/:id/messages',
    {
      config: { access: access.perm('msg.send'), idempotency: 'required' },
      schema: {
        tags: TAGS,
        summary: 'Send a text to the appointment\'s customer',
        description:
          'Free `text` goes out as an SMS (class staff_message) and a `templateKey` of a quick reply or an automation renders its wording; variables not supplied (`first`, `time`, `when`, `bay`) are filled from the appointment. The text passes the SMS policy: 422 SMS_OPTED_OUT after a STOP, SMS_NOT_OPTED_IN without consent, SMS_NO_PHONE without a number, SMS_TOO_LONG above the segment cap. It is queued, not sent inline; `message.status` events follow on the messages channel.',
        params: IdParams,
        body: SendBody,
        response: { 201: SendResult },
      },
    },
    idempotent(
      idempotentHandler(async (req, tx) => {
        const body = req.body as z.infer<typeof SendBody>
        const locationId = req.auth!.locationId
        const a = await tx
          .selectFrom('appointments')
          .select(['id', 'customer_id', 'scheduled_start', 'bay_id', 'planned_bay_id'])
          .where('id', '=', (req.params as { id: string }).id)
          .where('location_id', '=', locationId)
          .forUpdate()
          .executeTakeFirst()
        if (!a) throw new AppError('NOT_FOUND')
        const target = await loadCustomerTarget(tx, locationId, a.customer_id)
        if (!target) throw new AppError('NOT_FOUND')
        const now = app.clock.now()
        const tz = await locationTz(tx, locationId)
        const actor: Actor = { auth: req.auth!, audit: auditContextOf(req) }

        let text: string | undefined
        let templateKey: string | undefined
        let tag: string | undefined
        let klass: SmsClass = 'staff_message'
        let vars: Record<string, string | number> | undefined
        if (body.text !== undefined) {
          text = body.text
        } else if (body.templateKey !== undefined) {
          const quick = QUICK_REPLIES.find((q) => q.key === body.templateKey)
          if (quick) {
            text = quick.text
            tag = quick.key
            klass = quick.klass
          } else if (isTemplateKey(body.templateKey) && STAFF_SENDABLE.includes(body.templateKey)) {
            templateKey = body.templateKey
            const bayId = a.bay_id ?? a.planned_bay_id
            const bay = bayId ? await tx.selectFrom('bays').select('number').where('id', '=', bayId).executeTakeFirst() : undefined
            vars = {
              first: target.firstName,
              time: formatAppointmentTime(a.scheduled_start, now, tz),
              when: formatWhen(a.scheduled_start, now, tz),
              ...(bay ? { bay: bay.number } : {}),
              ...body.vars,
            }
          } else {
            throw new AppError('SMS_TEMPLATE_INVALID', { params: { detail: `There is no template "${body.templateKey}" you can send` } })
          }
        }

        const out = await rt.queue.enqueueFor(tx, {
          locationId,
          customerId: a.customer_id,
          recipient: target.recipient,
          appointmentId: a.id,
          templateKey,
          text,
          vars,
          klass,
          purpose: 'staff',
          senderKind: 'staff',
          senderEmployeeId: req.auth!.employeeId,
          ...(tag ? { tag } : {}),
        })
        if (!out.queued) {
          if (out.skipped === 'template_error') throw new AppError('SMS_TEMPLATE_INVALID', { params: { detail: out.detail ?? 'The template needs more details' } })
          const p = problemForSkip(out.skipped)
          throw new AppError(p.code, {
            params: { name: target.name, ...p.params, max: rt.config.plan.maxSegments, segments: out.segments ?? '' },
          })
        }
        await tx
          .insertInto('activity_log')
          .values({
            appointment_id: a.id,
            at: now,
            text: 'Staff message sent',
            channels: ['sms'],
            actor_type: 'staff',
            actor_name: actorName(actor),
            meta: JSON.stringify({ messageId: out.messageId }) as never,
          })
          .execute()
        // Answering a customer is reading what they wrote.
        await markRead(tx, locationId, { customerId: a.customer_id }, now)
        const loaded = await loadMessageDto(tx, out.messageId)
        const message: MessageDto = loaded!.dto
        return {
          status: 201,
          body: { message, queued: true, held: out.held, holdUntil: out.holdUntil ? out.holdUntil.toISOString() : null, segments: out.segments },
          headers: { Location: `/api/v1/appointments/${a.id}/messages` },
        }
      }),
    ),
  )

  app.get(
    '/messages/templates',
    {
      config: { access: access.perm('msg.send') },
      schema: {
        tags: TAGS,
        summary: 'Quick replies and the automations (code registry; wording is SMS)',
        response: {
          200: z.object({
            quickReplies: z.array(z.object({ key: z.string(), label: z.string(), text: z.string() })),
            templates: z.array(
              z.object({
                key: z.string(),
                label: z.string(),
                body: z.string(),
                class: z.string(),
                lane: z.number().int(),
                ttlSeconds: z.number().int(),
                transactional: z.boolean(),
                required: z.array(z.string()),
                optional: z.array(z.string()),
                editable: z.boolean(),
                staffSendable: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    async () => ({
      quickReplies: QUICK_REPLIES.map((q) => ({ key: q.key, label: q.label, text: q.text })),
      templates: Object.values(TEMPLATES).map((t) => {
        const spec = classSpec(t.klass)
        return {
          key: t.key,
          label: t.label,
          body: t.body,
          class: t.klass,
          lane: spec.priority,
          ttlSeconds: spec.ttlSec,
          transactional: isTransactional(t.klass),
          required: [...t.required],
          optional: [...t.optional],
          editable: t.editable,
          staffSendable: (STAFF_SENDABLE as readonly string[]).includes(t.key),
        }
      }),
    }),
  )
}
