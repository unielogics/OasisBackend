// The ports the messaging core calls for the AI text assistant (ADR 0160, design section 3). The messaging module owns the inbound
// path (webhook -> router -> effects) and the outbound queue; the assistant module (wave 3) owns the turn. These interfaces are the
// seam between them:
//
//   AssistantGate      may the AI answer this text? (switches, stage, number, opt-out, staff pause, handoff, loop breakers)
//   AssistantInbox     the durable marker written in the webhook's transaction (assistant_conversations.pending_since) and the
//                      handoff a customer asks for with AGENT
//   AssistantKick      after the webhook's transaction commits: start the turn (wave 3: pg-boss `ai.respond`, debounced)
//   ActionCodeHandler  a digits-only reply while an in-chat action waits for its reply number (wave 3 checks and executes it)
//   NewTexters         the welcome flow's first step (owner, 2026-10-11): a text the gate admits from a number with no client
//                      creates the provisional client + lead in the webhook's transaction, so the thread exists from the start
//
// Everything defaults to OFF: with the defaults below (and with the real gate while AI_ENABLED=false or assistant.enabled=false)
// every inbound text is routed exactly as before the assistant existed. The messaging module's Postgres implementations are in
// src/modules/messaging/assistant/*; wave 3 supplies the kick and the action-code handler through MessagingRuntime.useAssistant().
import type { Executor, Tx } from '../../platform/db.js'

/** Why the gate said no (logged and tested; never shown to the texter). */
export type AssistantGateReason =
  /** AI_ENABLED=false (environment kill switch). */
  | 'ai_disabled'
  /** Settings assistant.enabled=false. */
  | 'assistant_disabled'
  /** The number is not in the current stage (allowlist: not listed; customers: no client behind it, or a stale record). */
  | 'not_in_stage'
  /** Not a US/CA mobile number (normalizeTextableNanp): international, toll-free, premium, landline, short code, alphanumeric. */
  | 'not_textable'
  /** One of the shop's own numbers (the texting tablet, BUSINESS_PHONE): never talk to ourselves. */
  | 'own_number'
  /** The number or its client opted out. */
  | 'opted_out'
  /** A staff member replied on the thread: the AI is paused until message_threads.ai_paused_until. */
  | 'thread_paused'
  /** The conversation is handed to staff (AGENT, a failure, the model's handoff) and not resolved yet. */
  | 'handoff_open'
  /** Loop breakers (pure helpers, src/modules/messaging/assistant/loop-breakers.ts). */
  | 'loop_identical'
  | 'loop_burst'
  | 'loop_sender'

export interface AssistantGateInput {
  locationId: string
  /** The sender as the device reported it (E.164, digits, a short code or an alphanumeric id). */
  from: string
  /** normalizeE164(from), or null when it is not a dialable number. */
  phone: string | null
  /** The client the number belongs to, or null for a stranger. */
  customerId: string | null
  /** An active opt-out of the number (sms_opt_outs), as the inbound service loaded it. */
  optedOut: boolean
  /** The text as filed (an MMS's text, never its placeholder). */
  body: string
  /** The number the text was sent to, when the device reported it (the tablet's own number). */
  to?: string
  now: Date
}

/**
 * `active`: the AI serves this number at all (switches on, number in the stage, a textable mobile, not opted out): AGENT is a
 * handoff only then. `allow`: active and nothing holds it back now (staff pause, open handoff, loop breakers): plain texts go to
 * the assistant only then. `reason` names the first check that failed (null when allowed).
 */
export interface AssistantGateVerdict {
  active: boolean
  allow: boolean
  reason: AssistantGateReason | null
}

export const GATE_OFF: AssistantGateVerdict = Object.freeze({ active: false, allow: false, reason: 'ai_disabled' as const })

export interface AssistantGate {
  evaluate(db: Executor, input: AssistantGateInput): Promise<AssistantGateVerdict>
}

/** The default gate: the assistant never answers. */
export const assistantOff: AssistantGate = { evaluate: async () => GATE_OFF }

export interface PendingMarkInput {
  locationId: string
  phone: string
  customerId: string | null
  /** The sms_inbox row of the text (linked to the conversation). */
  inboxId: string
  /** When the shop received the text (the server's clock). */
  receivedAt: Date
}

