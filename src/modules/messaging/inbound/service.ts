import type { Clock } from '../../../platform/clock.js'
import { MMS_INCOMPLETE_SUFFIX, type MmsPart, type SmsEvent } from '../../../integrations/ports/sms.js'
import { normalizeE164 } from '../../../integrations/sms/phone.js'
import { GATE_OFF, type AssistantGateInput, type AssistantGateVerdict } from '../../assistant/ports.js'
import type { OptOutRepository } from '../policy/optouts.js'
import type { CustomerDirectory, InboxRepository, InboxRow } from './repositories.js'
import { maskCardNumbers } from './cards.js'
import { CODE_MASK, parseReplyCode } from './keywords.js'
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
  /**
   * The assistant takes the text (ADR 0160): the durable marker on the number's conversation, linked to the inbox row, in the same
   * transaction. Returns the conversation the post-commit kick starts a turn for.
   */
  assistant?(cmd: { phone: string; customerId: string | null; inboxId: string; receivedAt: Date }): Promise<{ conversationId: string }>
  /**
   * The welcome flow (owner, 2026-10-11): a stranger's text the assistant takes. Creates the provisional client (wave 3) in the same
   * transaction and returns it, or null to leave the text with the stranger. Absent: strangers stay strangers until the turn.
   */
  adoptNewTexter?(cmd: { phone: string; inboxId: string; receivedAt: Date }): Promise<{ customerId: string } | null>
  /** AGENT: a handoff on the number's conversation (no AI until staff resolve it). */
  handoff?(cmd: { phone: string; customerId: string | null; inboxId: string; reason: string }): Promise<void>
  /** A reply number for a pending in-chat action (the code itself never leaves this call). */
  actionCode?(cmd: { phone: string; customerId: string | null; inboxId: string; code: string }): Promise<void>
}

/**
 * The assistant's side of routing, bound to the webhook's transaction: the gate's verdict and whether an in-chat action waits for
 * a reply number. Absent: the assistant is off and every text is routed as before.
 */
export interface InboundAssistant {
  gate(input: Omit<AssistantGateInput, 'now' | 'locationId'>): Promise<AssistantGateVerdict>
  hasPendingAction(phone: string): Promise<boolean>
}

export interface InboundServiceOptions {
  timeZone: string
  businessPhone?: string
  assistant?: InboundAssistant
}

export type InboundOutcome =
  /** `redacted`: the first delivery was filed as a code, so this repeat's stored envelope must not keep it readable either. */
  | { duplicate: true; redacted?: boolean }
  | {
      duplicate: false
      decision: InboundDecision
      /** Conversations marked pending for the assistant: the caller kicks their turns once the transaction committed. */
      assistantConversations: string[]
    }

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
  async handleReceived(event: ReceivedEvent, extra: { to?: string } = {}): Promise<InboundOutcome> {
    const base = {
      eventId: event.eventId,
      deviceId: event.deviceId,
      providerMessageId: event.providerMessageId,
      from: event.from,
      receivedAt: event.at,
      ...(extra.to ? { to: extra.to } : {}),
    }
    if (!event.mms) return this.process({ ...base, body: event.body })
    // An MMS is routed like an SMS. With no text it is filed under a placeholder, never dropped (ADR 0151).
    const { text, placeholder } = mmsText(event.body, event.mms.parts)
    return this.process({ ...base, body: text, kind: 'mms', placeholder, incomplete: event.mms.incomplete }, event.mms.parts)
  }

  async process(input: InboundText, parts: readonly MmsPart[] = []): Promise<InboundOutcome> {
    const now = this.clock.now()
    // a card number is never filed readable (ADR 0160 W4b X6): the inbox row, the thread, the event stream, alerts and the assistant
    // all get "[card ending 1234]" (last four digits only), like a code gets CODE_MASK
    const msg: InboundText = { ...input, body: maskCardNumbers(input.body) }
    // An MMS can come twice under one device id: first incomplete (its own provider id, filed as a placeholder), then complete.
    // The complete one is routed as usual and supersedes the placeholder; an incomplete one after the complete one is a repeat.
    const completeId = msg.kind === 'mms' ? completeIdOf(msg.providerMessageId) : null
    if (completeId !== null) {
      await this.inbox.lock?.(msg.deviceId, completeId)
      const complete = msg.incomplete ? await this.inbox.find(msg.deviceId, completeId) : null
      if (complete) return complete.body === CODE_MASK ? { duplicate: true, redacted: true } : { duplicate: true }
    }
    const { inserted, row } = await this.inbox.insertIfNew(msg, now)
    if (!inserted) return row.body === CODE_MASK ? { duplicate: true, redacted: true } : { duplicate: true }
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

    // The assistant gate (off unless the host wired one and every switch is on) and, for a digits-only text, whether an in-chat
    // action waits for its reply number. With neither the routing is exactly what it was before the assistant.
    const assistant = this.opts.assistant
    const verdict: AssistantGateVerdict = assistant
      ? await assistant.gate({ from: msg.from, phone, customerId: customer?.id ?? null, optedOut, body: msg.body, ...(msg.to ? { to: msg.to } : {}) })
      : GATE_OFF
    const pendingAction = assistant && phone && !msg.placeholder && parseReplyCode(msg.body) !== null ? await assistant.hasPendingAction(phone) : false

    const decision = routeInbound(msg, {
      now,
      customer,
      optedOut,
      appointments,
      timeZone: this.opts.timeZone,
      businessPhone: this.opts.businessPhone,
      ...(assistant ? { assistant: verdict, pendingAction } : {}),
    })
    // a code is never filed readable: the inbox row, the thread and the event stream get the mask
    const body = decision.redacted ? CODE_MASK : msg.body
    if (decision.redacted) await this.inbox.redact?.(row.id, CODE_MASK)
    const assistantConversations: string[] = []

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
            body,
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
        case 'assistant': {
          if (!this.effects.assistant) throw new Error('inbound: the assistant gate allowed a text but no assistant effect is wired')
          let customerId = cmd.customerId
          // a first text from a number with no client: the welcome flow may create the provisional client right here, so the text
          // is in that client's thread from the start (read: the AI answers it)
          if (customerId === null && this.effects.adoptNewTexter) {
            const adopted = await this.effects.adoptNewTexter({ phone: cmd.phone, inboxId: row.id, receivedAt: now })
            if (adopted) {
              customerId = adopted.customerId
              await this.effects.storeMessage({
                customerId,
                appointmentId: null,
                body,
                unread: false,
                providerMessageId: msg.providerMessageId,
                receivedAt: msg.receivedAt,
                deviceId: msg.deviceId,
                ...(msg.kind === 'mms' ? { kind: 'mms' as const, attachments } : {}),
              })
            }
          }
          const { conversationId } = await this.effects.assistant({ phone: cmd.phone, customerId, inboxId: row.id, receivedAt: now })
          assistantConversations.push(conversationId)
          break
        }
        case 'handoff':
          await this.effects.handoff?.({ phone: cmd.phone, customerId: cmd.customerId, inboxId: row.id, reason: cmd.reason })
          break
        case 'action_code':
          await this.effects.actionCode?.({ phone: cmd.phone, customerId: cmd.customerId, inboxId: row.id, code: cmd.code })
          break
      }
    }
    await this.inbox.markProcessed(row.id, decision.kind, quarantined, now)
    return { duplicate: false, decision, assistantConversations }
  }
}
