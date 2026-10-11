import { normalizeE164 } from '../../../integrations/sms/phone.js'
import { GATE_OFF, type AssistantGateVerdict } from '../../assistant/ports.js'
import { formatAppointmentTime } from '../templates/format.js'
import type { TemplateKey } from '../templates/registry.js'
import { attributeInbound, nextUnconfirmed, DEFAULT_ATTRIBUTION, type AppointmentRef, type Attribution, type AttributionConfig } from './attribution.js'
import { parseKeyword, parseReplyCode, type ParsedKeyword } from './keywords.js'
import type { MmsPlaceholder } from './mms.js'

// The inbound router: pure. It looks at one received text and the context the caller loaded (who the sender is, whether the
// number is opted out, their appointments, what the assistant gate said) and returns what should happen, as commands. It performs
// no I/O.
//
// The AI assistant (ADR 0160, design section 3) changes the routing only through `ctx.assistant` (the gate's verdict) and
// `ctx.pendingAction`. Without them (or with the gate off) every text is routed exactly as before. With the gate allowing:
//   - keywords keep priority (STOP, START/YES, HELP, C/CONFIRM, CANCEL), and AGENT is a handoff to staff (no AI);
//   - a digits-only text (4-8 digits) is a reply number when an in-chat action waits for one (`action_code`, checked by the server,
//     never seen by the model), otherwise it is filed as "[code]" with a canned reply pointing to the link page;
//   - any other text (an MMS's text too, never a picture placeholder) goes to the assistant: filed read (no new-reply alert flood)
//     for a client, kept in the inbox for a stranger; non-E.164 senders stay quarantined.

export interface InboundText {
  eventId: string
  deviceId: string
  providerMessageId: string
  /** As reported by the device: E.164, bare digits, or an alphanumeric sender id. */
  from: string
  body: string
  receivedAt: Date
  /** 'mms' when it arrived as MMS. Routing is identical; only the stored message is marked. */
  kind?: 'sms' | 'mms'
  /** Set when an MMS carried no text: `body` is then a placeholder, never a keyword, and staff get a picture-message alert. */
  placeholder?: MmsPlaceholder | null
  /**
   * An MMS delivery without what Oasis needs (MmsContent.incomplete): its provider id carries MMS_INCOMPLETE_SUFFIX, and the
   * complete delivery of the same message supersedes it.
   */
  incomplete?: boolean
  /** The number the text was sent to, as the device reported it (the tablet's own number): the gate never answers it. */
  to?: string
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
  /** The assistant gate's verdict for this text (absent: the assistant is off). */
  assistant?: AssistantGateVerdict
  /** An in-chat action is waiting for its reply number from this phone (only ever true while the assistant is on). */
  pendingAction?: boolean
}

export type StaffAlertKind = 'cancel_request' | 'unattributed_inbound' | 'inbound_message' | 'picture_message' | 'ai_handoff'

export type InboundCommand =
  | { type: 'record_opt_out'; phone: string; keyword: string }
  | { type: 'record_opt_in'; phone: string; keyword: string }
  | { type: 'send_reply'; to: string; template: TemplateKey; vars: Record<string, string> }
  | { type: 'confirm_appointment'; appointmentId: string; customerId: string }
  /** Keep the text in the customer's thread. `unread` raises the unread badge and the SSE event. */
  | { type: 'store_message'; customerId: string; appointmentId: string | null; unread: boolean }
  | { type: 'staff_alert'; kind: Exclude<StaffAlertKind, 'picture_message' | 'ai_handoff'>; customerId: string; appointmentId: string | null; excerpt: string }
  /** An MMS with no text (a picture, or content the device could not download): from anyone, customer or not. */
  | { type: 'staff_alert'; kind: 'picture_message'; customerId: string | null; appointmentId: string | null; excerpt: string; sender: string }
  /** AGENT while the assistant serves the number: a person is asked for (a stranger too). */
  | { type: 'staff_alert'; kind: 'ai_handoff'; customerId: string | null; appointmentId: string | null; excerpt: string; sender: string }
  /** No customer row is created; the text stays in sms_inbox for review. */
  | { type: 'quarantine'; reason: 'unknown_sender' | 'non_e164_sender' }
  /** Hand the text to the AI: the durable marker in the webhook's transaction, then the post-commit kick (ADR 0160). */
  | { type: 'assistant'; phone: string; customerId: string | null }
  /** AGENT: open a handoff on the number's conversation; the AI stays out until staff resolve it. */
  | { type: 'handoff'; phone: string; customerId: string | null; reason: 'agent_keyword' }
  /** A digits-only reply while an in-chat action waits for its reply number: checked by the server, never by the model. */
  | { type: 'action_code'; phone: string; customerId: string | null; code: string }

