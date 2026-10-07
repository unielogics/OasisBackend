// The InboundEffects of the inbound router bound to one transaction: replies go through the same queue as every other
// text, a "C" confirms through the scheduling confirm command, a received text lands in the customer's thread, and staff
// alerts become notifications. Everything shares the transaction of the webhook event that caused it.
import type { Clock } from '../../platform/clock.js'
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { NIL_UUID, type NewId } from '../../platform/ids.js'
import * as realtime from '../../platform/realtime.js'
import { confirmAppointment } from '../scheduling/lifecycle.js'
import type { Actor, SchedulingCtx } from '../scheduling/context.js'
import type { MessageQueue } from '../scheduling/ports.js'
import { loadCustomerTarget, strangerRecipient } from './db/recipients.js'
import type { PgInboxRepository } from './db/inbox-repo.js'
import { ensureThread, insertMessage, loadMessageDto, publishMessage, touchThread } from './db/messages.js'
import type { InboundEffects } from './inbound/service.js'
import type { DbMessageQueue } from './queue.js'

export interface EffectsEnv {
  clock: Clock
  newId: NewId
  queue: DbMessageQueue
  /** The scheduling context (real ports) a customer's "C" is confirmed through. */
  schedulingCtx(locationId: string): Promise<SchedulingCtx>
  notifyManagers(tx: Tx, n: ManagerNotice): Promise<void>
  warn?: (msg: string, detail: Record<string, unknown>) => void
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

function replyActor(locationId: string): Actor {
  return {
    auth: {
      userId: NIL_UUID,
      employeeId: null,
      locationId,
      permissions: new Set(['sched.edit', 'jobs.status']),
      actorName: REPLY_ACTOR_NAME,
    },
    audit: { actor: { userId: null, name: `${REPLY_ACTOR_NAME} (SMS)` } },
  }
}

export function createInboundEffects(
  tx: Tx,
  e: EffectsEnv,
  o: { locationId: string; inbox: PgInboxRepository; event: { deviceId: string; providerMessageId: string } },
): InboundEffects {
  // One reply per template per received text, however many code paths ask for it.
  const replyKey = (template: string): string =>
    `inbound-reply:${o.event.deviceId}:${o.event.providerMessageId}:${template}`

  return {
    async sendReply(to, template, vars, ctx) {
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
        await confirmAppointment(
          tx,
          { ...base, ports: { ...base.ports, messages } },
          replyActor(o.locationId),
          appointmentId,
        )
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
      const threadId = await ensureThread(tx, {
        locationId: o.locationId,
        customerId: m.customerId,
        newId: e.newId,
      })
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
      await o.inbox.attach(m.deviceId, m.providerMessageId, {
        customerId: m.customerId,
        appointmentId: m.appointmentId,
        messageId: id,
      })
      if (m.appointmentId)
        await tx
          .insertInto('activity_log')
          .values({
            appointment_id: m.appointmentId,
            at: now,
            text: 'Customer replied by SMS',
            channels: ['sms'],
            actor_type: 'customer',
            meta: JSON.stringify({ messageId: id }) as never,
          })
          .execute()
      const loaded = await loadMessageDto(tx, id)
      if (loaded) await publishMessage(tx, o.locationId, 'message.in', loaded.dto)
    },

    async staffAlert(a) {
      if (a.kind === 'cancel_request' || a.kind === 'unattributed_inbound') {
        const who = await tx
          .selectFrom('customers')
          .select('full_name')
          .where('id', '=', a.customerId)
          .executeTakeFirst()
        await e.notifyManagers(tx, {
          locationId: o.locationId,
          kind: a.kind === 'cancel_request' ? 'sms.cancel_request' : 'sms.unattributed_reply',
          title:
            a.kind === 'cancel_request'
              ? `Cancel request · ${who?.full_name ?? 'customer'}`
              : `Reply with no appointment · ${who?.full_name ?? 'customer'}`,
          body: a.excerpt,
          entityType: a.appointmentId ? 'appointment' : 'customer',
          entityId: a.appointmentId ?? a.customerId,
        })
      }
      await realtime.publish(tx, {
        locationId: o.locationId,
        channel: 'ops',
        type: 'alerts.changed',
        payload: { source: 'sms', kind: a.kind },
      })
    },
  }
}
