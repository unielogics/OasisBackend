import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { wire } from '../wire.js'
import { enc } from './locations.js'

/** RetrieveOrder, BatchRetrieveOrders (a read: repeatable, allowed when observe-only). */
export const ordersApi = (c: SquareClient): SquareApi['orders'] => ({
  retrieve: async (id) => (await c.request({ method: 'GET', path: `/v2/orders/${enc(id)}`, schema: wire.order })).order,
  batchRetrieve: async (locationId, ids) =>
    ids.length === 0
      ? []
      : (
          await c.request({
            method: 'POST',
            path: '/v2/orders/batch-retrieve',
            body: { location_id: locationId, order_ids: ids },
            readOnly: true,
            schema: wire.orders,
          })
        ).orders,
})
