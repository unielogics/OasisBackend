// The Settings module's notifier ports on the messaging queue: a new closure's notice and the emergency fan-out reach the
// customer by SMS (or email when there is no usable number), with the activity-log line the recording notifiers wrote.
import { sql } from 'kysely'
import type { Tx } from '../../../platform/db.js'
import * as audit from '../../../platform/audit.js'
import { mediumDate } from '../../settings/labels.js'
import type {
  AffectedAppointment,
  ClosureNotice,
  ClosureNotifier,
  EmergencyNotifier,
  EmergencyNotifyRequest,
  EmergencyNotifyResult,
} from '../../settings/ports.js'
import { loadCustomerTarget } from '../db/recipients.js'
import { queueEmail } from '../email/service.js'
import type { EnqueueOutcome } from '../queue.js'
import type { MessagingRuntime } from '../runtime.js'

type Channel = 'sms' | 'email'

async function logActivity(tx: Tx, appointmentId: string, text: string, channel: Channel, meta: Record<string, unknown>): Promise<void> {
  await sql`insert into activity_log (appointment_id, text, channels, actor_type, meta)
    values (${appointmentId}, ${text}, ${[channel, 'system']}::text[], 'system', ${JSON.stringify(meta)}::jsonb)`.execute(tx)
}

function stateOf(out: EnqueueOutcome): EmergencyNotifyResult['state'] {
  if (out.queued) return 'queued'
  if (out.skipped === 'opted_out' || out.skipped === 'not_opted_in') return 'skipped_opt_out'
  if (out.skipped === 'no_valid_phone') return 'no_contact'
  return 'failed'
}

export class MessagingClosureNotifier implements ClosureNotifier {
  constructor(
    private readonly rt: MessagingRuntime,
    private readonly locationId: string,
  ) {}

  async notify(tx: Tx, notice: ClosureNotice, affected: AffectedAppointment[]): Promise<{ notified: number }> {
    const { rt } = this
    const when = `on ${mediumDate(notice.date)}`
    let notified = 0
    for (const a of affected) {
      const wantsSms = a.phoneE164 !== null && !a.smsOptedOut
      const target = wantsSms ? await loadCustomerTarget(tx, this.locationId, a.customerId) : null
      let channel: Channel | null = null
      let messageId: string | null = null
      if (target) {
        const out = await rt.queue.enqueueFor(tx, {
          locationId: this.locationId,
          customerId: a.customerId,
          recipient: target.recipient,
          appointmentId: a.appointmentId,
          ...(notice.type === 'closed'
            ? { templateKey: 'closure_notice', vars: { first: a.firstName, until: when } }
            : {
                text: `Hi ${a.firstName}, Oasis Auto Spa has reduced hours ${when}. Your ${a.time} appointment may be affected. Reply and we will sort it out.`,
                klass: 'closure_notice' as const,
              }),
          purpose: 'closure',
          senderKind: 'system',
          dedupeKey: `closure:${notice.closureId}:${a.appointmentId}`,
        })
        if (out.queued) {
          channel = 'sms'
          messageId = out.messageId
        }
      }
      if (!channel && a.email) {
        const q = await queueEmail(
          tx,
          {
            locationId: this.locationId,
            to: a.email,
            template: 'closure_notice',
            vars: { customerName: a.firstName, closureLabel: when, reason: notice.name },
            purpose: 'closure',
            customerId: a.customerId,
            dedupeKey: `closure:${notice.closureId}:${a.appointmentId}:email`,
          },
          rt.deps,
        )
        channel = 'email'
        messageId = q.emailId
      }
      if (!channel) continue
      notified += 1
      await logActivity(tx, a.appointmentId, `Closure notice queued by ${channel === 'sms' ? 'SMS' : 'email'}: ${notice.name}, ${mediumDate(notice.date)}`, channel, {
        closureId: notice.closureId,
        state: 'queued',
        messageId,
      })
    }
    await audit.record(tx, {
      locationId: this.locationId,
      action: 'closure.notify.queued',
      entityType: 'closure',
      entityId: notice.closureId,
      after: { date: notice.date, name: notice.name, notified, affected: affected.length },
    })
    return { notified }
  }
}

/** Emergency message fan-out. Lane 3 (bulk), never lane 0: the blast must not starve ready-for-pickup texts (review B15). */
export class MessagingEmergencyNotifier implements EmergencyNotifier {
  constructor(private readonly rt: MessagingRuntime) {}

  async send(tx: Tx, req: EmergencyNotifyRequest): Promise<EmergencyNotifyResult> {
    const { rt } = this
    const a = req.appointment
    let result: EmergencyNotifyResult
    if (req.channel === 'sms') {
      const target = await loadCustomerTarget(tx, req.locationId, a.customerId)
      if (!target) return { state: 'no_contact' }
      const out = await rt.queue.enqueueFor(tx, {
        locationId: req.locationId,
        customerId: a.customerId,
        recipient: target.recipient,
        appointmentId: a.appointmentId,
        text: req.message,
        klass: 'emergency',
        purpose: 'emergency',
        senderKind: 'system',
        dedupeKey: `emergency:${req.emergencyClosureId}:${a.appointmentId}`,
      })
      result = { state: stateOf(out), messageId: out.queued ? out.messageId : null }
    } else {
      if (!a.email) return { state: 'no_contact' }
      await queueEmail(
        tx,
        {
          locationId: req.locationId,
          to: a.email,
          template: 'closure_notice',
          vars: { customerName: a.firstName, closureLabel: `on ${mediumDate(a.bizDate)}`, message: req.message },
          purpose: 'emergency',
          customerId: a.customerId,
          dedupeKey: `emergency:${req.emergencyClosureId}:${a.appointmentId}:email`,
        },
        rt.deps,
      )
      result = { state: 'queued', messageId: null }
    }
    await logActivity(tx, a.appointmentId, `Emergency closure message ${result.state === 'queued' ? 'queued' : 'not sent'} by ${req.channel === 'sms' ? 'SMS' : 'email'}`, req.channel, {
      emergencyClosureId: req.emergencyClosureId,
      state: result.state,
      message: req.message,
      rescheduleCode: req.rescheduleCode,
    })
    return result
  }
}
