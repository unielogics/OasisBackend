// The InboundEffects of the inbound router bound to one transaction: replies go through the same queue as every other
// text, a "C" confirms through the scheduling confirm command, a received text lands in the customer's thread, and staff
// alerts become notifications. Everything shares the transaction of the webhook event that caused it.
import { sql } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { NIL_UUID, type NewId } from '../../platform/ids.js'
import { maskPhone } from '../../platform/phone.js'
import { normalizeE164 } from '../../integrations/sms/phone.js'
import type { ObjectStorage } from '../../integrations/storage/types.js'
import * as realtime from '../../platform/realtime.js'
import { confirmAppointment } from '../scheduling/lifecycle.js'
import type { Actor, SchedulingCtx } from '../scheduling/context.js'
import type { MessageQueue } from '../scheduling/ports.js'
import { loadCustomerTarget, strangerRecipient } from './db/recipients.js'
import type { PgInboxRepository } from './db/inbox-repo.js'
import { ensureThread, insertMessage, loadMessageDto, publishMessage, touchThread } from './db/messages.js'
import type { InboundEffects } from './inbound/service.js'
import { planAttachments } from './inbound/mms.js'
import type { DbMessageQueue } from './queue.js'

export interface EffectsEnv {
  clock: Clock
  newId: NewId
  queue: DbMessageQueue
  /** The scheduling context (real ports) a customer's "C" is confirmed through. */
  schedulingCtx(locationId: string): Promise<SchedulingCtx>
  notifyManagers(tx: Tx, n: ManagerNotice): Promise<void>
  warn?: (msg: string, detail: Record<string, unknown>) => void
  /** The photos store MMS pictures are saved in (created on first use). */
  storage?: () => ObjectStorage
}

export interface ManagerNotice {
  locationId: string
  kind: string
  title: string
  body: string
  entityType: string | null
  entityId: string | null
}

const REPLY_ACTOR_NAME = 'Customer reply'

// Keyword replies are the one text anybody can make the tablet send (no account, no consent needed), and lane 0 may spend the
// whole send window. At most REPLIES_PER_NUMBER of them go to one number per REPLY_WINDOW_MS; the rest of a flood is only filed.
const REPLY_WINDOW_MS = 30 * 60_000
const REPLIES_PER_NUMBER = 3
const REPLY_CLASSES = ['opt_out_confirm', 'opt_in_confirm', 'help_reply', 'confirm_ack', 'confirm_none']

function replyActor(locationId: string): Actor {
  return {
    auth: { userId: NIL_UUID, employeeId: null, locationId, permissions: new Set(['sched.edit', 'jobs.status']), actorName: REPLY_ACTOR_NAME },
    audit: { actor: { userId: null, name: `${REPLY_ACTOR_NAME} (SMS)` } },
  }
}

