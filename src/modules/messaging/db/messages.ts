// Writes and reads of messages and threads, and the one place that mirrors an outbox transition onto its message row.
import { sql, type Insertable, type Selectable } from 'kysely'
import type { Executor, Tx } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import { getLocation } from '../../../platform/locations.js'
import * as realtime from '../../../platform/realtime.js'
import type { JsonValue } from '../../../platform/schema.js'
import { formatClock } from '../templates/format.js'
import type { OutboxState } from '../dispatch/types.js'
import type { MessageStatus, MessagesTable } from '../schema.js'
import '../schema.js'

/** Classes whose text carries a one-time link: the message row keeps a redacted body and the outbox body is wiped once the message is final. */
export const SENSITIVE_CLASSES: ReadonlySet<string> = new Set(['staff_invite', 'password_reset'])
export const REDACTED_BODY = '[link sent privately]'

export function messageStatusOf(state: OutboxState): MessageStatus {
  switch (state) {
    case 'pending':
      return 'queued'
    case 'inflight':
      return 'sending'
    case 'accepted':
    case 'sent':
      return 'sent'
    case 'delivered':
      return 'delivered'
    case 'failed':
      return 'failed'
    case 'expired':
      return 'expired'
    case 'cancelled':
      return 'canceled'
  }
}

const tzCache = new Map<string, string>()

export async function locationTz(db: Executor, locationId: string): Promise<string> {
  const hit = tzCache.get(locationId)
  if (hit) return hit
  const tz = (await getLocation(db, locationId))?.timezone ?? 'America/New_York'
  tzCache.set(locationId, tz)
  return tz
}

export interface MessageDto {
  id: string
  direction: 'in' | 'out'
  /** The design's bubble kinds: staff and system are right-aligned, customer left. */
  from: 'staff' | 'system' | 'customer'
  senderName: string | null
  text: string
  /** "10:36 AM" in the business time zone. */
  time: string
  at: string
  channel: 'sms' | 'email' | 'internal'
  status: MessageStatus
  error: string | null
  templateKey: string | null
  appointmentId: string | null
  customerId: string | null
  segments: number
  read: boolean
}

export type MessageRow = Pick<
  Selectable<MessagesTable>,
  | 'id'
  | 'direction'
  | 'sender_kind'
  | 'channel'
  | 'body'
  | 'template_key'
  | 'status'
  | 'error'
  | 'appointment_id'
  | 'customer_id'
  | 'segments'
  | 'queued_at'
  | 'received_at'
  | 'read_at'
> & { first: string | null; last: string | null }

const staffName = (first: string | null, last: string | null): string | null => {
  if (!first) return null
  const l = (last ?? '').trim()
  return l ? `${first.trim()} ${l[0]!.toUpperCase()}.` : first.trim()
}

export function toMessageDto(r: MessageRow, tz: string): MessageDto {
  const at = r.direction === 'in' ? (r.received_at ?? r.queued_at) : r.queued_at
  return {
    id: r.id,
    direction: r.direction,
    from: r.sender_kind,
    senderName: r.sender_kind === 'staff' ? staffName(r.first, r.last) : null,
    text: r.body,
    time: formatClock(at, tz),
    at: at.toISOString(),
    channel: r.channel,
    status: r.status,
    error: r.error,
    templateKey: r.template_key,
    appointmentId: r.appointment_id,
    customerId: r.customer_id,
    segments: r.segments,
    read: r.direction === 'out' || r.read_at !== null,
  }
}

const MESSAGE_COLUMNS = [
  'm.id',
  'm.direction',
  'm.sender_kind',
  'm.channel',
  'm.body',
  'm.template_key',
  'm.status',
  'm.error',
  'm.appointment_id',
  'm.customer_id',
  'm.segments',
  'm.queued_at',
  'm.received_at',
  'm.read_at',
  'e.first',
  'e.last',
] as const

/** One message as the thread read model and the SSE payload show it. */
export async function loadMessageDto(db: Executor, id: string): Promise<{ dto: MessageDto; locationId: string; threadId: string | null } | null> {
  const r = await db
    .selectFrom('messages as m')
    .leftJoin('employees as e', 'e.id', 'm.sender_employee_id')
    .select([...MESSAGE_COLUMNS, 'm.location_id', 'm.thread_id'])
    .where('m.id', '=', id)
    .executeTakeFirst()
  if (!r) return null
  return { dto: toMessageDto(r, await locationTz(db, r.location_id)), locationId: r.location_id, threadId: r.thread_id }
}

export interface ThreadFilter {
  appointmentId?: string
  customerId?: string
  limit?: number
}

