// Review finding 10: when Squarespace says hasNextPage but hands over no cursor, the client reports "no more pages". The sync
// engine then stores the watermark at the end of the window and the unread rest of the window is never read again by the poll
// (only the nightly reconcile could notice). A missing cursor on a page that claims a next page must be an error, not an end.
import { describe, expect, it } from 'vitest'
import { clientFor, rig, WINDOW } from '../integrations/squarespace/helpers.js'

describe('a list page that claims a next page without a cursor', () => {
  it('is not taken for the last page', async () => {
    const r = rig()
    const body = {
      result: [],
      pagination: { hasNextPage: true, nextPageCursor: null, nextPageUrl: 'https://api.squarespace.com/1.0/commerce/orders?cursor=abc123' },
    }
    const fetchStub = (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const client = clientFor(r, { fetch: fetchStub })
    const outcome = await client.listOrders(WINDOW).then(
      (page) => ({ page }),
      (error: unknown) => ({ error }),
    )
    if ('page' in outcome) expect(outcome.page.nextCursor, 'the page said there is more').toBeDefined()
    else expect(outcome.error).toBeInstanceOf(Error)
  })
})