export interface HandoffInput {
  locationId: string
  phone: string
  customerId: string | null
  inboxId: string
  /** 'agent_keyword' for AGENT; wave 3 adds its own (fallback, output guard, the model's handoff_to_staff). */
  reason: string
  at: Date
}

/** The conversation side of the inbound path, inside the webhook's transaction. */
export interface AssistantInbox {
  /**
   * Upserts the (location, phone) conversation: pending_since (kept when already set, so a burst keeps its oldest text),
   * last_inbound_at, customer_id (when known); links sms_inbox.assistant_conversation_id. Returns the conversation to kick.
   */
  markPending(tx: Tx, input: PendingMarkInput): Promise<{ conversationId: string }>
  /** Opens a handoff on the (location, phone) conversation (no AI until staff resolve it) and links the inbox row. */
  openHandoff(tx: Tx, input: HandoffInput): Promise<{ conversationId: string; alreadyOpen: boolean }>
}

/** Called once the webhook's transaction committed, with the conversations it marked pending. Must not throw for a busy queue. */
export interface AssistantKick {
  kick(conversationIds: readonly string[]): Promise<void>
}

/** Default: nothing starts a turn (wave 3's `ai.sweep` would pick the markers up anyway). */
export const noKick: AssistantKick = { kick: async () => undefined }

export interface ActionCodeInput {
  locationId: string
  phone: string
  customerId: string | null
  /** The digits the client texted. Never logged, never stored readable, never shown to the model. */
  code: string
  inboxId: string
  at: Date
}

/** A digits-only reply (4-8 digits) to "... Reply NNNN to confirm" (design section 3; the model never sees the number). */
export interface ActionCodeHandler {
  /** True when an in-chat action is waiting for its reply number from this phone (state pending, not expired). */
  hasPending(db: Executor, q: { locationId: string; phone: string; now: Date }): Promise<boolean>
  /** Checks the code against the pending action and executes or counts the attempt. Inside the webhook's transaction. */
  handle(tx: Tx, input: ActionCodeInput): Promise<void>
}

/** Default: no action is ever pending (nothing creates one until wave 3). */
export const noActionCodes: ActionCodeHandler = { hasPending: async () => false, handle: async () => undefined }

export interface NewTexterInput {
  locationId: string
  /** The sender, a US/CA mobile number (the gate admitted it), E.164. */
  phone: string
  /** The sms_inbox row of the text (the conversation is marked right after). */
  inboxId: string
  /** When the shop received the text (the server's clock). */
  receivedAt: Date
}

/**
 * The welcome flow's first step (design sections 0 and 3, owner 2026-10-11): the FIRST text the gate admits from a number with no
 * client. Called inside the webhook's transaction, before the marker is written. Wave 3 creates the provisional client (source
 * inbound_sms, consent inbound_text, needs_details, name "New texter ••NNNN") and opens the lead, idempotently per phone, and returns
 * it: the messaging core then files the text into that client's thread (read: the AI answers it) and marks the conversation with the
 * client. Returning null leaves the text with the stranger (inbox only; the turn's claim may still create the client and pick up
 * the inbox rows linked to the conversation). Never called for keywords, codes, AGENT or picture-only texts.
 */
export interface NewTexters {
  /**
   * The client the text is filed under, null when nothing was adopted (the assistant is off: routing goes on as before), or
   * `{ refused: 'ceiling' }` when the hourly ceiling of new provisional clients is reached: the text is stored for staff without a
   * client and the assistant does not answer it.
   */
  adopt(tx: Tx, input: NewTexterInput): Promise<{ customerId: string } | { refused: 'ceiling' } | null>
}

/** Default: no client is created here (until wave 3 wires the welcome flow). */
export const noNewTexters: NewTexters = { adopt: async () => null }

export interface AssistantPorts {
  gate: AssistantGate
  inbox: AssistantInbox | null
  kick: AssistantKick
  actionCodes: ActionCodeHandler
  newTexters: NewTexters
}

/** Everything off: the routing the shop had before the assistant. */
export const ASSISTANT_OFF: AssistantPorts = Object.freeze({ gate: assistantOff, inbox: null, kick: noKick, actionCodes: noActionCodes, newTexters: noNewTexters })