export type InboundDecisionKind =
  | 'opt_out'
  | 'opt_in'
  | 'help'
  | 'confirm'
  | 'confirm_nothing'
  | 'cancel_request'
  | 'message'
  | 'quarantined'
  /** Handed to the AI assistant. */
  | 'assistant'
  /** AGENT: handed to staff, no AI. */
  | 'handoff'
  /** A reply number for a pending in-chat action. */
  | 'action_code'

export interface InboundDecision {
  kind: InboundDecisionKind
  /** Normalised sender, or null when the sender is not a dialable number. */
  phone: string | null
  commands: InboundCommand[]
  attribution: Attribution | null
  /** The text is a code: it is filed (inbox, thread, webhook log) as CODE_MASK, never readable. */
  redacted?: boolean
}

/** The canned answer to a code texted with no action waiting for one: codes are typed on the link page only. */
export const CODE_REPLY_TEMPLATE = 'code_on_link_page' satisfies TemplateKey

const excerpt = (body: string): string => (body.length > 140 ? `${body.slice(0, 137)}...` : body)

export function routeInbound(msg: InboundText, ctx: InboundContext): InboundDecision {
  const phone = normalizeE164(msg.from)
  // A picture (or an MMS the device could not read) is announced to staff whoever sent it: nobody else will look at the tablet.
  const pictureAlert = (customerId: string | null, appointmentId: string | null): InboundCommand[] =>
    msg.placeholder ? [{ type: 'staff_alert', kind: 'picture_message', customerId, appointmentId, excerpt: excerpt(msg.body), sender: msg.from }] : []
  if (phone === null) {
    // Carrier notices, 2FA codes and spam arrive from short codes and alphanumeric ids. None of it is a customer.
    return { kind: 'quarantined', phone: null, commands: [{ type: 'quarantine', reason: 'non_e164_sender' }, ...pictureAlert(null, null)], attribution: null }
  }

  const customer = ctx.customer
  const keyword: ParsedKeyword = msg.placeholder ? { kind: 'none' } : parseKeyword(msg.body)
  const gate = ctx.assistant ?? GATE_OFF
  const code = msg.placeholder ? null : parseReplyCode(msg.body)
  const attribution = customer ? attributeInbound(ctx.appointments, ctx.now, ctx.attribution ?? DEFAULT_ATTRIBUTION) : null
  const commands: InboundCommand[] = []
  const reply = (template: TemplateKey, vars: Record<string, string> = {}): void => {
    commands.push({ type: 'send_reply', to: phone, template, vars })
  }
  const quietStore = (): void => {
    if (customer) commands.push({ type: 'store_message', customerId: customer.id, appointmentId: attribution?.appointmentId ?? null, unread: false })
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
    commands.push({ type: 'record_opt_in', phone, keyword: keyword.kind === 'opt_in' ? keyword.keyword : 'YES' })
    reply('opt_in_confirm')
    quietStore()
    return decision('opt_in')
  }

  if (keyword.kind === 'help') {
    reply('help_reply', ctx.businessPhone ? { phone: ctx.businessPhone } : {})
    quietStore()
    return decision('help')
  }

  // AGENT asks for a person: a handoff while the assistant serves the number (no AI on it until staff resolve it). With the
  // assistant off it is an ordinary message, as it always was.
  if (keyword.kind === 'agent' && gate.active) {
    const appointmentId = attribution?.appointmentId ?? null
    commands.push({ type: 'handoff', phone, customerId: customer?.id ?? null, reason: 'agent_keyword' })
    if (customer) commands.push({ type: 'store_message', customerId: customer.id, appointmentId, unread: true })
    else commands.push({ type: 'quarantine', reason: 'unknown_sender' })
    commands.push({ type: 'staff_alert', kind: 'ai_handoff', customerId: customer?.id ?? null, appointmentId, excerpt: excerpt(msg.body), sender: msg.from })
    return decision('handoff')
  }

  // A reply number for an in-chat action: the server checks it (the model never sees it) and it is never filed readable.
  if (code !== null && ctx.pendingAction) {
    commands.push({ type: 'action_code', phone, customerId: customer?.id ?? null, code })
    if (customer) commands.push({ type: 'store_message', customerId: customer.id, appointmentId: attribution?.appointmentId ?? null, unread: false })
    else commands.push({ type: 'quarantine', reason: 'unknown_sender' })
    return { ...decision('action_code'), redacted: true }
  }

  // Everything below needs a known customer. Strangers are quarantined, never turned into customers; while the assistant serves
  // them their texts go to it instead (it creates the client, wave 3), a code is answered with the link-page line.
  if (!customer) {
    if (gate.allow && !msg.placeholder) {
      if (code !== null) {
        commands.push({ type: 'quarantine', reason: 'unknown_sender' })
        reply(CODE_REPLY_TEMPLATE)
        return { ...decision('quarantined'), redacted: true }
      }
      commands.push({ type: 'assistant', phone, customerId: null })
      return decision('assistant')
    }
    commands.push({ type: 'quarantine', reason: 'unknown_sender' }, ...pictureAlert(null, null))
    return decision('quarantined')
  }

  const confirmable = nextUnconfirmed(ctx.appointments, ctx.now)
  if (keyword.kind === 'confirm' || (keyword.kind === 'yes' && confirmable !== null)) {
    if (confirmable) {
      commands.push({ type: 'confirm_appointment', appointmentId: confirmable.id, customerId: customer.id })
      reply('confirm_ack', { time: formatAppointmentTime(confirmable.start, ctx.now, ctx.timeZone) })
      commands.push({ type: 'store_message', customerId: customer.id, appointmentId: confirmable.id, unread: false })
      return { kind: 'confirm', phone, commands, attribution: { appointmentId: confirmable.id, basis: 'upcoming' } }
    }
    reply('confirm_none')
    commands.push({ type: 'store_message', customerId: customer.id, appointmentId: attribution?.appointmentId ?? null, unread: true })
    commands.push({ type: 'staff_alert', kind: attribution ? 'inbound_message' : 'unattributed_inbound', customerId: customer.id, appointmentId: attribution?.appointmentId ?? null, excerpt: excerpt(msg.body) })
    return decision('confirm_nothing')
  }

  if (keyword.kind === 'cancel') {
    commands.push({ type: 'store_message', customerId: customer.id, appointmentId: attribution?.appointmentId ?? null, unread: true })
    commands.push({ type: 'staff_alert', kind: 'cancel_request', customerId: customer.id, appointmentId: attribution?.appointmentId ?? null, excerpt: excerpt(msg.body) })
    return decision('cancel_request')
  }

  // The assistant answers plain texts (an MMS's text too, never a picture): filed read, so staff are not alerted for every text the
  // AI handles (they follow it in the thread). A code with nothing waiting for it is filed as "[code]" and answered with a pointer
  // to the link page, never shown to the model.
  if (gate.allow && !msg.placeholder) {
    commands.push({ type: 'store_message', customerId: customer.id, appointmentId: attribution?.appointmentId ?? null, unread: false })
    if (code !== null) {
      reply(CODE_REPLY_TEMPLATE)
      return { ...decision('message'), redacted: true }
    }
    commands.push({ type: 'assistant', phone, customerId: customer.id })
    return decision('assistant')
  }

  // Plain message (including a YES with nothing to confirm): into the thread, unread, with an alert.
  commands.push({ type: 'store_message', customerId: customer.id, appointmentId: attribution?.appointmentId ?? null, unread: true })
  if (msg.placeholder) commands.push(...pictureAlert(customer.id, attribution?.appointmentId ?? null))
  else commands.push({ type: 'staff_alert', kind: attribution ? 'inbound_message' : 'unattributed_inbound', customerId: customer.id, appointmentId: attribution?.appointmentId ?? null, excerpt: excerpt(msg.body) })
  return decision('message')
}
