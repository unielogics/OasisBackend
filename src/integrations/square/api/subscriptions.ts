import type { SquareApi } from '../../ports/square.js'
import type { AlreadyDone, SquareClient } from '../client.js'
import { wire } from '../wire.js'
import { enc } from './locations.js'

/**
 * CreateSubscription (keyed), RetrieveSubscription, SearchSubscriptions (read), UpdateSubscription, Pause/Resume/Cancel/SwapPlan,
 * BulkSwapPlan, DeleteSubscriptionAction. Pause, Resume, Cancel and Swap carry no idempotency key: they are repeated only when the
 * request surely never left (client.ts), and the "already" codes Square answers to a repeat count as done.
 */
export const subscriptionsApi = (c: SquareClient): SquareApi['subscriptions'] => {
  const action = async (path: string, body: Record<string, unknown> | undefined, alreadyDone?: readonly AlreadyDone[]) => {
    const r = alreadyDone
      ? await c.request({ method: 'POST', path, body, schema: wire.subscription, alreadyDone })
      : await c.request({ method: 'POST', path, body, schema: wire.subscription })
    return r ? { subscription: r.subscription, actions: r.actions ?? [] } : null
  }
  return {
    create: async (key, input) =>
      (
        await c.request({
          method: 'POST',
          path: '/v2/subscriptions',
          body: { idempotency_key: key, ...input },
          idempotencyKey: key,
          schema: wire.subscription,
        })
      ).subscription,
    retrieve: async (id, o = {}) => {
      const r = await c.request({
        method: 'GET',
        path: `/v2/subscriptions/${enc(id)}`,
        query: o.includeActions ? { include: 'actions' } : undefined,
        schema: wire.subscription,
      })
      return { ...r.subscription, ...(r.subscription.actions ? {} : r.actions ? { actions: r.actions } : {}) }
    },
    search: async (q) => {
      const filter: Record<string, unknown> = {}
      if (q.customer_ids) filter.customer_ids = q.customer_ids
      if (q.location_ids) filter.location_ids = q.location_ids
      const r = await c.request({
        method: 'POST',
        path: '/v2/subscriptions/search',
        body: { query: { filter }, ...(q.cursor ? { cursor: q.cursor } : {}), limit: q.limit ?? 100 },
        readOnly: true,
        schema: wire.subscriptions,
      })
      return { items: r.subscriptions, cursor: r.cursor ?? undefined }
    },
    update: async (id, subscription) =>
      (await c.request({ method: 'PUT', path: `/v2/subscriptions/${enc(id)}`, body: { subscription }, schema: wire.subscription }))
        .subscription,
    pause: async (id, input = {}) => (await action(`/v2/subscriptions/${enc(id)}/pause`, input))!,
    resume: async (id, input = {}) => (await action(`/v2/subscriptions/${enc(id)}/resume`, input))!,
    // the sandbox answers a repeated cancel with BAD_REQUEST "... already has a pending cancel date of ..." (2026-10-12)
    cancel: (id) =>
      action(`/v2/subscriptions/${enc(id)}/cancel`, undefined, [
        { code: 'BAD_REQUEST', detail: /already has a pending cancel date|is already (CANCELED|DEACTIVATED)/i },
      ]),
    swapPlan: async (id, input) => (await action(`/v2/subscriptions/${enc(id)}/swap-plan`, input))!,
    bulkSwapPlan: async (input) =>
      (await c.request({ method: 'POST', path: '/v2/subscriptions/bulk-swap-plan', body: { ...input }, schema: wire.bulkSwap }))
        .affected_subscriptions ?? 0,
    deleteAction: async (id, actionId) =>
      (
        await c.request({
          method: 'DELETE',
          path: `/v2/subscriptions/${enc(id)}/actions/${enc(actionId)}`,
          schema: wire.subscription,
          alreadyDone: ['NOT_FOUND'],
        })
      )?.subscription ?? null,
  }
}