export function createInboundEffects(
  tx: Tx,
  e: EffectsEnv,
  o: { locationId: string; inbox: PgInboxRepository; event: { deviceId: string; providerMessageId: string } },
): InboundEffects {
  // One reply per template per received text, however many code paths ask for it.
  const replyKey = (template: string): string => `inbound-reply:${o.event.deviceId}:${o.event.providerMessageId}:${template}`

  return {
    async sendReply(to, template, vars, ctx) {
      const recent = await tx
        .selectFrom('sms_outbox')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('to_e164', '=', to)
        .where('klass', 'in', REPLY_CLASSES)
        .where('queued_at', '>', new Date(e.clock.now().getTime() - REPLY_WINDOW_MS))
        .executeTakeFirstOrThrow()
      if (recent.n >= REPLIES_PER_NUMBER) {
        e.warn?.('keyword reply skipped: too many replies to this number', { template })
        return
      }
      const target = ctx.customerId ? await loadCustomerTarget(tx, o.locationId, ctx.customerId) : null
      const recipient = target?.recipient ?? (await strangerRecipient(tx, o.locationId, to))
      await e.queue.enqueueFor(tx, {
        locationId: o.locationId,
        customerId: ctx.customerId,
        recipient,
        appointmentId: null,
        templateKey: template,
        vars,
        purpose: 'inbound-reply',
        senderKind: 'system',
        dedupeKey: replyKey(template),
      })
    },

    async confirmAppointment(appointmentId, customerId) {
      const base = await e.schedulingCtx(o.locationId)
      // The customer's own "C" is answered once, by confirm_ack: the confirm command's "confirmed" text becomes that
      // reply (same dedupe key as the router's reply, so the customer never gets two texts).
      const messages: MessageQueue = {
        enqueue: (t, m) =>
          m.purpose === 'confirm'
            ? e.queue.enqueue(t, {
                ...m,
                templateKey: 'confirm_ack',
                vars: { time: m.vars?.time },
                dedupeKey: replyKey('confirm_ack'),
              })
            : e.queue.enqueue(t, m),
      }
      try {
        await confirmAppointment(tx, { ...base, ports: { ...base.ports, messages } }, replyActor(o.locationId), appointmentId)
        await tx
          .insertInto('activity_log')
          .values({
            appointment_id: appointmentId,
            at: e.clock.now(),
            text: 'Confirmed by customer reply (C)',
            channels: ['sms'],
            actor_type: 'customer',
            meta: JSON.stringify({ customerId }) as never,
          })
          .execute()
      } catch (err) {
        // Staff confirmed it a moment ago, or it was canceled: nothing left to confirm, the reply still goes out.
        if (!(err instanceof AppError)) throw err
        e.warn?.('inbound confirm skipped', { appointmentId, code: err.code })
      }
    },

    async storeMessage(m) {
      const id = e.newId()
      const now = e.clock.now()
      const threadId = await ensureThread(tx, { locationId: o.locationId, customerId: m.customerId, newId: e.newId })
      const target = await loadCustomerTarget(tx, o.locationId, m.customerId)
      await insertMessage(tx, {
        id,
        location_id: o.locationId,
        thread_id: threadId,
        customer_id: m.customerId,
        appointment_id: m.appointmentId,
        direction: 'in',
        sender_kind: 'customer',
        channel: 'sms',
        kind: m.kind ?? 'sms',
        attachments: m.attachments ? JSON.stringify(m.attachments) : null,
        body: m.body,
        status: 'received',
        peer_e164: target?.recipient.phone ?? null,
        provider_message_id: m.providerMessageId,
        device_id: m.deviceId,
        queued_at: now,
        received_at: m.receivedAt,
        read_at: m.unread ? null : now,
      })
      await touchThread(tx, threadId, now, { inbound: true, unread: m.unread })
      await o.inbox.attach(m.deviceId, m.providerMessageId, { customerId: m.customerId, appointmentId: m.appointmentId, messageId: id })
      if (m.appointmentId)
        await tx
          .insertInto('activity_log')
          .values({
            appointment_id: m.appointmentId,
            at: now,
            text: m.kind === 'mms' ? 'Customer replied by MMS' : 'Customer replied by SMS',
            channels: ['sms'],
            actor_type: 'customer',
            meta: JSON.stringify({ messageId: id }) as never,
          })
          .execute()
      const loaded = await loadMessageDto(tx, id)
      if (loaded) await publishMessage(tx, o.locationId, 'message.in', loaded.dto)
    },

    async recordAttachments(parts, ctx) {
      const plan = planAttachments(o.locationId, ctx.providerMessageId, parts)
      const records = []
      for (const item of plan) {
        if (!item.save) {
          records.push(item.record)
          continue
        }
        try {
          if (!e.storage) throw new Error('no photo storage configured')
          await e.storage().put(item.save.key, item.save.body, item.save.contentType)
          records.push(item.record)
        } catch (err) {
          // the text matters more than the picture: record it as unavailable and carry on (a STOP must never wait on S3)
          e.warn?.('mms picture not saved', { index: item.record.index, err: (err as Error).message.slice(0, 200) })
          records.push({ ...item.record, status: 'unavailable' as const, reason: 'storage_error' as const, key: null })
        }
      }
      await o.inbox.setAttachments(ctx.inboxId, records)
      return records
    },

    async staffAlert(a) {
      if (a.kind === 'picture_message') {
        const who = a.customerId
          ? ((await tx.selectFrom('customers').select('full_name').where('id', '=', a.customerId).executeTakeFirst())?.full_name ?? 'customer')
          : (() => {
              const phone = normalizeE164(a.sender)
              return phone ? maskPhone(phone) : 'an unknown sender'
            })()
        await e.notifyManagers(tx, {
          locationId: o.locationId,
          kind: 'sms.picture_message',
          title: `Picture message from ${who} — check the tablet / dashboard`,
          body: a.excerpt,
          entityType: a.appointmentId ? 'appointment' : a.customerId ? 'customer' : null,
          entityId: a.appointmentId ?? a.customerId,
        })
      } else if (a.kind === 'cancel_request' || a.kind === 'unattributed_inbound') {
        const who = await tx.selectFrom('customers').select('full_name').where('id', '=', a.customerId).executeTakeFirst()
        await e.notifyManagers(tx, {
          locationId: o.locationId,
          kind: a.kind === 'cancel_request' ? 'sms.cancel_request' : 'sms.unattributed_reply',
          title: a.kind === 'cancel_request' ? `Cancel request · ${who?.full_name ?? 'customer'}` : `Reply with no appointment · ${who?.full_name ?? 'customer'}`,
          body: a.excerpt,
          entityType: a.appointmentId ? 'appointment' : 'customer',
          entityId: a.appointmentId ?? a.customerId,
        })
      }
      await realtime.publish(tx, { locationId: o.locationId, channel: 'ops', type: 'alerts.changed', payload: { source: 'sms', kind: a.kind } })
    },
  }
}
