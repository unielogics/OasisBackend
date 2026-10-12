import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { wire } from '../wire.js'
import { enc } from './locations.js'

/** RefundPayment (keyed), GetPaymentRefund, ListPaymentRefunds. */
export const refundsApi = (c: SquareClient): SquareApi['refunds'] => ({
  refund: async (key, input) =>
    (
      await c.request({
        method: 'POST',
        path: '/v2/refunds',
        body: { idempotency_key: key, ...input },
        idempotencyKey: key,
        schema: wire.refund,
      })
    ).refund,
  get: async (id) => (await c.request({ method: 'GET', path: `/v2/refunds/${enc(id)}`, schema: wire.refund })).refund,
  list: async (q = {}) => {
    const r = await c.request({ method: 'GET', path: '/v2/refunds', query: { ...q }, schema: wire.refunds })
    return { items: r.refunds, cursor: r.cursor ?? undefined }
  },
})
