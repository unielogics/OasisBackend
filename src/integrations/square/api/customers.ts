import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { wire } from '../wire.js'
import { enc } from './locations.js'

/** SearchCustomers (read), CreateCustomer (keyed), UpdateCustomer, RetrieveCustomer, DeleteCustomer (404 = already gone). */
export const customersApi = (c: SquareClient): SquareApi['customers'] => ({
  search: async (q) => {
    const filter: Record<string, unknown> = {}
    if (q.reference_id) filter.reference_id = { exact: q.reference_id }
    if (q.email_address) filter.email_address = { exact: q.email_address }
    if (q.phone_number) filter.phone_number = { exact: q.phone_number }
    const r = await c.request({
      method: 'POST',
      path: '/v2/customers/search',
      body: { query: { filter }, ...(q.cursor ? { cursor: q.cursor } : {}), limit: q.limit ?? 100 },
      readOnly: true,
      schema: wire.customers,
    })
    return { items: r.customers, cursor: r.cursor ?? undefined }
  },
  create: async (key, input) =>
    (
      await c.request({
        method: 'POST',
        path: '/v2/customers',
        body: { idempotency_key: key, ...input },
        idempotencyKey: key,
        schema: wire.customer,
      })
    ).customer,
  update: async (id, input) =>
    (await c.request({ method: 'PUT', path: `/v2/customers/${enc(id)}`, body: { ...input }, schema: wire.customer })).customer,
  retrieve: async (id) =>
    (await c.request({ method: 'GET', path: `/v2/customers/${enc(id)}`, schema: wire.customer })).customer,
  delete: async (id) =>
    (await c.request({ method: 'DELETE', path: `/v2/customers/${enc(id)}`, schema: wire.empty, alreadyDone: ['NOT_FOUND'] })) !==
    null,
})
