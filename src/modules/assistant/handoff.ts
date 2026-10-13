// The assistant's way out (ADR 0160, design section 3 "Failure"): the fixed fallback text "Thanks — a team member will text you back
// shortly." (at most one per conversation every 2 hours) and the handoff: the conversation's handoff opens (AssistantInbox.openHandoff:
// no AI on it until staff answer), the Needs-attention alert ai_handoff shows (the alerts adapter reads the open handoff), the managers
// are notified once per open handoff (kind assistant.handoff), and the client's thread is marked unread. Everything runs in the
// caller's transaction.
import { sql } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import type { Tx } from '../../platform/db.js'
import { NIL_UUID, type NewId } from '../../platform/ids.js'
import { maskPhone } from '../../platform/phone.js'
import * as realtime from '../../platform/realtime.js'
import { handoffSourceRef } from '../messaging/assistant/inbox.js'
import { loadCustomerTarget, strangerRecipient } from '../messaging/db/recipients.js'
import { notifyManagers } from '../messaging/notify.js'
import type { SmsRecipient } from '../messaging/policy/canSend.js'
import type { AssistantQueue } from './contract.js'
import type { AssistantInbox } from './ports.js'
import { conversationVoice, FALLBACK_TEXTS, markDisclosed, withDisclosure } from './lang.js'
import '../messaging/schema.js'
import './schema.js'

export const FALLBACK_TEMPLATE = 'ai_fallback'

export interface HandoffDeps {
  clock: Clock
  newId: NewId
  queue: AssistantQueue
  inbox: AssistantInbox
}

export interface ConversationRef {
  id: string
  locationId: string
  phone: string
  /** The client whose thread the conversation's texts are filed in (null: a stranger). */
  threadCustomerId: string | null
}

/** Who to show in a staff alert: the client's name, else the masked number. */
async function whoOf(tx: Tx, c: ConversationRef): Promise<string> {
  if (c.threadCustomerId) {
    const r = await tx.selectFrom('customers').select('full_name').where('id', '=', c.threadCustomerId).executeTakeFirst()
    if (r) return r.full_name
  }
  return maskPhone(c.phone)
}

/** The recipient the policy needs for a text to this conversation's number. */
export async function recipientOf(tx: Tx, c: ConversationRef): Promise<SmsRecipient> {
  if (c.threadCustomerId) {
    const t = await loadCustomerTarget(tx, c.locationId, c.threadCustomerId)
    if (t) return t.recipient
  }
  return strangerRecipient(tx, c.locationId, c.phone)
}

/**
 * Queues the fixed fallback text unless one went to this conversation within `everyMs`. Returns the message id, or null when it was
 * not sent (too soon, or refused by the policy: opted out, no recent inbound text).
 */
export async function sendFallback(tx: Tx, d: HandoffDeps, c: ConversationRef, o: { turnId: string; everyMs: number }): Promise<string | null> {
  const now = d.clock.now()
  const row = await tx.selectFrom('assistant_conversations').select('last_fallback_at').where('id', '=', c.id).executeTakeFirst()
  if (row?.last_fallback_at && now.getTime() - row.last_fallback_at.getTime() < o.everyMs) return null
  // W4b X1/X5: the fallback can be the first text of the AI flow (the first turn failed): then it discloses the assistant and
  // carries the STOP footer, in the conversation's language
  const voice = await conversationVoice(tx, c.id)
  const fixed = FALLBACK_TEXTS[voice.lang]
  const out = await d.queue.enqueueFor(tx, {
    locationId: c.locationId,
    customerId: c.threadCustomerId,
    recipient: await recipientOf(tx, c),
    appointmentId: null,
    text: voice.disclosed ? fixed : withDisclosure(fixed, voice.lang),
    klass: 'ai_fallback',
    tag: FALLBACK_TEMPLATE,
    purpose: 'assistant',
    senderKind: 'ai',
    dedupeKey: `ai-fallback:${o.turnId}`,
  })
  if (!out.queued) return null
  if (!voice.disclosed) await markDisclosed(tx, c.id, now)
  await tx
    .updateTable('assistant_conversations')
    .set({ last_fallback_at: now, updated_at: now })
    .where('id', '=', c.id)
    .execute()
  return out.messageId
}

