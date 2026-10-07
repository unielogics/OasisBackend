// Review finding 15: manualIgnore refuses an order whose money is already on an invoice, but it checks sqsp_matches without
// locking the order, so an ignore that starts while a manual match of the same order is still uncommitted passes the check,
// waits for the match to commit and then overwrites its state: the order reads "ignored" while its payment is on the invoice
// (the matcher then marks the order's remaining transactions ignored as well).
import { describe, expect, it } from 'vitest'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { SqspLedgerOps } from '../../src/modules/payments-sync/db/ledger.js'
import { manualIgnore, manualMatch } from '../../src/modules/payments-sync/db/manual.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { useRig } from '../payments-sync-db/harness.js'
import { makeUser } from './helpers.js'

describe('manual ignore versus manual match of the same order', () => {
  const rig = useRig({ pageSize: 50 })

  it('an order whose payment was just matched is not left ignored', async () => {
    const r = rig()
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [
        { sku: 'DET-SEDAN', kind: 'service' },
      ]),
    )
    const customerId = await makeCustomer(r.db, env, {
      name: 'Liam Chen',
      email: 'liam@example.com',
      phone: '+13055550142',
    })
    const inv = await makeInvoice(r.db, env, {
      customerId,
      items: [{ name: 'Full Detail', priceCents: 18900 }],
    })
    const order = r.store.createOrder({
      email: 'someone.else@example.com',
      name: 'Liam Chen',
      phone: '7865550199',
      lineItems: [{ productId: 'p', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900 }],
      taxCents: 1323,
    })
    r.advance(120_000)
    await r.rt.syncCycle(r.locationId)
    expect(
      await r.db.selectFrom('sqsp_manual_queue').select('id').where('state', '=', 'open').execute(),
    ).toHaveLength(1)

    const user = await makeUser(r.db, r.newId, 'Rafael')
    const actor = { userId: user.userId, employeeId: user.employeeId, name: user.name }
    const deps = {
      locationId: r.locationId,
      clock: r.clock,
      newId: r.newId,
      ops: new SqspLedgerOps({ locationId: r.locationId, clock: r.clock, newId: r.newId }),
      varianceAlertCents: 100,
    }
    let ignoreOutcome = 'pending'
    let ignore: Promise<void> = Promise.resolve()
    await transaction(r.db, async (tx) => {
      await manualMatch(tx, deps, { orderId: order.orderId, invoiceId: inv.id }, actor)
      // a second person clicks Ignore while the match is not committed yet
      ignore = transaction(r.db, (tx2) => manualIgnore(tx2, deps, { orderId: order.orderId }, actor)).then(
        () => {
          ignoreOutcome = 'ignored'
        },
        (e: { code?: string }) => {
          ignoreOutcome = e.code ?? 'error'
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    await ignore

    const state = await r.db.selectFrom('sqsp_orders').select('match_state').executeTakeFirstOrThrow()
    const pays = await r.db
      .selectFrom('ledger_events')
      .select('id')
      .where('invoice_id', '=', inv.id)
      .where('type', '=', 'pay')
      .execute()
    expect(pays, 'the match booked the payment').toHaveLength(1)
    expect(state.match_state, `ignore answered ${ignoreOutcome}`).not.toBe('ignored')
  })
})
