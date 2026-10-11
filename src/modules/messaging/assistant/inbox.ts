// The conversation side of the inbound path on Postgres (ADR 0160, design section 3), all inside the caller's transaction:
//   - the durable marker: a text the assistant takes sets assistant_conversations.pending_since (the oldest unanswered text of a
//     burst), last_inbound_at and the client, and links the sms_inbox row; the turn (wave 3) clears it once it answered;
//   - AGENT: an open handoff on the number's conversation (no AI on it until staff resolve it);
//   - the staff takeover: a staff text on a thread pauses the AI there for assistant.staff_pause_hours and resolves an open handoff;
//   - whether an in-chat action waits for its reply number from a phone.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import * as realtime from '../../../platform/realtime.js'
import { getSetting } from '../../../platform/settings.js'
import type { AssistantInbox, HandoffInput, PendingMarkInput } from '../../assistant/ports.js'
import { cancelPendingActions } from '../../identity/pending-actions.js'
import { publishToManagers } from '../notify.js'
import '../schema.js'
import '../../assistant/schema.js'
import '../../identity/schema.js'

/** notifications.source_ref of the alert a handoff raised: found again (and marked read) when staff take the thread over. */
export const handoffSourceRef = (conversationId: string): string => `assistant_handoff:${conversationId}`

export function createPgAssistantInbox(o: { newId: NewId }): AssistantInbox {
  return {
    async markPending(tx: Tx, i: PendingMarkInput): Promise<{ conversationId: string }> {
      const r = await sql<{ id: string }>`
        insert into assistant_conversations (id, location_id, phone_e164, customer_id, pending_since, last_inbound_at, updated_at)
        values (${o.newId()}, ${i.locationId}, ${i.phone}, ${i.customerId}, ${i.receivedAt}, ${i.receivedAt}, ${i.receivedAt})
        on conflict (location_id, phone_e164) do update set
          pending_since = coalesce(assistant_conversations.pending_since, excluded.pending_since),
          last_inbound_at = greatest(assistant_conversations.last_inbound_at, excluded.last_inbound_at),
          customer_id = coalesce(excluded.customer_id, assistant_conversations.customer_id),
          updated_at = excluded.updated_at
        returning id`.execute(tx)
      const conversationId = r.rows[0]!.id
      await tx.updateTable('sms_inbox').set({ assistant_conversation_id: conversationId }).where('id', '=', i.inboxId).execute()
      return { conversationId }
    },

    async openHandoff(tx: Tx, i: HandoffInput): Promise<{ conversationId: string; alreadyOpen: boolean }> {
      const prior = await tx
        .selectFrom('assistant_conversations')
        .select(['id', 'handoff_state'])
        .where('location_id', '=', i.locationId)
        .where('phone_e164', '=', i.phone)
        .forUpdate()
        .executeTakeFirst()
      const alreadyOpen = prior?.handoff_state === 'open'
      const reason = i.reason.slice(0, 500)
      let conversationId: string
      if (prior) {
        conversationId = prior.id
        await tx
          .updateTable('assistant_conversations')
          .set({
            // the texts waiting for the AI are the staff's now
            pending_since: null,
            last_inbound_at: sql<Date>`greatest(last_inbound_at, ${i.at})`,
            customer_id: sql<string | null>`coalesce(${i.customerId}::uuid, customer_id)`,
            updated_at: i.at,
            ...(alreadyOpen ? {} : { handoff_state: 'open' as const, handoff_reason: reason, handoff_at: i.at }),
          })
          .where('id', '=', prior.id)
          .execute()
      } else {
        conversationId = o.newId()
        await tx
          .insertInto('assistant_conversations')
          .values({
            id: conversationId,
            location_id: i.locationId,
            phone_e164: i.phone,
            customer_id: i.customerId,
            last_inbound_at: i.at,
            handoff_state: 'open',
            handoff_reason: reason,
            handoff_at: i.at,
            updated_at: i.at,
          })
          .execute()
      }
      await tx.updateTable('sms_inbox').set({ assistant_conversation_id: conversationId }).where('id', '=', i.inboxId).execute()
      return { conversationId, alreadyOpen }
    },
  }
}

