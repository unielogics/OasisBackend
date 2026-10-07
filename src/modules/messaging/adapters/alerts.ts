// Needs Attention alerts 10 and 11 (design 4.4): an unread inbound text (also one that could not be tied to an appointment,
// and a customer's CANCEL) and an SMS device that is offline. Computed on read, like the other alerts.
import type { Executor } from '../../../platform/db.js'
import { fmtT, minutesOfDay } from '../../../platform/time.js'
import type { ExternalAlert, ExternalAlertSource } from '../../scheduling/ports.js'
import { parseKeyword } from '../inbound/keywords.js'
import { locationTz } from '../db/messages.js'
import '../schema.js'

const PREVIEW = 56
const MAX_REPLY_ALERTS = 12

export const messagingAlertSource: ExternalAlertSource = {
  async list(
    db: Executor,
    ctx: { locationId: string; now: Date; manager: boolean },
  ): Promise<ExternalAlert[]> {
    const out: ExternalAlert[] = []
    const tz = await locationTz(db, ctx.locationId)

    const unread = await db
      .selectFrom('messages as m')
      .innerJoin('customers as c', 'c.id', 'm.customer_id')
      .select(['m.id', 'm.body', 'm.appointment_id', 'm.customer_id', 'm.queued_at', 'c.full_name'])
      .where('m.location_id', '=', ctx.locationId)
      .where('m.direction', '=', 'in')
      .where('m.read_at', 'is', null)
      .orderBy('m.queued_at', 'desc')
      .limit(200)
      .execute()
    const seen = new Set<string>()
    for (const m of unread) {
      const key = m.appointment_id ?? `c:${m.customer_id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (seen.size > MAX_REPLY_ALERTS) break
      const cancel = parseKeyword(m.body).kind === 'cancel'
      const preview = m.body.length > PREVIEW ? `${m.body.slice(0, PREVIEW)}…` : m.body
      out.push({
        key: `new_reply:${key}`,
        kind: 'new_reply',
        tone: cancel ? 'red' : 'blue',
        title: cancel ? `Cancel request · ${m.full_name}` : `New reply · ${m.full_name}`,
        desc: `${fmtT(minutesOfDay(m.queued_at, tz))} “${preview}”${m.appointment_id ? '' : ' · no appointment'}`,
        actionLabel: 'Open',
        appointmentId: m.appointment_id,
        priority: cancel ? 1 : 0,
      })
    }

    if (ctx.manager) {
      const down = await db
        .selectFrom('sms_devices')
        .select(['id', 'label', 'state_changed_at', 'last_seen_at'])
        .where('location_id', '=', ctx.locationId)
        .where('enabled', '=', true)
        .where('status', '=', 'offline')
        .orderBy('created_at')
        .execute()
      for (const d of down) {
        const since = d.last_seen_at ?? d.state_changed_at
        out.push({
          key: `sms_device_down:${d.id}`,
          kind: 'sms_device_down',
          tone: 'red',
          title: 'SMS device offline',
          desc: `${d.label}${since ? ` · last heard from at ${fmtT(minutesOfDay(since, tz))}` : ''} · texts are queued`,
          actionLabel: 'Open health',
          appointmentId: null,
          priority: 1,
        })
      }
    }
    return out
  },
}
