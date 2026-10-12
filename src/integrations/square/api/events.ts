import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { wire } from '../wire.js'

/** SearchEvents (read, ascending by creation), EnableEvents and DisableEvents (setup), ListEventTypes. */
export const eventsApi = (c: SquareClient): SquareApi['events'] => ({
  search: async (q) => {
    const filter: Record<string, unknown> = {}
    if (q.event_types?.length) filter.event_types = q.event_types
    if (q.location_ids?.length) filter.location_ids = q.location_ids
    if (q.merchant_ids?.length) filter.merchant_ids = q.merchant_ids
    if (q.start_at || q.end_at)
      filter.created_at = { ...(q.start_at ? { start_at: q.start_at } : {}), ...(q.end_at ? { end_at: q.end_at } : {}) }
    const r = await c.request({
      method: 'POST',
      path: '/v2/events',
      body: {
        ...(q.cursor ? { cursor: q.cursor } : {}),
        limit: q.limit ?? 100,
        query: { filter, sort: { sort_field: 'DEFAULT', order: 'ASC' } },
      },
      readOnly: true,
      schema: wire.events,
    })
    return { items: r.events, cursor: r.cursor ?? undefined }
  },
  enable: async () => {
    await c.request({ method: 'PUT', path: '/v2/events/enable', setup: true, schema: wire.empty })
  },
  disable: async () => {
    await c.request({ method: 'PUT', path: '/v2/events/disable', setup: true, schema: wire.empty })
  },
  listTypes: async (apiVersion) =>
    (await c.request({ method: 'GET', path: '/v2/events/types', query: { api_version: apiVersion }, schema: wire.eventTypes }))
      .event_types,
})
