// Property: one Square payment never lands on two invoices and is never recorded twice, whatever arrives at once (ADR 0171 D6):
// the webhook's event job, the Events API catch-up, the nightly reconcile, the matching job and a person applying it from the queue
// (to the same or another invoice), racing on real Postgres connections.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { runSquareCatchup } from '../../src/modules/square/catchup.js'
import { processLoggedEvent, squareWebhookLog } from '../../src/modules/square/events.js'
import { factsOfRow } from '../../src/modules/square/facts.js'
import { runSquareMatching } from '../../src/modules/square/match-runner.js'
import { applySquarePayment, lockPayment } from '../../src/modules/square/payments.js'
import { runSquareReconcile } from '../../src/modules/square/reconcile.js'
import { squareIngest } from '../../src/modules/square/runtime.js'
import { transaction } from '../../src/platform/db.js'
import { AppError } from '../../src/platform/errors.js'
import { truncateAll, useTestDb } from '../helpers/db.js'
import { coreRig, silent, useCoreRuntime } from './core.js'

describe('one payment, many arrivals', () => {
  const t = useTestDb({ poolMax: 12 })
  useCoreRuntime()

  it('is recorded at most once, on one invoice, by whichever path wins', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          named: fc.boolean(),
          entry: fc.boolean(),
          tip: fc.constantFrom(0, 500),
          manual: fc.constantFrom('none', 'same', 'other'),
          paths: fc.shuffledSubarray(['webhook', 'webhook2', 'catchup', 'reconcile', 'match'] as const, { minLength: 2 }),
        }),
        async (s) => {
          await truncateAll(t.db)
          const r = await coreRig(t)
          const a = await r.openInvoice()
          const b = await r.openInvoice()
          if (s.entry) await r.staffCard(a, 4280)
          const p = r.posPayment({ amountCents: 4280, tipCents: s.tip, ...(s.named ? { note: `INV-${a.no}` } : {}) })
          const ev = r.sim.store.events.find((e) => e.type === 'payment.updated' && e.data.id === p.id)!
          const log = squareWebhookLog(t.db, r.newId)
          await log.claim(ev.event_id, r.clock.now(), { headers: { source: 'webhook' }, body: JSON.stringify(ev) })
          const d = { db: t.db, clock: r.clock, logger: silent, env: r.env, api: r.sim.api, ingest: squareIngest(), newId: r.newId }
          const job = { ...d, locationId: r.pe.locationId }
          const run = (path: (typeof s.paths)[number]): Promise<unknown> => {
            switch (path) {
              case 'webhook':
              case 'webhook2':
                return processLoggedEvent(d, ev.event_id).catch(() => null)
              case 'catchup':
                return runSquareCatchup(d, { force: true })
              case 'reconcile':
                return runSquareReconcile(d, { force: true })
              case 'match':
                return runSquareMatching(job)
            }
          }
          const manual = async (): Promise<unknown> => {
            if (s.manual === 'none') return null
            try {
              return await transaction(t.db, async (tx) => {
                await lockPayment(tx, p.id)
                const row = await tx.selectFrom('square_payments').selectAll().where('square_payment_id', '=', p.id).executeTakeFirst()
                if (!row) return null
                return applySquarePayment(tx, r.deps, factsOfRow(row), { invoiceId: s.manual === 'same' ? a.id : b.id, actor: { name: 'Rafael M.' } })
              })
            } catch (e) {
              if (e instanceof AppError) return null
              throw e
            }
          }
          await Promise.all([...s.paths.map(run), manual()])
          const live = await r.livePays(p.id)
          expect(live.length).toBeLessThanOrEqual(1)
          const m = await r.mirror(p.id)
          if (live.length === 1) {
            expect(m).toMatchObject({ match_state: 'matched', invoice_id: live[0]!.invoice_id, event_id: live[0]!.id })
            const tips = await t.db.selectFrom('ledger_events').select(['invoice_id', 'amount_cents']).where('idempotency_key', '=', `square:tip:${p.id}`).execute()
            expect(tips).toEqual(s.tip ? [{ invoice_id: live[0]!.invoice_id, amount_cents: s.tip }] : [])
          } else expect(m?.match_state).not.toBe('matched')
          // the money: never more than one payment's worth across both invoices
          const paid = (await r.calc(a.id)).paidOrig + (await r.calc(b.id)).paidOrig
          expect(paid).toBeLessThanOrEqual(4280 + s.tip + (s.entry ? 4280 : 0))
          if (s.entry && live.length === 1 && live[0]!.invoice_id === a.id) expect((await r.calc(a.id)).paidOrig).toBe(4280 + s.tip)
        },
      ),
      { numRuns: 25 },
    )
  }, 240_000)
})
