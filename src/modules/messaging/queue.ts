// DbMessageQueue: the outbound queue the rest of the app uses. enqueue() runs in the CALLER's transaction: it renders the
// template (or takes free text), passes the single SMS policy gate, counts segments after GSM-7 normalisation, and writes
// the message, its outbox row and the thread, then publishes message.out. Nothing is sent inline; a dispatcher drains
// sms_outbox. A booking that rolls back takes its confirmation text with it.
import type { SmsPriority } from '../../integrations/ports/sms.js'
import type { Executor, Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import type { Clock } from '../../platform/clock.js'
import type { MessageQueue, OutboundMessage, QueuedResult } from '../scheduling/ports.js'
import type { MessagingConfig } from './config.js'
import { loadCustomerTarget, type CustomerTarget } from './db/recipients.js'
import { PgOutboxRepository, rowValues } from './db/outbox-repo.js'
import { ensureThread, loadMessageDto, publishMessage, REDACTED_BODY, SENSITIVE_CLASSES, touchThread } from './db/messages.js'
import { planEnqueue } from './dispatch/enqueue.js'
import type { SmsDenyReason, SmsRecipient } from './policy/canSend.js'
import { isSmsClass, type SmsClass } from './policy/classes.js'
import { renderTemplate, TemplateError, type TemplateVars } from './templates/render.js'

export interface EnqueueArgs {
  locationId: string
  customerId: string | null
  employeeId?: string | null
  recipient: SmsRecipient
  appointmentId: string | null
  templateKey?: string
  text?: string
  vars?: TemplateVars
  klass?: SmsClass
  purpose: string
  senderKind: 'staff' | 'system'
  senderEmployeeId?: string | null
  /** A second enqueue with the same key returns the first message instead of creating another. */
  dedupeKey?: string
  /** Recorded as the message's template_key when the text is free (a quick reply's key). */
  tag?: string
  priority?: SmsPriority
  ttlOverrideSec?: number
}

export type SkipReason = SmsDenyReason | 'too_long' | 'empty' | 'template_error' | 'no_customer'

export type EnqueueOutcome =
  | {
      queued: true
      messageId: string
      held: boolean
      holdUntil: Date | null
      segments: number
      body: string
      /** True when dedupeKey matched an earlier message. */
      duplicate: boolean
    }
  | { queued: false; skipped: SkipReason; detail?: string; segments?: number }

export interface QueueDeps {
  clock: Clock
  newId: NewId
  config: MessagingConfig
  /** Reports a template that could not render (a missing variable is a bug, never a reason to fail the caller). */
  warn?: (msg: string, detail: Record<string, unknown>) => void
}

export class DbMessageQueue implements MessageQueue {
  constructor(private readonly d: QueueDeps) {}

  /** The scheduling MessageQueue port. */
  async enqueue(tx: Tx, msg: OutboundMessage): Promise<QueuedResult> {
    const location = await this.defaultLocation(tx)
    if (!location) return { queued: false, messageId: null, skipped: 'no_customer' }
    const target = await loadCustomerTarget(tx, location, msg.customerId)
    if (!target) return { queued: false, messageId: null, skipped: 'no_customer' }
    const staffTyped = msg.klass === 'staff_message' || msg.klass === 'quick_reply'
    const out = await this.enqueueFor(tx, {
      locationId: location,
      customerId: msg.customerId,
      recipient: target.recipient,
      appointmentId: msg.appointmentId,
      templateKey: msg.templateKey,
      text: msg.text,
      vars: msg.vars,
      klass: msg.klass,
      purpose: msg.purpose,
      senderKind: staffTyped ? 'staff' : 'system',
      dedupeKey: msg.dedupeKey,
    })
    return out.queued ? { queued: true, messageId: out.messageId } : { queued: false, messageId: null, skipped: out.skipped }
  }

  /** Customers are brand-global; the deployment's single location owns the thread. */
  private async defaultLocation(db: Executor): Promise<string | null> {
    const r = await db.selectFrom('locations').select('id').orderBy('created_at').orderBy('id').limit(1).executeTakeFirst()
    return r?.id ?? null
  }

  async enqueueFor(tx: Tx, a: EnqueueArgs): Promise<EnqueueOutcome> {
    const { clock, newId, config } = this.d
    if (a.dedupeKey) {
      const prior = await tx.selectFrom('messages').select('id').where('idempotency_key', '=', a.dedupeKey).executeTakeFirst()
      if (prior) return { queued: true, messageId: prior.id, held: false, holdUntil: null, segments: 1, body: '', duplicate: true }
    }

    let text: string
    let klass: SmsClass
    if (a.templateKey) {
      try {
        const r = renderTemplate(a.templateKey, a.vars ?? {}, { linksEnabled: config.linksEnabled })
        text = r.text
        klass = r.klass
      } catch (e) {
        if (!(e instanceof TemplateError)) throw e
        this.d.warn?.('message template could not be rendered', { template: a.templateKey, code: e.code, details: e.details })
        return { queued: false, skipped: 'template_error', detail: e.message }
      }
    } else {
      text = a.text ?? ''
      klass = a.klass && isSmsClass(a.klass) ? a.klass : 'staff_message'
    }

    const id = newId()
    const now = clock.now()
    const outbox = new PgOutboxRepository(tx, { deviceId: null })
    const plan = await planEnqueue(
      { messageId: id, recipient: a.recipient, klass, text, priority: a.priority, ttlOverrideSec: a.ttlOverrideSec },
      { now, cfg: config.plan, hasPriorOutbound: (phone) => outbox.hasPriorOutbound(phone) },
    )
    if (plan.status === 'suppressed') return { queued: false, skipped: plan.reason }
    if (plan.status === 'rejected') return { queued: false, skipped: plan.reason, ...(plan.segments !== undefined ? { segments: plan.segments } : {}) }
    const { item } = plan

    const threadId = a.customerId ? await ensureThread(tx, { locationId: a.locationId, customerId: a.customerId, newId }) : null
    const inserted = await tx
      .insertInto('messages')
      .values({
        id,
        location_id: a.locationId,
        thread_id: threadId,
        customer_id: a.customerId,
        employee_id: a.employeeId ?? null,
        appointment_id: a.appointmentId,
        direction: 'out',
        sender_kind: a.senderKind,
        sender_employee_id: a.senderKind === 'staff' ? (a.senderEmployeeId ?? null) : null,
        channel: 'sms',
        body: SENSITIVE_CLASSES.has(klass) ? REDACTED_BODY : item.body,
        template_key: a.templateKey ?? a.tag ?? null,
        purpose: a.purpose,
        klass,
        status: 'queued',
        peer_e164: item.toE164,
        segments: item.segments,
        encoding: item.encoding,
        idempotency_key: a.dedupeKey ?? null,
        queued_at: now,
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .returning('id')
      .executeTakeFirst()
    if (!inserted) {
      const prior = await tx.selectFrom('messages').select('id').where('idempotency_key', '=', a.dedupeKey ?? '').executeTakeFirstOrThrow()
      return { queued: true, messageId: prior.id, held: false, holdUntil: null, segments: item.segments, body: item.body, duplicate: true }
    }
    await tx.insertInto('sms_outbox').values(rowValues(item) as never).execute()
    if (threadId) await touchThread(tx, threadId, now)
    const loaded = await loadMessageDto(tx, id)
    if (loaded && !SENSITIVE_CLASSES.has(klass)) await publishMessage(tx, a.locationId, 'message.out', loaded.dto)
    return { queued: true, messageId: id, held: plan.holdUntil !== null, holdUntil: plan.holdUntil, segments: item.segments, body: item.body, duplicate: false }
  }

  /** The customer as the policy sees them; null when the id is unknown. */
  target(db: Executor, locationId: string, customerId: string): Promise<CustomerTarget | null> {
    return loadCustomerTarget(db, locationId, customerId)
  }
}

