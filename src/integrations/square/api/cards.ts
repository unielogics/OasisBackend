import type { SquareApi } from '../../ports/square.js'
import type { SquareClient } from '../client.js'
import { wire } from '../wire.js'
import { enc } from './locations.js'

/** CreateCard (keyed), RetrieveCard, ListCards, DisableCard (an already disabled card is answered with the card). */
export const cardsApi = (c: SquareClient): SquareApi['cards'] => ({
  create: async (key, input) =>
    (
      await c.request({
        method: 'POST',
        path: '/v2/cards',
        body: { idempotency_key: key, ...input },
        idempotencyKey: key,
        schema: wire.card,
      })
    ).card,
  retrieve: async (id) => (await c.request({ method: 'GET', path: `/v2/cards/${enc(id)}`, schema: wire.card })).card,
  list: async (q = {}) => {
    const r = await c.request({ method: 'GET', path: '/v2/cards', query: { ...q }, schema: wire.cards })
    return { items: r.cards, cursor: r.cursor ?? undefined }
  },
  disable: async (id) =>
    (await c.request({ method: 'POST', path: `/v2/cards/${enc(id)}/disable`, schema: wire.card, alreadyDone: ['NOT_FOUND'] }))
      ?.card ?? null,
})
