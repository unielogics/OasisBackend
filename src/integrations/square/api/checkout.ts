import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { wire } from '../wire.js'
import { enc } from './locations.js'

/** CreatePaymentLink (keyed), RetrievePaymentLink, ListPaymentLinks, UpdatePaymentLink, DeletePaymentLink (404 = already gone). */
export const checkoutApi = (c: SquareClient): SquareApi['checkout'] => ({
  createLink: async (key, input) => {
    const r = await c.request({
      method: 'POST',
      path: '/v2/online-checkout/payment-links',
      body: { idempotency_key: key, ...input },
      idempotencyKey: key,
      schema: wire.paymentLink,
    })
    const order = r.related_resources?.orders?.[0]
    return { link: r.payment_link, ...(order ? { order } : {}) }
  },
  retrieveLink: async (id) =>
    (await c.request({ method: 'GET', path: `/v2/online-checkout/payment-links/${enc(id)}`, schema: wire.paymentLink }))
      .payment_link,
  listLinks: async (q = {}) => {
    const r = await c.request({ method: 'GET', path: '/v2/online-checkout/payment-links', query: { ...q }, schema: wire.paymentLinks })
    return { items: r.payment_links, cursor: r.cursor ?? undefined }
  },
  updateLink: async (id, link) =>
    (
      await c.request({
        method: 'PUT',
        path: `/v2/online-checkout/payment-links/${enc(id)}`,
        body: { payment_link: link },
        schema: wire.paymentLink,
      })
    ).payment_link,
  deleteLink: async (id) =>
    (await c.request({
      method: 'DELETE',
      path: `/v2/online-checkout/payment-links/${enc(id)}`,
      schema: wire.deletedPaymentLink,
      alreadyDone: ['NOT_FOUND'],
    })) !== null,
})
