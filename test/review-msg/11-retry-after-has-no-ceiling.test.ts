// Review finding 11: a 429 is waited out for whatever Retry-After says, and the wait is a cool down on the process-wide
// limiter, so every other Squarespace call in the process (Sync now, the webhook job) waits as well. The documented cool down is
// one minute; an hours-long header (or a proxy's) pins the sync job past its 15-minute expiry and blocks the process.
import { describe, expect, it } from 'vitest'
import { clientFor, rig, WINDOW } from '../integrations/squarespace/helpers.js'

describe('a 429 with a very long Retry-After', () => {
  it('fails the call instead of sleeping for hours', async () => {
    const r = rig()
    r.api.injectFailure({ status: 429, times: 1, retryAfterSeconds: 7200 })
    const client = clientFor(r)
    await client.listOrders(WINDOW).catch(() => undefined)
    expect(r.sleeper.totalSleptMs).toBeLessThanOrEqual(10 * 60_000)
  })
})
