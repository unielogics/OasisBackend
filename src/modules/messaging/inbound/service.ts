import type { Clock } from '../../../platform/clock.js'
import type { SmsEvent } from '../../../integrations/ports/sms.js'
import { normalizeE164 } from '../../../integrations/sms/phone.js'
import type { OptOutRepository } from '../policy/optouts.js'
import type { CustomerDirectory, InboxRepository } from './repositories.js'
import { routeInbound, type InboundCommand, type InboundDecision, type InboundText } from './router.js'

type ReceivedEvent = Extract<SmsEvent, { kind: 'received' }>

/** What the host wires to the real system. Each method is one command from the router. */
export interface InboundEffects {
  sendReply(
    to: string,
    template: string,
    vars: Record<string, string>,
    ctx: { customerId: string | null; inboxId: string },
  ): Promise<void>
  confirmAppointment(appointmentId: string, customerId: string): Promise<void>
  storeMessage(msg: {
    customerId: string
    appointmentId: string | null
    body: string
    unread: boolean
    providerMessageId: string
    receivedAt: Date
    deviceId: string
  }): Promise<void>
  staffAlert(alert: Extract<InboundCommand, { type: 'staff_alert' }>): Promise<void>
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
    return this.process({
      eventId: event.eventId,
      deviceId: event.deviceId,
      providerMessageId: event.providerMessageId,
      from: event.from,
      body: event.body,
      receivedAt: event.at,
    })
  }

  async process(msg: InboundText): Promise<InboundOutcome> {
    const now = this.clock.now()
    const { inserted, row } = await this.inbox.insertIfNew(msg, now)
    if (!inserted) return { duplicate: true }

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
          await this.optouts.optOut({
            phone: cmd.phone,
            optedOutAt: now,
            source: 'keyword',
            keyword: cmd.keyword,
            inboundMessageId: row.id,
          })
          break
        case 'record_opt_in':
          await this.optouts.optIn(cmd.phone, now)
          break
        case 'send_reply':
          await this.effects.sendReply(cmd.to, cmd.template, cmd.vars, {
            customerId: customer?.id ?? null,
            inboxId: row.id,
          })
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
