// Recording notifiers: they queue nothing yet (the SMS and email wiring wave replaces them behind the same ports) but
// leave a durable trace, an activity-log line on each appointment and an audit row, so the screens show what would have
// been sent and nothing is lost when delivery arrives.
import { sql } from 'kysely'
import type { Db, Tx } from '../../../platform/db.js'
import * as audit from '../../../platform/audit.js'
import type { AccountMessage, DeliveryResult, NotificationPort } from '../../auth/notifications.js'
import {
  type AffectedAppointment,
  type ClosureNotice,
  type ClosureNotifier,
  type EmergencyNotifier,
  type EmergencyNotifyRequest,
  type EmergencyNotifyResult,
} from '../ports.js'
import { mediumDate } from '../labels.js'

interface ActivityRow {
  appointmentId: string
  text: string
  channels: ('sms' | 'email' | 'system')[]
  meta: Record<string, unknown>
}

/** System-authored activity lines (the table's json column is written as jsonb through raw SQL). */
async function insertActivity(tx: Tx, rows: ActivityRow[]): Promise<void> {
  if (rows.length === 0) return
  await sql`
    insert into activity_log (appointment_id, text, channels, actor_type, meta)
    values ${sql.join(
      rows.map(
        (r) =>
          sql`(${r.appointmentId}, ${r.text}, ${r.channels}::text[], 'system', ${JSON.stringify(r.meta)}::jsonb)`,
      ),
    )}`.execute(tx)
}

const channelOf = (a: AffectedAppointment): 'sms' | 'email' | null =>
  a.phoneE164 && !a.smsOptedOut ? 'sms' : a.email ? 'email' : null

/** Planned closure with the notify switch on: one activity line per reachable booked or confirmed appointment. */
export class ActivityClosureNotifier implements ClosureNotifier {
  constructor(private readonly locationId: string) {}

  async notify(
    tx: Tx,
    notice: ClosureNotice,
    affected: AffectedAppointment[],
  ): Promise<{ notified: number }> {
    const reachable = affected.map((a) => ({ a, channel: channelOf(a) })).filter((x) => x.channel !== null)
    await insertActivity(
      tx,
      reachable.map(({ a, channel }) => ({
        appointmentId: a.appointmentId,
        text: `Closure notice queued by ${channel === 'sms' ? 'SMS' : 'email'}: ${notice.name}, ${mediumDate(notice.date)}`,
        channels: [channel!, 'system'],
        meta: { closureId: notice.closureId, state: 'queued' },
      })),
    )
    await audit.record(tx, {
      locationId: this.locationId,
      action: 'closure.notify.queued',
      entityType: 'closure',
      entityId: notice.closureId,
      after: { date: notice.date, name: notice.name, notified: reachable.length, affected: affected.length },
    })
    return { notified: reachable.length }
  }
}

/** Emergency message fan-out: records the rendered message on the appointment and reports it queued. */
export class ActivityEmergencyNotifier implements EmergencyNotifier {
  async send(tx: Tx, req: EmergencyNotifyRequest): Promise<EmergencyNotifyResult> {
    await insertActivity(tx, [
      {
        appointmentId: req.appointment.appointmentId,
        text: `Emergency closure message queued by ${req.channel === 'sms' ? 'SMS' : 'email'}`,
        channels: [req.channel, 'system'],
        meta: {
          emergencyClosureId: req.emergencyClosureId,
          state: 'queued',
          message: req.message,
          rescheduleCode: req.rescheduleCode,
        },
      },
    ])
    return { state: 'queued' }
  }
}

/**
 * Invite and password-reset links. Nothing is delivered until the SMS and email wave, so every call reports "not
 * delivered" (a Super Admin then receives the link in the API response) and leaves an audit row. The link itself is a
 * credential and is never written to the audit log.
 */
export class AuditAccountNotifier implements NotificationPort {
  constructor(
    private readonly db: Db,
    private readonly locationId: string,
  ) {}

  async deliver(msg: AccountMessage): Promise<DeliveryResult> {
    const channel = msg.phone ? 'sms' : msg.email ? 'email' : 'none'
    await this.db.transaction().execute((tx) =>
      audit.record(tx, {
        locationId: this.locationId,
        action: `account.${msg.kind}.pending_delivery`,
        entityType: 'employee',
        entityId: msg.employeeId,
        after: { kind: msg.kind, plannedChannel: channel, expiresAt: msg.expiresAt.toISOString() },
      }),
    )
    return { delivered: false, channel: 'none' }
  }
}
