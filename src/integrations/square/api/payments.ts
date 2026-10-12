import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { wire } from '../wire.js'
import { enc } from './locations.js'

/** CreatePayment (keyed), GetPayment, ListPayments, CancelPayment (already canceled counts as done). */
export const paymentsApi = (c: SquareClient): SquareApi['payments'] => ({
  create: async (key, input) =>
    (
      await c.request({
        method: 'POST',
        path: '/v2/payments',
        body: { idempotency_key: key, ...input },
        idempotencyKey: key,
        schema: wire.payment,
      })
    ).payment,
  get: async (id) => (await c.request({ method: 'GET', path: `/v2/payments/${enc(id)}`, schema: wire.payment })).payment,
  list: async (q = {}) => {
    const r = await c.request({ method: 'GET', path: '/v2/payments', query: { ...q }, schema: wire.payments })
    return { items: r.payments, cursor: r.cursor ?? undefined }
  },
  cancel: async (id) =>
    (
      await c.request({
        method: 'POST',
        path: `/v2/payments/${enc(id)}/cancel`,
        schema: wire.payment,
        alreadyDone: ['PAYMENT_NOT_CANCELABLE_ALREADY_CANCELED'],
      })
    )?.payment ?? null,
})
