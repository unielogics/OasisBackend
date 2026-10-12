import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { wire } from '../wire.js'

/** ListLocations, RetrieveLocation. */
export const locationsApi = (c: SquareClient): SquareApi['locations'] => ({
  list: async () => (await c.request({ method: 'GET', path: '/v2/locations', schema: wire.locations })).locations,
  retrieve: async (id) =>
    (await c.request({ method: 'GET', path: `/v2/locations/${enc(id)}`, schema: wire.location })).location,
})

export const enc = encodeURIComponent
