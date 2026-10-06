// Two modules may define the same problem code, but only with identical copy; otherwise whichever loads second throws at
// boot. Load every module in both orders (fresh module graphs) and fail on any conflict.
import { describe, expect, it, vi } from 'vitest'

const orders: string[][] = [
  ['../../src/modules/scheduling/problems.js', '../../src/modules/payments/problems.js'],
  ['../../src/modules/payments/problems.js', '../../src/modules/scheduling/problems.js'],
]

describe('problem code registrations', () => {
  for (const order of orders) {
    it(`load without conflict in the order ${order.map((o) => o.split('/').at(-2)).join(' then ')}`, async () => {
      vi.resetModules()
      for (const m of order) await import(m)
      const { problemDef } = await import('../../src/platform/errors.js')
      expect(problemDef('ADDON_REMOVE_OVERPAID')).toMatchObject({ status: 409, title: 'Can’t remove add-on' })
    })
  }

  it('the whole production module graph loads', async () => {
    vi.resetModules()
    await expect(import('../../src/http/modules.js')).resolves.toBeDefined()
  })
})
