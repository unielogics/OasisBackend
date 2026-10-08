// The email suppression list (ADR 0110): GET lists the addresses Oasis no longer mails after an SES hard bounce or complaint;
// DELETE lifts one after the address was fixed or the person asked to receive mail again (audited; the next bounce re-suppresses).
import { auditContextOf } from '../../http/authorizer.js'
import { access } from '../../http/access.js'
import type { AppInstance } from '../../http/types.js'
import { z } from '../../http/zod.js'
import * as audit from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import { maskEmail } from '../../platform/phone.js'
import '../messaging/schema.js'

const iso = z.iso.datetime({ offset: true })

const SuppressionRow = z.object({
  address: z.string(),
  reason: z.enum(['bounce', 'complaint']),
  bounceType: z.string().nullable(),
  bounceSubType: z.string().nullable(),
  complaintFeedbackType: z.string().nullable(),
  firstSeenAt: iso,
  lastSeenAt: iso,
  count: z.number().int(),
})

export function registerEmailSuppressionRoutes(app: AppInstance): void {
  app.get(
    '/system/email-suppressions',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: ['system'],
        summary: 'Addresses no email is sent to (SES hard bounces and complaints), newest first',
        description:
          'Addresses are shown in full only to callers who hold `cli.contact`; others see them masked. At most 500 rows.',
        response: { 200: z.object({ items: z.array(SuppressionRow) }) },
      },
    },
    async (req) => {
      const full = req.auth?.permissions.has('*') || req.auth?.permissions.has('cli.contact')
      const rows = await app.db
        .selectFrom('email_suppressions')
        .selectAll()
        .where('cleared_at', 'is', null)
        .orderBy('last_seen_at', 'desc')
        .limit(500)
        .execute()
      return {
        items: rows.map((r) => ({
          address: full ? r.address : maskEmail(r.address),
          reason: r.reason,
          bounceType: r.bounce_type,
          bounceSubType: r.bounce_subtype,
          complaintFeedbackType: r.complaint_feedback_type,
          firstSeenAt: r.first_seen_at.toISOString(),
          lastSeenAt: r.last_seen_at.toISOString(),
          count: r.count,
        })),
      }
    },
  )

  app.delete(
    '/system/email-suppressions/:address',
    {
      config: { access: access.perm('set.billing', 'cli.contact') },
      schema: {
        tags: ['system'],
        summary: 'Lift the suppression of one address (it receives email again until it bounces again)',
        params: z.object({ address: z.string().min(3).max(254) }),
        response: { 200: z.object({ cleared: z.boolean() }) },
      },
    },
    async (req) => {
      const address = req.params.address.trim().toLowerCase()
      const auth = req.auth!
      return app.db.transaction().execute(async (tx) => {
        const r = await tx
          .updateTable('email_suppressions')
          .set({ cleared_at: app.clock.now(), cleared_by: auth.realUserId ?? auth.userId, updated_at: app.clock.now() })
          .where('address', '=', address)
          .where('cleared_at', 'is', null)
          .returning(['reason', 'count'])
          .executeTakeFirst()
        if (!r) throw new AppError('NOT_FOUND', { detail: 'That address is not suppressed' })
        await audit.record(tx, {
          locationId: auth.locationId,
          action: 'email.suppression.clear',
          entityType: 'email_suppression',
          entityId: maskEmail(address),
          before: { reason: r.reason, count: r.count },
          ctx: auditContextOf(req),
        })
        return { cleared: true }
      })
    },
  )
}
