import { normalizeE164 } from '../../../integrations/sms/phone.js'
import { formatAppointmentTime } from '../templates/format.js'
import type { TemplateKey } from '../templates/registry.js'
import {
  attributeInbound,
  nextUnconfirmed,
  DEFAULT_ATTRIBUTION,
  type AppointmentRef,
  type Attribution,
  type AttributionConfig,
} from './attribution.js'
import { parseKeyword } from './keywords.js'

// The inbound router: pure. It looks at one received text and the context the caller loaded (who the sender is, whether the
// number is opted out, their appointments) and returns what should happen, as commands. It performs no I/O.

export interface InboundText {
  eventId: string
  deviceId: string
  providerMessageId: string
  /** As reported by the device: E.164, bare digits, or an alphanumeric sender id. */
  from: string
  body: string
  receivedAt: Date
}

export interface InboundContext {
  now: Date
  /** The customer whose phone matches, or null for an unknown sender. */
  customer: { id: string; firstName?: string } | null
  /** An active opt-out exists for the sender's number. */
  optedOut: boolean
  /** The customer's appointments (any status); empty for an unknown sender. */
  appointments: readonly AppointmentRef[]
  timeZone: string
  /** The shop's public phone, shown in the HELP reply when known. */
  businessPhone?: string
  attribution?: AttributionConfig
}

export type StaffAlertKind = 'cancel_request' | 'unattributed_inbound' | 'inbound_message'

export type InboundCommand =
  | { type: 'record_opt_out'; phone: string; keyword: string }
  | { type: 'record_opt_in'; phone: string; keyword: string }
  | { type: 'send_reply'; to: string; template: TemplateKey; vars: Record<string, string> }
  | { type: 'confirm_appointment'; appointmentId: string; customerId: string }
  /** Keep the text in the customer's thread. `unread` raises the unread badge and the SSE event. */
  | { type: 'store_message'; customerId: string; appointmentId: string | null; unread: boolean }
  | {
      type: 'staff_alert'
      kind: StaffAlertKind
      customerId: string
      appointmentId: string | null
      excerpt: string
    }
  /** No customer row is created; the text stays in sms_inbox for review. */
  | { type: 'quarantine'; reason: 'unknown_sender' | 'non_e164_sender' }

export type InboundDecisionKind =
  'opt_out' | 'opt_in' | 'help' | 'confirm' | 'confirm_nothing' | 'cancel_request' | 'message' | 'quarantined'

export interface InboundDecision {
  kind: InboundDecisionKind
  /** Normalised sender, or null when the sender is not a dialable number. */
  phone: string | null
  commands: InboundCommand[]
  attribution: Attribution | null
}

const excerpt = (body: string): string => (body.length > 140 ? `${body.slice(0, 137)}...` : body)

export function routeInbound(msg: InboundText, ctx: InboundContext): InboundDecision {
  const phone = normalizeE164(msg.from)
  if (phone === null) {
    // Carrier notices, 2FA codes and spam arrive from short codes and alphanumeric ids. None of it is a customer.
    return {
      kind: 'quarantined',
      phone: null,
      commands: [{ type: 'quarantine', reason: 'non_e164_sender' }],
      attribution: null,
    }
  }

  const customer = ctx.customer
  const keyword = parseKeyword(msg.body)
  const attribution = customer
    ? attributeInbound(ctx.appointments, ctx.now, ctx.attribution ?? DEFAULT_ATTRIBUTION)
    : null
  const commands: InboundCommand[] = []
  const reply = (template: TemplateKey, vars: Record<string, string> = {}): void => {
    commands.push({ type: 'send_reply', to: phone, template, vars })
  }
  const quietStore = (): void => {
    if (customer)
      commands.push({
        type: 'store_message',
        customerId: customer.id,
        appointmentId: attribution?.appointmentId ?? null,
        unread: false,
      })
    else commands.push({ type: 'quarantine', reason: 'unknown_sender' })
  }
  const decision = (kind: InboundDecisionKind): InboundDecision => ({ kind, phone, commands, attribution })

  // Opt-out and opt-in are about the number, not the customer, so they work for strangers too.
  if (keyword.kind === 'opt_out') {
    commands.push({ type: 'record_opt_out', phone, keyword: keyword.keyword })
    if (!ctx.optedOut) reply('opt_out_confirm')
    quietStore()
    return decision('opt_out')
  }

  const optBackIn = keyword.kind === 'opt_in' || (keyword.kind === 'yes' && ctx.optedOut)
  if (optBackIn) {
    commands.push({
      type: 'record_opt_in',
      phone,
      keyword: keyword.kind === 'opt_in' ? keyword.keyword : 'YES',
    })
    reply('opt_in_confirm')
    quietStore()
    return decision('opt_in')
  }

  if (keyword.kind === 'help') {
    reply('help_reply', ctx.businessPhone ? { phone: ctx.businessPhone } : {})
    quietStore()
    return decision('help')
  }

  // Everything below needs a known customer. Strangers are quarantined, never turned into customers.
  if (!customer) {
    commands.push({ type: 'quarantine', reason: 'unknown_sender' })
    return decision('quarantined')
  }

  const confirmable = nextUnconfirmed(ctx.appointments, ctx.now)
  if (keyword.kind === 'confirm' || (keyword.kind === 'yes' && confirmable !== null)) {
    if (confirmable) {
      commands.push({ type: 'confirm_appointment', appointmentId: confirmable.id, customerId: customer.id })
      reply('confirm_ack', { time: formatAppointmentTime(confirmable.start, ctx.now, ctx.timeZone) })
      commands.push({
        type: 'store_message',
        customerId: customer.id,
        appointmentId: confirmable.id,
        unread: false,
      })
      return {
        kind: 'confirm',
        phone,
        commands,
        attribution: { appointmentId: confirmable.id, basis: 'upcoming' },
      }
    }
    reply('confirm_none')
    commands.push({
      type: 'store_message',
      customerId: customer.id,
      appointmentId: attribution?.appointmentId ?? null,
      unread: true,
    })
    commands.push({
      type: 'staff_alert',
      kind: attribution ? 'inbound_message' : 'unattributed_inbound',
      customerId: customer.id,
      appointmentId: attribution?.appointmentId ?? null,
      excerpt: excerpt(msg.body),
    })
    return decision('confirm_nothing')
  }

  if (keyword.kind === 'cancel') {
    commands.push({
      type: 'store_message',
      customerId: customer.id,
      appointmentId: attribution?.appointmentId ?? null,
      unread: true,
    })
    commands.push({
      type: 'staff_alert',
      kind: 'cancel_request',
      customerId: customer.id,
      appointmentId: attribution?.appointmentId ?? null,
      excerpt: excerpt(msg.body),
    })
    return decision('cancel_request')
  }

  // Plain message (including a YES with nothing to confirm): into the thread, unread, with an alert.
  commands.push({
    type: 'store_message',
    customerId: customer.id,
    appointmentId: attribution?.appointmentId ?? null,
    unread: true,
  })
  commands.push({
    type: 'staff_alert',
    kind: attribution ? 'inbound_message' : 'unattributed_inbound',
    customerId: customer.id,
    appointmentId: attribution?.appointmentId ?? null,
    excerpt: excerpt(msg.body),
  })
  return decision('message')
}
