// Randomized command sequences over HTTP + Postgres against an independent oracle (see model.ts). Every step is checked for
// the right outcome (status code, amounts, pending vs done) and then for the global invariants: calc equals the oracle to the
// cent, no over-refund, FIFO store credit, append-only ledger, approver rules, cash-basis revenue.
// RV_SEEDS="1,2,3" RV_STEPS=60 RV_STRICT=1 npx vitest run test/review-money/90-model-based.test.ts
import { describe, it } from 'vitest'
import { usePayHarness } from './pay-harness.js'
import { Model } from './model.js'

const p = usePayHarness({ RATE_LIMIT_PER_MIN: '1000000' })
const seeds = (process.env.RV_SEEDS ?? '1,2,3,4,5,6').split(',').map(Number)
const steps = Number(process.env.RV_STEPS ?? 45)

describe('model-based money commands', () => {
  for (const seed of seeds) {
    it(`seed ${seed}`, async () => {
      const m = new Model(p, seed)
      await m.setup()
      try {
        for (let i = 0; i < steps; i++) await m.step()
        if (process.env.RV_TRACE === '1') console.log(m.trace.join('\n'))
      } catch (e) {
        const err = e as Error
        err.message = `${err.message}\n--- trace (seed ${seed})\n${m.trace.slice(-40).join('\n')}`
        throw err
      }
    }, 300_000)
  }
})
