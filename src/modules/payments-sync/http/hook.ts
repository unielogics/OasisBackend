// POST /hooks/squarespace: the optional webhook accelerator (polling is the baseline; webhooks need an OAuth app and there is no
// transaction topic). Verified per the documented scheme (hex HMAC-SHA256 over the raw body, secret decoded from hex, constant
// time), de-duplicated on the NOTIFICATION id in webhook_log, answered fast; the order itself is fetched and stored by the
// `sqsp.webhook.process` job (inline when there is no queue), through the same upsert as the poll.
import type { ApiModule } from '../../../http/modules.js'
import { webhookRoute } from '../../../http/webhooks.js'
import { receiveWebhook } from '../../../integrations/squarespace/webhook.js'
import { AppError } from '../../../platform/errors.js'
import { createIdGenerator } from '../../../platform/ids.js'
import { getDefaultLocation } from '../../../platform/locations.js'
import { createSecretBox } from '../db/secrets.js'
import { createSqspRuntime } from '../db/runtime-config.js'
import { DbNotificationDedupe, loadWebhookSecrets } from '../db/webhook.js'
import '../db/problems.js'

export const squarespaceHookModule: ApiModule = (app, deps) => {
  const newId = deps.newId ?? createIdGenerator(deps.clock)
  const dedupe = new DbNotificationDedupe(deps.db, newId)
  webhookRoute(app, {
    provider: 'squarespace',
    path: '/squarespace',
    handler: async (req, reply) => {
      const env = deps.env
      const stored = await loadWebhookSecrets(
        deps.db,
        env.SECRETS_KEY ? createSecretBox([env.SECRETS_KEY]) : undefined,
      )
      const outcome = await receiveWebhook(
        {
          clock: deps.clock,
          dedupe,
          secrets: (subscriptionId) => [
            ...stored
              .filter((s) => !subscriptionId || s.subscriptionId === subscriptionId)
              .map((s) => s.secret),
            ...(env.SQSP_WEBHOOK_SECRET ? [env.SQSP_WEBHOOK_SECRET] : []),
          ],
        },
        { rawBody: req.rawBody ?? '', headers: req.headers },
      )
      switch (outcome.status) {
        case 'invalid_signature':
          throw new AppError('WEBHOOK_SIGNATURE_INVALID')
        case 'malformed':
          throw new AppError('MALFORMED_REQUEST', { detail: outcome.reason })
        case 'stale':
        case 'duplicate':
        case 'ignored':
          // acknowledged: a non-2xx would make Squarespace retry for 48 hours
          return reply.status(200).send({ status: outcome.status })
        case 'accepted': {
          const sub = outcome.subscriptionId
            ? stored.find((s) => s.subscriptionId === outcome.subscriptionId)
            : undefined
          const locationId = sub?.locationId ?? (await getDefaultLocation(deps.db))?.id
          if (!locationId) {
            await dedupe.release(outcome.notificationId)
            throw new AppError('SERVICE_UNAVAILABLE')
          }
          const h = req.headers
          await dedupe.record(
            outcome.notificationId,
            {
              'content-type': String(h['content-type'] ?? ''),
              'user-agent': String(h['user-agent'] ?? ''),
              topic: outcome.topic,
              ...(outcome.update ? { update: outcome.update } : {}),
            },
            req.rawBody ?? '',
          )
          if (outcome.subscriptionId)
            await deps.db
              .updateTable('sqsp_webhook_subscriptions')
              .set({ last_delivery_at: deps.clock.now() })
              .where('sqsp_subscription_id', '=', outcome.subscriptionId)
              .execute()
          const data = { orderId: outcome.orderId, notificationId: outcome.notificationId, locationId }
          if (deps.jobs) {
            try {
              await deps.jobs.enqueue('sqsp.webhook.process', data)
            } catch {
              await dedupe.release(outcome.notificationId)
              throw new AppError('SERVICE_UNAVAILABLE')
            }
            return reply.status(202).send({ status: 'accepted' })
          }
          try {
            const r = await createSqspRuntime({ db: deps.db, clock: deps.clock, newId, env }).ingestOrder(
              locationId,
              outcome.orderId,
            )
            await dedupe.finish(outcome.notificationId, r ? 'processed' : 'ignored', deps.clock.now())
          } catch (e) {
            await dedupe.finish(
              outcome.notificationId,
              'failed',
              deps.clock.now(),
              e instanceof Error ? e.message : String(e),
            )
            await dedupe.release(outcome.notificationId)
            throw new AppError('SERVICE_UNAVAILABLE')
          }
          return reply.status(202).send({ status: 'accepted' })
        }
      }
    },
  })
}
