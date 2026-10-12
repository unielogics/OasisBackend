import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { wire } from '../wire.js'
import { enc } from './locations.js'

/** GetInvoice, SearchInvoices (read). */
export const invoicesApi = (c: SquareClient): SquareApi['invoices'] => ({
  get: async (id) => (await c.request({ method: 'GET', path: `/v2/invoices/${enc(id)}`, schema: wire.invoice })).invoice,
  search: async (q) => {
    const filter: Record<string, unknown> = { location_ids: q.location_ids }
    if (q.customer_ids) filter.customer_ids = q.customer_ids
    const r = await c.request({
      method: 'POST',
      path: '/v2/invoices/search',
      body: { query: { filter }, ...(q.cursor ? { cursor: q.cursor } : {}), limit: q.limit ?? 100 },
      readOnly: true,
      schema: wire.invoices,
    })
    return { items: r.invoices, cursor: r.cursor ?? undefined }
  },
})