/**
 * Opens the handoff (no AI on the conversation until staff answer it), pages the managers once per open handoff, marks the client's
 * thread unread and refreshes the alerts. `reason` is stored on the conversation (fallback, guard, cap:<kind>, lease_timeout, the
 * model's handoff_to_staff reason, ...); `summary` is the alert's text.
 */
export async function openTurnHandoff(
  tx: Tx,
  d: HandoffDeps,
  c: ConversationRef,
  o: { reason: string; summary: string; notify?: boolean },
): Promise<{ alreadyOpen: boolean }> {
  const now = d.clock.now()
  const newest = await tx
    .selectFrom('sms_inbox')
    .select('id')
    .where('assistant_conversation_id', '=', c.id)
    .orderBy('received_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()
  const r = await d.inbox.openHandoff(tx, {
    locationId: c.locationId,
    phone: c.phone,
    customerId: c.threadCustomerId,
    inboxId: newest?.id ?? NIL_UUID,
    reason: o.reason,
    at: now,
  })
  if (r.alreadyOpen) return { alreadyOpen: true }
  if (c.threadCustomerId)
    await tx
      .updateTable('message_threads')
      .set({ unread_count: sql<number>`unread_count + 1` })
      .where('location_id', '=', c.locationId)
      .where('customer_id', '=', c.threadCustomerId)
      .execute()
  // `notify: false` (a shop-wide cap: its one notice per window already told the managers) pages nobody for this conversation
  if (o.notify !== false) await notifyHandoff(tx, d, c, r.conversationId, o.summary)
  await realtime.publish(tx, { locationId: c.locationId, channel: 'ops', type: 'alerts.changed', payload: { source: 'sms', kind: 'ai_handoff' } })
  return { alreadyOpen: false }
}

async function notifyHandoff(tx: Tx, d: HandoffDeps, c: ConversationRef, conversationId: string, summary: string): Promise<void> {
  const who = await whoOf(tx, c)
  await notifyManagers(
    tx,
    {
      locationId: c.locationId,
      kind: 'assistant.handoff',
      title: `${who}: the assistant handed the chat to the team — reply in Messages`,
      body: summary.slice(0, 500),
      entityType: c.threadCustomerId ? 'customer' : null,
      entityId: c.threadCustomerId,
      sourceRef: handoffSourceRef(conversationId),
    },
    { newId: d.newId, clock: d.clock },
  )
}

/** Marks the client's thread unread (texts the AI took but will not answer now) and refreshes the alerts. */
export async function markUnanswered(tx: Tx, c: ConversationRef): Promise<void> {
  if (!c.threadCustomerId) return
  await tx
    .updateTable('message_threads')
    .set({ unread_count: sql<number>`unread_count + 1` })
    .where('location_id', '=', c.locationId)
    .where('customer_id', '=', c.threadCustomerId)
    .execute()
  await realtime.publish(tx, { locationId: c.locationId, channel: 'ops', type: 'alerts.changed', payload: { source: 'sms', kind: 'new_reply' } })
}

/** The reason words staff read in the alert body. */
export const HANDOFF_SUMMARIES: Record<string, string> = {
  fallback: 'The assistant could not answer this text.',
  guard: 'The assistant’s answer did not pass the safety checks.',
  policy_judge: 'The assistant’s answer did not pass the policy check (a price, a promise, a code, a link or a legal statement).',
  judge_error: 'The policy check of the assistant’s answer did not respond, so the answer was not sent.',
  lease_timeout: 'The assistant’s answer took too long.',
  stale: 'These texts waited too long for the assistant.',
  no_progress: 'The conversation went in circles: a person should take over.',
  'cap:number_hour': 'This number reached the assistant’s hourly limit.',
  'cap:number_day': 'This number reached the assistant’s daily limit.',
  'cap:unknown_day': 'This unknown number reached the assistant’s daily limit.',
  'cap:global_hour': 'The assistant reached its hourly limit for the shop.',
  'cap:global_day': 'The assistant reached its daily limit for the shop: it is off until tomorrow.',
  'cap:budget': 'The assistant reached its daily budget: it is off until tomorrow.',
  // ADR 0174 §3b (Settings → Oasis AI → Limits & tone)
  language: 'The client writes in Spanish: Settings → Oasis AI hands Spanish chats to the team.',
}