export interface StaffTakeover {
  locationId: string
  threadId: string
  customerId: string
  /** The number the staff text went to (the conversation is per number). */
  phone: string | null
  /** The employee who wrote it (null for a staff text queued by the system on their behalf). */
  employeeId: string | null
  now: Date
}

/**
 * A staff text on a thread (design section 3, owner decision: "a staff reply pauses the AI on that thread 12 h"): the thread's
 * ai_paused_until moves to now + assistant.staff_pause_hours (never earlier than it was), an open handoff of the client's
 * conversation is resolved, its texts stop waiting for the AI, and the handoff alert is marked read. Inert while the AI is off:
 * the gate reads the pause only when the assistant answers.
 */
export async function noteStaffTakeover(tx: Tx, t: StaffTakeover): Promise<{ pausedUntil: Date; conversations: number }> {
  const hours = (await getSetting(tx, t.locationId, 'assistant.staff_pause_hours')).value
  const until = new Date(t.now.getTime() + hours * 3600_000)
  await tx
    .updateTable('message_threads')
    .set({
      ai_paused_until: sql<Date>`greatest(coalesce(ai_paused_until, ${until}), ${until})`,
      ai_paused_by: t.employeeId,
    })
    .where('id', '=', t.threadId)
    .execute()
  const touched = await tx
    .updateTable('assistant_conversations')
    .set({
      handoff_state: sql<'open' | 'resolved' | null>`case when handoff_state = 'open' then 'resolved' else handoff_state end`,
      pending_since: null,
      updated_at: t.now,
    })
    .where('location_id', '=', t.locationId)
    .where((eb) => (t.phone ? eb.or([eb('customer_id', '=', t.customerId), eb('phone_e164', '=', t.phone)]) : eb('customer_id', '=', t.customerId)))
    .where((eb) => eb.or([eb('handoff_state', '=', 'open'), eb('pending_since', 'is not', null)]))
    .returning('id')
    .execute()
  // an in-chat action waiting for its reply number is the AI's: staff took the thread over, so it no longer runs (ADR 0160, W3b)
  await cancelPendingActions(tx, { locationId: t.locationId, customerId: t.customerId, phone: t.phone, now: t.now, error: 'staff took the thread over' })
  // the handoff alerts of those conversations are answered
  const refs = touched.map((c) => handoffSourceRef(c.id))
  if (refs.length > 0) {
    const read = await tx
      .updateTable('notifications')
      .set({ read_at: sql<Date>`coalesce(read_at, ${t.now})` })
      .where('location_id', '=', t.locationId)
      .where('source_ref', 'in', refs)
      .where('read_at', 'is', null)
      .returning('id')
      .execute()
    if (read.length > 0) {
      await publishToManagers(tx, t.locationId, 'notification.updated', { ids: read.map((r) => r.id), reason: 'staff_replied' })
      await realtime.publish(tx, { locationId: t.locationId, channel: 'ops', type: 'alerts.changed', payload: { source: 'sms', kind: 'ai_handoff' } })
    }
  }
  return { pausedUntil: until, conversations: touched.length }
}

/** True when an in-chat action waits for its reply number from this phone (pending and not expired). */
export async function hasPendingAction(db: Executor, q: { locationId: string; phone: string; now: Date }): Promise<boolean> {
  const r = await db
    .selectFrom('assistant_pending_actions')
    .select('id')
    .where('location_id', '=', q.locationId)
    .where('phone_e164', '=', q.phone)
    .where('state', '=', 'pending')
    .where('expires_at', '>', q.now)
    .executeTakeFirst()
  return r !== undefined
}
