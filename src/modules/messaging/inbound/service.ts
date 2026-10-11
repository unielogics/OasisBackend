import type { Clock } from '../../../platform/clock.js'
import { MMS_INCOMPLETE_SUFFIX, type MmsPart, type SmsEvent } from '../../../integrations/ports/sms.js'
import { normalizeE164 } from '../../../integrations/sms/phone.js'
import type { OptOutRepository } from '../policy/optouts.js'
import type { CustomerDirectory, InboxRepository, InboxRow } from './repositories.js'
import { mmsText, type MmsAttachmentRecord } from './mms.js'
import { routeInbound, type InboundCommand, type InboundDecision, type InboundText } from './router.js'

type ReceivedEvent = Extract<SmsEvent, { kind: 'received' }>

/** The provider id of the complete delivery of an MMS, whichever form `providerMessageId` is. */
const completeIdOf = (providerMessageId: string): string =>
  providerMessageId.endsWith(MMS_INCOMPLETE_SUFFIX) ? providerMessageId.slice(0, -MMS_INCOMPLETE_SUFFIX.length) : providerMessageId

/** What the host wires to the real system. Each method is one command from the router. */
export interface InboundEffects {
  sendReply(to: string, template: string, vars: Record<string, string>, ctx: { customerId: string | null; inboxId: string }): Promise<void>
  confirmAppointment(appointmentId: string, customerId: string): Promise<void>
  storeMessage(msg: {
    customerId: string
    appointmentId: string | null
    body: string
    unread: boolean
    providerMessageId: string
    receivedAt: Date
    deviceId: string
    kind?: 'sms' | 'mms'
    attachments?: MmsAttachmentRecord[] | null
  }): Promise<void>
  staffAlert(alert: Extract<InboundCommand, { type: 'staff_alert' }>): Promise<void>
  /** Saves the pictures of an MMS and records every part on the inbox row; returns the records (stored keys included). */
  recordAttachments?(parts: readonly MmsPart[], ctx: { inboxId: string; providerMessageId: string; deviceId: string }): Promise<MmsAttachmentRecord[]>
  /**
   * The complete delivery of an MMS arrived after its incomplete placeholder (`stale`, already marked superseded): take the
   * placeholder out of the thread and resolve its alert, so the message is not shown twice.
   */
  supersede?(stale: InboxRow, by: InboxRow): Promise<void>
}

export interface InboundServiceOptions {
  timeZone: string
  businessPhone?: string
}

export type InboundOutcome = { duplicate: true } | { duplicate: false; decision: InboundDecision }

/**
 * Glue around the pure router: record the text in the inbox (deduped), load the context, route, then apply the commands.
 * Opt-outs are persisted here (they are about the number); everything else is delegated to InboundEffects.
 */
export class InboundService {
  constructor(
    private readonly inbox: InboxRepository,
    private readonly optouts: OptOutRepository,
    private readonly directory: CustomerDirectory,
    private readonly effects: InboundEffects,
    private readonly clock: Clock,
    private readonly opts: InboundServiceOptions,
  ) {}

  /** Convenience for SmsEventIngestor: accepts the port's received event. */
  async handleReceived(event: ReceivedEvent): Promise<InboundOutcome> {
    const base = { eventId: event.eventId, deviceId: event.deviceId, providerMessageId: event.providerMessageId, from: event.from, receivedAt: event.at }
    if (!event.mms) return this.process({ ...base, body: event.body })
    // An MMS is routed like an SMS. With no text it is filed under a placeholder, never dropped (ADR 0151).
    const { text, placeholder } = mmsText(event.body, event.mms.parts)
    return this.process({ ...base, body: text, kind: 'mms', placeholder, incomplete: event.mms.incomplete }, event.mms.parts)
  }

  async process(msg: InboundText, parts: readonly MmsPart[] = []): Promise<InboundOutcome> {
    const now = this.clock.now()
    // An MMS can come twice under one device id: first incomplete (its own provider id, filed as a placeholder), then complete.
    // The complete one is routed as usual and supersedes the placeholder; an incomplete one after the complete one is a repeat.
    const completeId = msg.kind === 'mms' ? completeIdOf(msg.providerMessageId) : null
    if (completeId !== null) {
      await this.inbox.lock?.(msg.deviceId, completeId)
      if (msg.incomplete && (await this.inbox.find(msg.deviceId, completeId))) return { duplicate: true }
    }
    const { inserted, row } = await this.inbox.insertIfNew(msg, now)
    if (!inserted) return { duplicate: true }
    if (completeId !== null && !msg.incomplete) {
      const stale = await this.inbox.find(msg.deviceId, `${completeId}${MMS_INCOMPLETE_SUFFIX}`)
      if (stale && stale.supersededBy === null && (await this.inbox.markSuperseded(stale.id, row.id, now))) await this.effects.supersede?.(stale, row)
    }
    const attachments =
      msg.kind === 'mms' && parts.length > 0 && this.effects.recordAttachments
        ? await this.effects.recordAttachments(parts, { inboxId: row.id, providerMessageId: msg.providerMessageId, deviceId: msg.deviceId })
        : null

    // Look the sender up with the same normalisation the router uses.
    const phone = normalizeE164(msg.from)
    const customer = phone ? await this.directory.findByPhone(phone) : null
    const appointments = customer ? await this.directory.listAppointments(customer.id) : []
    const optedOut = phone ? (await this.optouts.findActive(phone)) !== null : false

    const decision = routeInbound(msg, {
      now,
      customer,
      optedOut,
      appointments,
      timeZone: this.opts.timeZone,
      businessPhone: this.opts.businessPhone,
    })

    let quarantined = false
    for (const cmd of decision.commands) {
      switch (cmd.type) {
        case 'record_opt_out':
          await this.optouts.optOut({ phone: cmd.phone, optedOutAt: now, source: 'keyword', keyword: cmd.keyword, inboundMessageId: row.id })
          break
        case 'record_opt_in':
          await this.optouts.optIn(cmd.phone, now)
          break
        case 'send_reply':
          await this.effects.sendReply(cmd.to, cmd.template, cmd.vars, { customerId: customer?.id ?? null, inboxId: row.id })
          break
        case 'confirm_appointment':
          await this.effects.confirmAppointment(cmd.appointmentId, cmd.customerId)
          break
        case 'store_message':
          await this.effects.storeMessage({
            customerId: cmd.customerId,
            appointmentId: cmd.appointmentId,
            body: msg.body,
            unread: cmd.unread,
            providerMessageId: msg.providerMessageId,
            receivedAt: msg.receivedAt,
            deviceId: msg.deviceId,
            ...(msg.kind === 'mms' ? { kind: 'mms' as const, attachments } : {}),
          })
          break
        case 'staff_alert':
          await this.effects.staffAlert(cmd)
          break
        case 'quarantine':
          quarantined = true
          break
      }
    }
    await this.inbox.markProcessed(row.id, decision.kind, quarantined, now)
    return { duplicate: false, decision }
  }
}
