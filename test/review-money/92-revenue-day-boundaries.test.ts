// Held invariant: the cash-basis revenue of a business day (the Operations "Revenue today" tile) is exactly the sum of the pay,
// void and non-credit refund events whose instant falls in that America/New_York calendar day, including the 25-hour
// fall-back day and the 23-hour spring-forward day, to the millisecond. Refunds count when they were resolved.
import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { ledgerRevenueSource } from '../../src/modules/payments/revenue.js'
import { bizDayBounds } from '../../src/platform/time.js'
import { useTestDb } from '../helpers/db.js'
import { addEvent, makeInvoice, setupEnv } from '../payments/helpers.js'

const t = useTestDb()
const TZ = 'America/New_York'
const dayOf = (d: Date): string => DateTime.fromJSDate(d, { zone: TZ }).toISODate()!

describe('revenue by business day', () => {
  for (const [label, day, instants] of [
    [
      'fall-back day (25 h)',
      '2026-11-01',
      [
        '2026-11-01T03:59:59.999Z',
        '2026-11-01T04:00:00.000Z',
        '2026-11-01T05:30:00Z',
        '2026-11-01T06:30:00Z',
        '2026-11-02T04:59:59.999Z',
        '2026-11-02T05:00:00.000Z',
      ],
    ],
    [
      'spring-forward day (23 h)',
      '2026-03-08',
      [
        '2026-03-08T04:59:59.999Z',
        '2026-03-08T05:00:00.000Z',
        '2026-03-08T06:59:00Z',
        '2026-03-08T07:00:00Z',
        '2026-03-09T03:59:59.999Z',
        '2026-03-09T04:00:00.000Z',
      ],
    ],
  ] as const) {
    it(`${label}: the sum of events inside the day, nothing from its neighbours`, async () => {
      const env = await setupEnv(t)
      const inv = await makeInvoice(t.db, env, { items: [{ name: 'Wash', priceCents: 1_000_000 }] })
      let want = 0
      let amount = 100
      for (const iso of instants) {
        const at = new Date(iso)
        await addEvent(t.db, env, inv, {
          type: 'pay',
          amountCents: amount,
          method: 'Cash',
          methodKind: 'cash',
          at,
        })
        if (dayOf(at) === day) want += amount
        amount *= 3
      }
      // a refund counts at its resolution time, a store-credit refund never counts, a void takes the payment back when voided
      const rAt = new Date(instants[2])
      await addEvent(t.db, env, inv, {
        type: 'refund',
        amountCents: 7,
        dest: 'cash',
        status: 'done',
        method: 'Cash',
        at: rAt,
      })
      want -= 7
      await addEvent(t.db, env, inv, {
        type: 'refund',
        amountCents: 11,
        dest: 'credit',
        status: 'done',
        method: 'Store credit',
        at: rAt,
      })
      const { start, end } = bizDayBounds(day, TZ)
      expect(await ledgerRevenueSource.revenueCents(t.db, env.locationId, start, end)).toBe(want)
      // the day length is what the calendar says
      expect((end.getTime() - start.getTime()) / 3_600_000).toBe(label.includes('25') ? 25 : 23)
    })
  }
})
