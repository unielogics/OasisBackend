// PUBLIC_WRITES_ENABLED=false (the production default until online booking opens): the four public POSTs answer the same
// 404 as an unknown route, before validation and before any limit or record, while the reads keep working.
import { describe, expect, it } from 'vitest'
import { bookingBody, json, usePublicHarness } from './harness.js'

const h = usePublicHarness({ env: { PUBLIC_WRITES_ENABLED: 'false' } })

describe('public writes closed', () => {
  it('answers 404 ROUTE_NOT_FOUND on otp, otp/verify, bookings and memberships, whatever the body', async () => {
    const count = async () =>
      Number(
        (
          await h.db
            .selectFrom('appointments')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .executeTakeFirstOrThrow()
        ).n,
      )
    const before = await count()
    for (const [path, body] of [
      ['public/otp', { phone: '+12015550106' }],
      ['public/otp/verify', { challengeId: 'x', code: '123456' }],
      ['public/bookings', bookingBody(h)],
      ['public/memberships', { tier: 'gold' }],
      ['public/bookings', { nonsense: true }],
    ] as const) {
      const r = await h.post(path, body)
      expect(r.statusCode, `${path} ${r.body}`).toBe(404)
      expect(json(r)).toMatchObject({ code: 'ROUTE_NOT_FOUND', status: 404 })
    }
    expect(await count()).toBe(before)
  })

  it('keeps hours, availability and the catalog readable', async () => {
    for (const path of ['public/hours', 'public/availability', 'public/catalog'])
      expect((await h.get(path)).statusCode, path).toBe(200)
  })
})
