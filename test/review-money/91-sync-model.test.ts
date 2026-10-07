// Randomized interleavings of staff entries, Squarespace orders/refunds, polls, webhooks and the manual queue against a
// ground truth: each real Squarespace payment or refund appears in the Oasis ledger at most once.
// RV_SEEDS="1,2,3" RV_STEPS=40 npx vitest run test/review-money/91-sync-model.test.ts
import { describe, it } from 'vitest'
import { useRig } from '../payments-sync-db/harness.js'
import { SyncModel } from './sync-model.js'

describe('sync model', () => {
  const rig = useRig({ pageSize: 50 })
  const seeds = (process.env.RV_SEEDS ?? '1,2,3,4,5,6').split(',').map(Number)
  const steps = Number(process.env.RV_STEPS ?? 30)
  for (const seed of seeds) {
    it(`seed ${seed}`, async () => {
      const m = new SyncModel(rig, seed)
      await m.setup()
      try {
        for (let i = 0; i < steps; i++) await m.step()
      } catch (e) {
        const err = e as Error
        err.message = `${err.message}\n--- trace (seed ${seed})\n${m.trace.slice(-40).join('\n')}`
        throw err
      }
    }, 300_000)
  }
})
