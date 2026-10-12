import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { wire } from '../wire.js'
import { enc } from './locations.js'

/** ListWebhookSubscriptions, CreateWebhookSubscription (keyed), UpdateWebhookSubscription, TestWebhookSubscription,
 *  ListWebhookEventTypes, UpdateWebhookSubscriptionSignatureKey (keyed). All setup: allowed when observe-only. */
export const webhooksApi = (c: SquareClient): SquareApi['webhooks'] => ({
  list: async (q = {}) => {
    const r = await c.request({ method: 'GET', path: '/v2/webhooks/subscriptions', query: { ...q }, schema: wire.webhookSubscriptions })
    return { items: r.subscriptions, cursor: r.cursor ?? undefined }
  },
  create: async (key, input) =>
    (
      await c.request({
        method: 'POST',
        path: '/v2/webhooks/subscriptions',
        body: { idempotency_key: key, subscription: input },
        idempotencyKey: key,
        setup: true,
        schema: wire.webhookSubscription,
      })
    ).subscription,
  update: async (id, input) =>
    (
      await c.request({
        method: 'PUT',
        path: `/v2/webhooks/subscriptions/${enc(id)}`,
        body: { subscription: input },
        setup: true,
        schema: wire.webhookSubscription,
      })
    ).subscription,
  test: async (id, eventType) =>
    (
      await c.request({
        method: 'POST',
        path: `/v2/webhooks/subscriptions/${enc(id)}/test`,
        body: eventType ? { event_type: eventType } : {},
        setup: true,
        schema: wire.webhookTest,
      })
    ).subscription_test_result,
  listEventTypes: async (apiVersion) =>
    (await c.request({ method: 'GET', path: '/v2/webhooks/event-types', query: { api_version: apiVersion }, schema: wire.eventTypes }))
      .event_types,
  rotateSignatureKey: async (key, id) =>
    (
      await c.request({
        method: 'POST',
        path: `/v2/webhooks/subscriptions/${enc(id)}/signature-key`,
        body: { idempotency_key: key },
        idempotencyKey: key,
        setup: true,
        schema: wire.signatureKey,
      })
    ).signature_key,
})
