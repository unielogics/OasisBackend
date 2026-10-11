// DbMessageQueue: the outbound queue the rest of the app uses. enqueue() runs in the CALLER's transaction: it renders the
// template (or takes free text), passes the single SMS policy gate, counts segments after GSM-7 normalisation, and writes
// the message, its outbox row and the thread, then publishes message.out. Nothing is sent inline; a dispatcher drains
// sms_outbox. A booking that rolls back takes its confirmation text with it.
import type { SmsPriority } from '../../integrations/ports/sms.js'
import type { Executor, Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import type { Clock } from '../../platform/clock.js'
import type { MessageQueue, OutboundMessage, QueuedResult } from '../scheduling/ports.js'
import { findCustomerByPhone } from '../customers/service.js'
import { noteStaffTakeover } from './assistant/inbox.js'
import type { MessagingConfig } from './config.js'
import { hasActiveOptOut, lastInboundAt, loadCustomerTarget, type CustomerTarget } from './db/recipients.js'
import { PgOutboxRepository, rowValues } from './db/outbox-repo.js'
import { ensureThread, loadMessageDto, publishMessage, REDACTED_BODY, SENSITIVE_CLASSES, touchThread } from './db/messages.js'
import { planEnqueue } from './dispatch/enqueue.js'
import type { SmsDenyReason, SmsRecipient } from './policy/canSend.js'
import { isSmsClass, replyContextOf, type SmsClass } from './policy/classes.js'
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
  /** 'ai': written by the AI assistant (the thread shows "Oasis AI"; ADR 0160). */
  senderKind: 'staff' | 'system' | 'ai'
  senderEmployeeId?: string | null
  /**
   * Values that must not be stored readable (a personal link, a reply number): they fill the template's (or the free text's)
   * {name} placeholders in the text that is sent (the outbox), and appear masked in the message row and the event stream
   * ("[private link]" for a URL, "[code]" otherwise). Only for the classes whose outbox body is wiped once final (SENSITIVE_CLASSES).
   */
  secretVars?: Record<string, string>
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
    const secrets = Object.entries(a.secretVars ?? {})
    if (a.templateKey) {
      try {
        const r = renderTemplate(a.templateKey, { ...a.vars, ...a.secretVars }, { linksEnabled: config.linksEnabled })
        text = r.text
        klass = r.klass
      } catch (e) {
        if (!(e instanceof TemplateError)) throw e
        this.d.warn?.('message template could not be rendered', { template: a.templateKey, code: e.code, details: e.details })
        return { queued: false, skipped: 'template_error', detail: e.message }
      }
    } else {
      text = a.text ?? ''
      for (const [name, value] of secrets) text = text.replaceAll(`{${name}}`, value)
      klass = a.klass && isSmsClass(a.klass) ? a.klass : 'staff_message'
    }
    // a secret in a class whose outbox body is never wiped would sit readable in sms_outbox: a caller's bug, never sent
    if (secrets.length > 0 && !SENSITIVE_CLASSES.has(klass))
      throw new Error(`secretVars need a class whose outbox body is wiped (${[...SENSITIVE_CLASSES].join(', ')}), not ${klass}`)

    // The classes that answer a text from that number (the AI's answers, action confirmations, personal links, lead follow-ups) are
    // consent-exempt as replies, so what decides them is read here, never taken from the caller: when the number last texted, and
    // whether it opted out (sms_opt_outs by number, the client's own opt-out). A STOP is refused at enqueue, not only at dispatch.
    let recipient = a.recipient
    if (replyContextOf(klass) !== null) {
      const phone = recipient.phone
      // the client's own opt-out: by id, or, with no id (a reply to a number), by the number, so a client-level opt-out with no
      // sms_opt_outs row still refuses
      const client = a.customerId
        ? await tx.selectFrom('customers').select('sms_opted_out_at').where('id', '=', a.customerId).executeTakeFirst()
        : phone
          ? await findCustomerByPhone(tx, phone).then((c) => (c ? { sms_opted_out_at: c.smsOptedOutAt } : undefined))
          : undefined
      const clientOptedOut = !!client?.sms_opted_out_at
      recipient = {
        ...recipient,
        lastInboundAt: phone ? await lastInboundAt(tx, a.locationId, phone) : null,
        activeOptOut: recipient.activeOptOut || clientOptedOut || (phone ? await hasActiveOptOut(tx, a.locationId, phone) : false),
      }
    }

    const id = newId()
    const now = clock.now()
    const outbox = new PgOutboxRepository(tx, { deviceId: null })
    const plan = await planEnqueue(
      { messageId: id, recipient, klass, text, priority: a.priority, ttlOverrideSec: a.ttlOverrideSec },
      { now, cfg: config.plan, hasPriorOutbound: (phone) => outbox.hasPriorOutbound(phone) },
    )
    if (plan.status === 'suppressed') return { queued: false, skipped: plan.reason }
    if (plan.status === 'rejected') return { queued: false, skipped: plan.reason, ...(plan.segments !== undefined ? { segments: plan.segments } : {}) }
    const { item } = plan
    const storedBody = !SENSITIVE_CLASSES.has(klass) ? item.body : secrets.length > 0 ? maskSecrets(item.body, secrets) : REDACTED_BODY
    const publishable = !SENSITIVE_CLASSES.has(klass) || storedBody !== REDACTED_BODY

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
        body: storedBody,
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
    // A staff text on a thread takes it over from the AI (ADR 0160): paused for assistant.staff_pause_hours, an open handoff resolved.
    if (threadId && a.customerId && a.senderKind === 'staff')
      await noteStaffTakeover(tx, { locationId: a.locationId, threadId, customerId: a.customerId, phone: item.toE164, employeeId: a.senderEmployeeId ?? null, now })
    const loaded = await loadMessageDto(tx, id)
    if (loaded && publishable) await publishMessage(tx, a.locationId, 'message.out', loaded.dto)
    return { queued: true, messageId: id, held: plan.holdUntil !== null, holdUntil: plan.holdUntil, segments: item.segments, body: item.body, duplicate: false }
  }

  /** The customer as the policy sees them; null when the id is unknown. */
  target(db: Executor, locationId: string, customerId: string): Promise<CustomerTarget | null> {
    return loadCustomerTarget(db, locationId, customerId)
  }
}

/**
 * The sent text with every secret value replaced by its mask; the whole body is redacted instead when a value cannot be found in
 * it (GSM-7 normalisation changed it), so a secret can never survive in the stored copy.
 */
export function maskSecrets(body: string, secrets: [string, string][]): string {
  let masked = body
  for (const [, value] of [...secrets].sort((x, y) => y[1].length - x[1].length)) {
    if (value.length === 0) continue
    if (!masked.includes(value)) return REDACTED_BODY
    masked = masked.replaceAll(value, /^https?:\/\//i.test(value) ? '[private link]' : '[code]')
  }
  return masked
}
