// Pure store-credit allocation (review B1) and the lag-scan job.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import {
  allocateFifo,
  creditBalance,
  fifoOrder,
  isExpired,
  usableLots,
  type CreditLot,
} from '../../src/modules/payments/credit.js'
import { scanProcessorLag } from '../../src/modules/payments/jobs.js'
import { useTestDb } from '../helpers/db.js'
import { addEvent, makeInvoice, setupEnv } from './helpers.js'

const D = 24 * 3600 * 1000
const T0 = new Date('2026-06-13T10:36:00-04:00')
const at = (days: number): Date => new Date(T0.getTime() + days * D)
const lot = (id: string, cents: number, o: Partial<CreditLot> = {}): CreditLot => ({
  id,
  invoiceId: 'i',
  kind: 'issue',
  cents,
  expiresAt: null,
  effectiveAt: T0,
  allocated: 0,
  reason: null,
  ...o,
})

describe('credit lots', () => {
  it('orders by earliest expiry with no-expiry last, then by issue time', () => {
    const a = lot('a', 100, { expiresAt: at(90) })
    const b = lot('b', 100)
    const c = lot('c', 100, { expiresAt: at(30) })
    const d = lot('d', 100, { effectiveAt: at(-1) })
    expect(fifoOrder([a, b, c, d]).map((l) => l.id)).toEqual(['c', 'a', 'd', 'b'])
  })

  it('backend vector: issue 25 (30d) and 20 (no expiry); apply 30 takes the 25 lot then 5 of the 20', () => {
    const lots = [lot('A', 2500, { expiresAt: at(30) }), lot('B', 2000)]
    expect(allocateFifo(lots, T0, 3000)).toEqual([
      { lotId: 'A', cents: 2500 },
      { lotId: 'B', cents: 500 },
    ])
    const after = [lot('A', 2500, { expiresAt: at(30), allocated: 2500 }), lot('B', 2000, { allocated: 500 })]
    expect(creditBalance(after, at(1))).toBe(1500)
    // 31 days later the 25 lot is expired; its remainder (none here) is excluded and B still counts
    expect(creditBalance(after, at(31))).toBe(1500)
    expect(
      creditBalance([lot('A', 2500, { expiresAt: at(30), allocated: 1000 }), lot('B', 2000)], at(31)),
    ).toBe(2000)
  })

  it('review B1: apply 10 on day 10, then 10 on day 40 once lot A has expired, takes lot B', () => {
    const lots = [lot('A', 2500, { expiresAt: at(30) }), lot('B', 2000)]
    expect(allocateFifo(lots, at(10), 1000)).toEqual([{ lotId: 'A', cents: 1000 }])
    const afterFirst = [lot('A', 2500, { expiresAt: at(30), allocated: 1000 }), lot('B', 2000)]
    expect(isExpired(afterFirst[0]!, at(40))).toBe(true)
    expect(allocateFifo(afterFirst, at(40), 1000)).toEqual([{ lotId: 'B', cents: 1000 }])
    expect(creditBalance(afterFirst, at(40))).toBe(2000)
  })

  it('a lot expires at its expiry instant, and a lot not yet effective is not usable', () => {
    const l = lot('A', 100, { expiresAt: at(1) })
    expect(isExpired(l, new Date(at(1).getTime() - 1))).toBe(false)
    expect(isExpired(l, at(1))).toBe(true)
    expect(usableLots([lot('F', 100, { effectiveAt: at(1) })], T0)).toEqual([])
  })

  it('asking for more than the usable balance throws', () => {
    expect(() => allocateFifo([lot('A', 100)], T0, 101)).toThrow(RangeError)
  })
})

describe('payments.lag-scan', () => {
  const t = useTestDb()
  it('publishes reconciliation.stale for locations with card money waiting more than 2 hours, and nothing otherwise', async () => {
    const env = await setupEnv(t)
    expect((await scanProcessorLag(t.db, t.clock)).alerts).toEqual([])
    const inv = await makeInvoice(t.db, env)
    const now = t.clock.now()
    await addEvent(t.db, env, inv, {
      type: 'pay',
      amountCents: 16478,
      method: 'Visa',
      methodKind: 'card',
      processorState: 'awaiting_processor',
      at: new Date(now.getTime() - 150 * 60_000),
    })
    const res = await scanProcessorLag(t.db, t.clock)
    expect(res.alerts).toEqual([{ locationId: env.locationId, count: 1, cents: 16478, oldestMinutes: 150 }])
    const rt = await sql<{
      type: string
      payload: Record<string, number>
    }>`select type, payload from realtime_events where channel = 'payments'`.execute(t.db)
    expect(rt.rows).toEqual([
      { type: 'reconciliation.stale', payload: { count: 1, cents: 16478, oldestMinutes: 150 } },
    ])
  })
})