/** Oldest first, the order a conversation is read in. The last `limit` messages when the thread is longer. */
export async function listThreadMessages(db: Executor, locationId: string, f: ThreadFilter): Promise<MessageDto[]> {
  let q = db
    .selectFrom('messages as m')
    .leftJoin('employees as e', 'e.id', 'm.sender_employee_id')
    .select(MESSAGE_COLUMNS)
    .where('m.location_id', '=', locationId)
    .where('m.channel', '=', 'sms')
  if (f.appointmentId) q = q.where('m.appointment_id', '=', f.appointmentId)
  if (f.customerId) q = q.where('m.customer_id', '=', f.customerId)
  const rows = await q.orderBy('m.queued_at', 'desc').orderBy('m.id', 'desc').limit(f.limit ?? 200).execute()
  const tz = await locationTz(db, locationId)
  return rows.reverse().map((r) => toMessageDto(r, tz))
}

export async function ensureThread(
  tx: Tx,
  o: { locationId: string; customerId: string; newId: NewId },
): Promise<string> {
  const id = o.newId()
  const r = await tx
    .insertInto('message_threads')
    .values({ id, location_id: o.locationId, customer_id: o.customerId })
    .onConflict((oc) => oc.columns(['location_id', 'customer_id']).doUpdateSet({ customer_id: o.customerId }))
    .returning('id')
    .executeTakeFirstOrThrow()
  return r.id
}

export async function touchThread(tx: Tx, threadId: string, at: Date, o: { inbound?: boolean; unread?: boolean } = {}): Promise<void> {
  await tx
    .updateTable('message_threads')
    .set((eb) => ({
      last_message_at: at,
      ...(o.inbound ? { last_inbound_at: at } : {}),
      ...(o.unread ? { unread_count: eb('unread_count', '+', 1) } : {}),
    }))
    .where('id', '=', threadId)
    .execute()
}

export async function insertMessage(tx: Tx, values: Insertable<MessagesTable>): Promise<void> {
  await tx.insertInto('messages').values(values).execute()
}

export async function publishMessage(
  tx: Tx,
  locationId: string,
  type: 'message.in' | 'message.out',
  dto: MessageDto,
  extra: Record<string, JsonValue> = {},
): Promise<void> {
  await realtime.publish(tx, { locationId, channel: 'messages', type, payload: { ...(dto as unknown as Record<string, JsonValue>), ...extra } })
}

const FINAL: ReadonlySet<OutboxState> = new Set(['delivered', 'failed', 'expired', 'cancelled'])

/**
 * Mirrors an outbox row onto its message: status, provider id, timestamps, error. When the status actually changes it also
 * publishes `message.status`, counts the device's sent/delivered/failed totals, follows an emergency notification's state,
 * and wipes the live text of a sensitive message once it is final.
 */
export async function syncMessageFromOutbox(
  tx: Tx,
  row: {
    id: string
    state: OutboxState
    klass: string
    provider_message_id: string | null
    device_id: string | null
    last_error: string | null
    accepted_at: Date | null
    sent_at: Date | null
    delivered_at: Date | null
  },
): Promise<void> {
  const status = messageStatusOf(row.state)
  const sentAt = row.sent_at ?? (row.state === 'accepted' ? row.accepted_at : null)
  const prev = await tx.selectFrom('messages').select('status').where('id', '=', row.id).forUpdate().executeTakeFirst()
  if (!prev) return
  const upd = await tx
    .updateTable('messages')
    .set({
      status,
      provider_message_id: row.provider_message_id,
      device_id: row.device_id,
      error: row.state === 'delivered' || row.state === 'sent' || row.state === 'accepted' ? null : row.last_error,
      ...(sentAt ? { sent_at: sentAt } : {}),
      ...(row.delivered_at ? { delivered_at: row.delivered_at } : {}),
    })
    .where('id', '=', row.id)
    .returning(['location_id', 'customer_id', 'appointment_id', 'thread_id', 'error'])
    .executeTakeFirstOrThrow()

  if (FINAL.has(row.state) && SENSITIVE_CLASSES.has(row.klass))
    await tx.updateTable('sms_outbox').set({ body: REDACTED_BODY }).where('id', '=', row.id).execute()

  if (prev.status === status) return

  await realtime.publish(tx, {
    locationId: upd.location_id,
    channel: 'messages',
    type: 'message.status',
    payload: {
      id: row.id,
      status,
      error: upd.error,
      customerId: upd.customer_id,
      appointmentId: upd.appointment_id,
      threadId: upd.thread_id,
    },
  })
  if (row.device_id && (status === 'sent' || status === 'delivered' || status === 'failed' || status === 'expired')) {
    const col = status === 'sent' ? 'sent_count' : status === 'delivered' ? 'delivered_count' : 'failed_count'
    await sql`update sms_devices set ${sql.id(col)} = ${sql.id(col)} + 1 where id = ${row.device_id}`.execute(tx)
  }
  if (status === 'sent' || status === 'delivered' || status === 'failed' || status === 'expired') {
    const state = status === 'sent' ? 'sent' : status === 'delivered' ? 'delivered' : 'failed'
    await tx
      .updateTable('emergency_notifications')
      .set({ state })
      .where('message_id', '=', row.id)
      .where('state', 'in', ['queued', 'sent'])
      .execute()
  }
}
