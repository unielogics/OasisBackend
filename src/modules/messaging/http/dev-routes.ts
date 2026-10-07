// Development helpers (design 5.6), mounted only with ALLOW_DEV_ENDPOINTS=true: inject a text from a phone into the
// simulated device, and read the console mailbox. Both need set.billing (Super Admin only).
import { access } from '../../../http/access.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import { AppError } from '../../../platform/errors.js'
import type { MessagingRuntime } from '../runtime.js'

const TAGS = ['dev']

export function registerDevRoutes(app: AppInstance, rt: MessagingRuntime): void {
  app.post(
    '/dev/sms/inbound',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        summary: 'Dev only: a text arrives on the simulated device from `from`',
        description: 'The simulator signs the webhook like the real app and it is handled by the same code path; the call returns after it has been applied.',
        body: z.object({ from: z.string().min(3).max(40), body: z.string().max(1000), deviceKey: z.string().optional() }).strict(),
        response: { 200: z.object({ injected: z.literal(true), providerMessageId: z.string() }) },
      },
    },
    async (req) => {
      const devices = await rt.store.listEnabled(req.auth!.locationId)
      const device = devices.find((d) => d.provider === 'sim' && (!req.body.deviceKey || d.device_key === req.body.deviceKey))
      const sim = device ? rt.simulator(device) : undefined
      if (!sim) throw new AppError('NOT_FOUND', { detail: 'No enabled simulator device' })
      const providerMessageId = sim.injectInbound(req.body.from, req.body.body, { at: app.clock.now() })
      await rt.idle()
      return { injected: true as const, providerMessageId }
    },
  )

  app.get(
    '/dev/mail',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: TAGS,
        summary: 'Dev only: the email outbox (console driver mailbox)',
        response: {
          200: z.object({
            items: z.array(
              z.object({ id: z.string(), to: z.string(), template: z.string(), subject: z.string().nullable(), body: z.string().nullable(), state: z.string(), error: z.string().nullable(), createdAt: z.string() }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const rows = await app.db
        .selectFrom('outbox_emails')
        .select(['id', 'to_email', 'template', 'subject', 'body', 'state', 'error', 'created_at'])
        .where('location_id', '=', req.auth!.locationId)
        .orderBy('created_at', 'desc')
        .limit(50)
        .execute()
      return { items: rows.map((r) => ({ id: r.id, to: r.to_email, template: r.template, subject: r.subject, body: r.body, state: r.state, error: r.error, createdAt: r.created_at.toISOString() })) }
    },
  )
}
