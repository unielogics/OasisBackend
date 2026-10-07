// Invite and password-reset links for employees: by SMS when a usable device and number exist, otherwise by email through
// the EmailProvider. `delivered` is true only when the link really left the system (an SMS Gate device or SES); with the
// simulators it stays false, so a Super Admin still receives the link in the API response during development.
import { DateTime } from 'luxon'
import type { AccountMessage, DeliveryResult, NotificationPort } from '../../auth/notifications.js'
import { hasActiveOptOut } from '../db/recipients.js'
import { queueEmail } from '../email/service.js'
import type { MessagingRuntime } from '../runtime.js'

export class MessagingAccountNotifier implements NotificationPort {
  constructor(private readonly rt: MessagingRuntime) {}

  async deliver(msg: AccountMessage): Promise<DeliveryResult> {
    const { rt } = this
    try {
      const loc = await rt.location()
      const devices = await rt.store.listEnabled(loc.id)
      const usable = devices.find((d) => d.status !== 'offline')
      if (msg.phone && usable) {
        const out = await rt.db.transaction().execute(async (tx) =>
          rt.queue.enqueueFor(tx, {
            locationId: loc.id,
            customerId: null,
            employeeId: msg.employeeId,
            recipient: {
              kind: 'employee',
              phone: msg.phone,
              smsOptIn: true,
              activeOptOut: await hasActiveOptOut(tx, loc.id, msg.phone!),
              synthetic: false,
            },
            appointmentId: null,
            templateKey: msg.kind === 'invite' ? 'staff_invite' : 'password_reset',
            vars: { first: msg.firstName, link: msg.link },
            purpose: msg.kind,
            senderKind: 'system',
          }),
        )
        if (out.queued) return { delivered: usable.provider === 'smsgate', channel: 'sms' }
      }
      if (msg.email) {
        const queued = await rt.db.transaction().execute((tx) =>
          queueEmail(
            tx,
            {
              locationId: loc.id,
              to: msg.email!,
              template: msg.kind === 'invite' ? 'staff_invite' : 'password_reset',
              vars:
                msg.kind === 'invite'
                  ? {
                      inviteeName: msg.firstName,
                      inviteUrl: msg.link,
                      expiresLabel: DateTime.fromJSDate(msg.expiresAt, { zone: rt.config.tz }).toFormat(
                        "LLL d 'at' h:mm a",
                      ),
                    }
                  : {
                      recipientName: msg.firstName,
                      resetUrl: msg.link,
                      expiresMinutes: Math.max(
                        1,
                        Math.round((msg.expiresAt.getTime() - rt.clock.now().getTime()) / 60_000),
                      ),
                    },
              purpose: msg.kind,
              employeeId: msg.employeeId,
            },
            rt.deps,
          ),
        )
        const sent = await rt.emailSender.sendNow(queued.emailId)
        return { delivered: sent === 'sent' && rt.deps.env.EMAIL_PROVIDER === 'ses', channel: 'email' }
      }
    } catch (err) {
      rt.log.error({ err: (err as Error).message, kind: msg.kind }, 'account message delivery failed')
    }
    return { delivered: false, channel: 'none' }
  }
}
