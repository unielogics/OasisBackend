// Card refunds through the Square API (ADR 0171 D4, design 3.6): the refund ledger row is the outbox; legs newest payment first with
// caps; webhook tracking (and the race with the job); a failed leg makes the refund stop counting (SQL and the TypeScript twin, the
// nightly integrity check agreeing); a refund the Square money cannot cover; refunds made in the Square POS app.
import { describe, expect, it } from 'vitest'
import { actorFromAuth } from '../../src/modules/payments/actor.js'
import { PaymentsService, type CommandContext } from '../../src/modules/payments/commands.js'
import { checkLedgerIntegrity } from '../../src/modules/payments/jobs-integrity.js'
import { defaultPorts } from '../../src/modules/payments/ports.js'
import { productionExternalAlerts } from '../../src/composition.js'
import { sqspExternalAlerts } from '../../src/modules/payments-sync/db/queries.js'
import { AWAITING_ALERT_MINUTES } from '../../src/modules/payments/reports.js'
import { failedSquareRefunds, squareExternalAlerts } from '../../src/modules/square/db/alerts.js'
import { planSquareRefundLegs, runSquareRefunds, submitSquareRefundLegs, type RefundRunReport } from '../../src/modules/square/refunds.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import { transaction } from '../../src/platform/db.js'
import { AppError } from '../../src/platform/errors.js'
import { makeUser } from '../helpers/factories.js'
import { useTestDb } from '../helpers/db.js'
import { coreRig, silent, squareEnvFor, useCoreRuntime, type Rig } from './core.js'

describe('Square refunds', () => {
  const t = useTestDb()
  useCoreRuntime()

  /** An invoice paid in the Square POS app (one payment per amount); `squarespaceCents` adds a card payment finished in Squarespace. */
  async function paidBySquare(r: Rig, amounts: number[] = [4280], o: { squarespaceCents?: number } = {}) {
    const inv = await r.openInvoice({ items: [{ name: 'Detail', priceCents: amounts.reduce((s, a) => s + a, 0) + (o.squarespaceCents ?? 0) }], taxBp: 0 })
    if (o.squarespaceCents) {
      const sqsp = await r.staffCard(inv, o.squarespaceCents)
      await t.db.updateTable('ledger_events').set({ processor_state: 'confirmed', sqsp_order_id: 'sqsp-order-1' }).where('id', '=', sqsp).execute()
    }
    const pays = []
    for (const a of amounts) {
      const p = r.posPayment({ amountCents: a, note: `INV-${inv.no}` })
      expect(await r.decide(p.id)).toBe('matched')
      pays.push(p)
      r.clock.advance(60_000)
    }
    const user = await makeUser(t.db, r.newId, { first: 'Rafael' })
    const ctx = (key: string): CommandContext => ({
      locationId: r.pe.locationId,
      actor: actorFromAuth({ userId: user.userId, employeeId: user.employeeId, locationId: r.pe.locationId, permissions: new Set(['*']), actorName: 'Rafael M.', roles: ['Management'] }),
      audit: { actor: { name: 'Rafael M.' } },
      idempotencyKey: key,
    })
    const service = new PaymentsService({ clock: r.clock, newId: r.newId, ports: defaultPorts() })
    const refund = (amountCents: number, key = `k-${amountCents}`) =>
      transaction(t.db, (tx) => service.refund(tx, ctx(key), inv.id, { mode: 'custom', amountCents, dest: 'card' }))
    const job = { db: t.db, clock: r.clock, newId: r.newId, env: r.env, api: r.sim.api, logger: silent, locationId: r.pe.locationId }
    const legs = (eventId: string) => t.db.selectFrom('square_refund_legs').selectAll().where('ledger_event_id', '=', eventId).orderBy('created_at').execute()
    const event = (id: string) => t.db.selectFrom('ledger_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    const itemIds = (await t.db.selectFrom('invoice_items').select('id').where('invoice_id', '=', inv.id).execute()).map((i) => i.id)
    return { inv, pays, refund, job, legs, event, service, ctx, itemIds }
  }

  it('one leg: sent with its key, tracked by the webhook to completed, the refund confirmed once', async () => {
    const r = await coreRig(t)
    const s = await paidBySquare(r)
    const out = await s.refund(1000)
    const ev = await s.event(out.event.id)
    expect(ev).toMatchObject({ processor: 'square', processor_state: 'awaiting_processor', dest: 'card' })
    expect(await runSquareRefunds(s.job)).toMatchObject({ planned: 1, submitted: 1, failed: 0 })
    const [leg] = await s.legs(ev.id)
    expect(leg).toMatchObject({ square_payment_id: s.pays[0]!.id, amount_cents: 1000, state: 'pending', origin: 'api' })
    expect(leg!.idempotency_key).toBe(sqKey('rf', leg!.id))
    // nothing more to do on a second run
    expect(await runSquareRefunds(s.job)).toMatchObject({ planned: 0, submitted: 0 })
    r.sim.store.advance(5_000)
    expect(await r.ingestRefund(leg!.square_refund_id!)).toMatchObject({ status: 'processed' })
    expect(await s.event(ev.id)).toMatchObject({ processor_state: 'confirmed', processor_ref: leg!.square_refund_id, processor_confirmed_by: 'Square' })
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 1000 })
    // a second delivery changes nothing
    await r.ingestRefund(leg!.square_refund_id!)
    expect((await s.legs(ev.id)).map((l) => l.state)).toEqual(['completed'])
  })

  it('several legs: newest payment first, each capped by what it can still give back', async () => {
    const r = await coreRig(t)
    const s = await paidBySquare(r, [2000, 2280])
    const out = await s.refund(3000)
    await runSquareRefunds(s.job)
    const legs = await s.legs(out.event.id)
    expect(legs.map((l) => [l.square_payment_id, l.amount_cents])).toEqual([
      [s.pays[1]!.id, 2280],
      [s.pays[0]!.id, 720],
    ])
    expect(r.sim.store.refunds.size).toBe(2)
    // a second refund can only use what is left
    const more = await s.refund(1280, 'k-more')
    await runSquareRefunds(s.job)
    expect((await s.legs(more.event.id)).map((l) => [l.square_payment_id, l.amount_cents])).toEqual([[s.pays[0]!.id, 1280]])
    r.sim.store.advance(5_000)
    for (const l of [...legs, ...(await s.legs(more.event.id))]) await r.ingestRefund(l.square_refund_id!)
    expect((await s.event(out.event.id)).processor_state).toBe('confirmed')
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 4280, status: 'refunded' })
  })

  it('a leg Square fails makes the refund stop counting as refunded, in SQL and in the TypeScript twin; the staff are alerted', async () => {
    const r = await coreRig(t)
    const s = await paidBySquare(r)
    const out = await s.refund(1500)
    await runSquareRefunds(s.job)
    const [leg] = await s.legs(out.event.id)
    expect((await r.calc(s.inv.id)).refunded).toBe(1500)
    r.sim.store.failRefund(leg!.square_refund_id!)
    await r.ingestRefund(leg!.square_refund_id!)
    expect(await s.event(out.event.id)).toMatchObject({ processor_state: 'failed' })
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 0, refundable: 4280, status: 'paid' })
    const integrity = await checkLedgerIntegrity(t.db, r.pe.locationId)
    expect(integrity.findings.filter((f) => f.code === 'calc_mismatch')).toEqual([])
    const alerts = await squareExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager: true })
    expect(alerts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'square_refund_failed', tone: 'red', title: expect.stringMatching(/^Card refund failed · /) })]))
    // the money can be refunded again (the failed one reserves nothing)
    const again = await s.refund(1500, 'k-again')
    expect(again.event.amountCents).toBe(1500)
  })

  it('one leg completes and another fails: the part that went back stays refunded, only the rest is failed and alerted', async () => {
    const r = await coreRig(t)
    const s = await paidBySquare(r, [2000, 2280])
    const out = await s.refund(3000)
    await runSquareRefunds(s.job)
    const [big, small] = await s.legs(out.event.id)
    expect([big!.amount_cents, small!.amount_cents]).toEqual([2280, 720])
    r.sim.store.failRefund(small!.square_refund_id!)
    // the failed leg is reported first, while the other is still on its way: nothing is decided yet, the alert already shows
    expect(await r.ingestRefund(small!.square_refund_id!)).toMatchObject({ note: 'refund leg failed; refund waiting' })
    expect((await s.event(out.event.id)).processor_state).toBe('awaiting_processor')
    let alerts = await squareExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager: true })
    expect(alerts.filter((a) => a.kind === 'square_refund_failed').map((a) => a.desc)).toEqual([
      expect.stringMatching(/^\$7\.20 of a \$30\.00 card refund on INV-\d+ did not go back to the card · refund it in cash or store credit$/),
    ])
    r.sim.store.advance(5_000)
    expect(await r.ingestRefund(big!.square_refund_id!)).toMatchObject({ note: 'refund leg completed; refund failed' })
    const ev = await s.event(out.event.id)
    expect(ev.processor_state).toBe('failed')
    const part = await t.db.selectFrom('ledger_events').selectAll().where('parent_event_id', '=', out.event.id).execute()
    expect(part).toEqual([
      expect.objectContaining({
        type: 'refund',
        amount_cents: 2280,
        status: 'done',
        dest: 'card',
        processor: 'square',
        processor_state: 'confirmed',
        processor_ref: big!.square_refund_id,
        idempotency_key: `square:refund-part:${out.event.id}`,
        reason: ev.reason,
      }),
    ])
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 2280, refundable: 2000, status: 'partially_refunded' })
    const integrity = await checkLedgerIntegrity(t.db, r.pe.locationId)
    expect(integrity.findings.filter((f) => f.code === 'calc_mismatch')).toEqual([])
    alerts = await squareExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager: true })
    expect(alerts.filter((a) => a.kind === 'square_refund_failed').map((a) => a.desc)).toEqual([
      expect.stringMatching(/^\$7\.20 of a \$30\.00 card refund on INV-\d+ did not go back to the card · refund it in cash or store credit$/),
    ])
    expect(await failedSquareRefunds(t.db, r.pe.locationId, new Date(0))).toEqual([
      expect.objectContaining({ eventId: out.event.id, amountCents: 3000, refundedCents: 2280, uncoveredCents: 720 }),
    ])
    // a repeat of either webhook changes nothing
    await r.ingestRefund(big!.square_refund_id!)
    await r.ingestRefund(small!.square_refund_id!)
    expect(await t.db.selectFrom('ledger_events').select('id').where('parent_event_id', '=', out.event.id).execute()).toHaveLength(1)
    // the uncovered 7.20 can be given back in cash; Square's 2,000 left on the first payment can still go back to the card
    await transaction(t.db, (tx) => s.service.refund(tx, s.ctx('k-cash'), s.inv.id, { mode: 'custom', amountCents: 720, dest: 'cash' }))
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 3000, refundable: 1280 })
  })

  it('a refund sent to Square cannot be confirmed by hand, and its waiting alert offers no Confirm', async () => {
    const r = await coreRig(t)
    const s = await paidBySquare(r)
    const out = await s.refund(1500)
    await runSquareRefunds(s.job)
    const err = await transaction(t.db, (tx) => s.service.confirmProcessor(tx, s.ctx('k-confirm'), out.event.id)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('REFUND_SENT_TO_SQUARE')
    const [leg] = await s.legs(out.event.id)
    r.sim.store.failRefund(leg!.square_refund_id!)
    r.clock.advance((AWAITING_ALERT_MINUTES + 1) * 60_000)
    const waiting = (await sqspExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager: true })).filter((a) => a.kind === 'awaiting_processor')
    expect(waiting).toEqual([expect.objectContaining({ actionLabel: 'Review', desc: expect.stringMatching(/Square has not confirmed it yet$/) })])
    // Square failed the leg: the refund stops counting and the staff are alerted
    await r.ingestRefund(leg!.square_refund_id!)
    expect(await s.event(out.event.id)).toMatchObject({ processor_state: 'failed' })
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 0 })
    const alerts = await squareExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager: true })
    expect(alerts.filter((a) => a.kind === 'square_refund_failed')).toHaveLength(1)
  })

  it('a Square card refund the job has not sent yet cannot be confirmed by hand either: the job sends it, its alert offers Review', async () => {
    const r = await coreRig(t)
    const s = await paidBySquare(r)
    const out = await s.refund(1500)
    expect(await s.legs(out.event.id)).toEqual([])
    // pressed right after the refund is recorded, before the job's next run: refused, nothing is marked refunded by hand
    const err = await transaction(t.db, (tx) => s.service.confirmProcessor(tx, s.ctx('k-confirm'), out.event.id)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('REFUND_SENT_TO_SQUARE')
    expect((await s.event(out.event.id)).processor_state).toBe('awaiting_processor')
    // a stalled job: the waiting alert (production wiring) offers Review, not Confirm
    r.clock.advance((AWAITING_ALERT_MINUTES + 1) * 60_000)
    const waiting = (await productionExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager: true })).filter((a) => a.kind === 'awaiting_processor')
    expect(waiting).toEqual([expect.objectContaining({ actionLabel: 'Review', desc: expect.stringMatching(/Square has not confirmed it yet$/) })])
    // the job runs: the money really goes back through Square and the refund is confirmed by Square's answer
    expect(await runSquareRefunds(s.job)).toMatchObject({ planned: 1, submitted: 1 })
    const [leg] = await s.legs(out.event.id)
    r.sim.store.advance(5_000)
    await r.ingestRefund(leg!.square_refund_id!)
    expect(await s.event(out.event.id)).toMatchObject({ processor_state: 'confirmed', processor_confirmed_by: 'Square' })
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 1500 })
  })

  it('observe-only: a Square card refund nothing was sent for can still be confirmed by hand', async () => {
    const r = await coreRig(t, { SQUARE_WRITES_ENABLED: 'false' })
    const s = await paidBySquare(r)
    const out = await s.refund(1500)
    expect((await s.event(out.event.id)).processor).toBe('square')
    await runSquareRefunds(s.job)
    r.clock.advance((AWAITING_ALERT_MINUTES + 1) * 60_000)
    const waiting = (await productionExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager: true })).filter((a) => a.kind === 'awaiting_processor')
    expect(waiting).toEqual([expect.objectContaining({ actionLabel: 'Confirm' })])
    const done = await transaction(t.db, (tx) => s.service.confirmProcessor(tx, s.ctx('k-confirm'), out.event.id))
    expect(done.event.id).toBe(out.event.id)
    expect((await s.event(out.event.id)).processor_state).toBe('confirmed')
  })

  it('a card refund confirmed by hand before Square reports the app refund takes that refund instead of counting it twice', async () => {
    const r = await coreRig(t, { PAYMENT_PROCESSOR: 'squarespace' })
    const s = await paidBySquare(r, [4280])
    const staff = await s.refund(1000)
    await transaction(t.db, (tx) => s.service.confirmProcessor(tx, s.ctx('k-confirm'), staff.event.id))
    const pos = await r.sim.api.refunds.refund(sqKey('rf', 'pos-hand'), { payment_id: s.pays[0]!.id, amount_money: usd(1000) })
    r.sim.store.advance(5_000)
    expect(await r.ingestRefund(pos.id)).toMatchObject({ note: expect.stringMatching(/confirmed by hand: attached/) })
    expect(await s.event(staff.event.id)).toMatchObject({ processor_state: 'confirmed', processor: 'square', processor_ref: pos.id, needs_review: false })
    expect(await t.db.selectFrom('ledger_events').select('id').where('idempotency_key', '=', `square:refund:${pos.id}`).execute()).toEqual([])
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 1000 })
    expect((await s.legs(staff.event.id)).map((l) => [l.origin, l.amount_cents, l.square_refund_id])).toEqual([['pos', 1000, pos.id]])
    // a second delivery, and a second app refund of the same amount (real money), which is recorded for review
    await r.ingestRefund(pos.id)
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 1000 })
    const again = await r.sim.api.refunds.refund(sqKey('rf', 'pos-hand-2'), { payment_id: s.pays[0]!.id, amount_money: usd(1000) })
    r.sim.store.advance(5_000)
    expect(await r.ingestRefund(again.id)).toMatchObject({ note: expect.stringMatching(/needs review/) })
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 2000 })
  })

  it('an item refund Square only partly gave back: the items stay claimed, the rest goes back as an amount', async () => {
    const r = await coreRig(t)
    const s = await paidBySquare(r, [2000, 2280])
    const out = await transaction(t.db, (tx) => s.service.refund(tx, s.ctx('k-items'), s.inv.id, { mode: 'items', itemIds: s.itemIds, dest: 'card' }))
    expect(out.event.amountCents).toBe(4280)
    await runSquareRefunds(s.job)
    const [big, small] = await s.legs(out.event.id)
    expect([big!.amount_cents, small!.amount_cents]).toEqual([2280, 2000])
    r.sim.store.failRefund(small!.square_refund_id!)
    r.sim.store.advance(5_000)
    await r.ingestRefund(small!.square_refund_id!)
    await r.ingestRefund(big!.square_refund_id!)
    expect((await s.event(out.event.id)).processor_state).toBe('failed')
    const [part] = await t.db.selectFrom('ledger_events').selectAll().where('parent_event_id', '=', out.event.id).execute()
    expect(part).toMatchObject({ amount_cents: 2280, item_ids: s.itemIds })
    // refunding the items again would give their whole price back a second time (2,280 already went back): refused
    const again = await transaction(t.db, (tx) => s.service.refund(tx, s.ctx('k-items-2'), s.inv.id, { mode: 'items', itemIds: s.itemIds, dest: 'card' })).catch((e: unknown) => e)
    expect((again as AppError).code).toBe('ITEM_ALREADY_REFUNDED')
    // the 20.00 the alert names goes back as an amount, through Square again (the failed leg reserves nothing)
    expect(await failedSquareRefunds(t.db, r.pe.locationId, new Date(0))).toEqual([expect.objectContaining({ uncoveredCents: 2000 })])
    const rest = await s.refund(2000, 'k-rest')
    await runSquareRefunds(s.job)
    expect((await s.legs(rest.event.id)).map((l) => [l.square_payment_id, l.amount_cents])).toEqual([[s.pays[0]!.id, 2000]])
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 4280, refundable: 0 })
  })

  it('a Square app refund is not attached to a hand-confirmed refund on an invoice that also holds Squarespace card money', async () => {
    const r = await coreRig(t, { PAYMENT_PROCESSOR: 'squarespace' })
    const s = await paidBySquare(r, [2280], { squarespaceCents: 2000 })
    // the staff refund 1000 of the Squarespace payment there and confirm it by hand (no order id typed in)
    const staff = await s.refund(1000)
    await transaction(t.db, (tx) => s.service.confirmProcessor(tx, s.ctx('k-confirm'), staff.event.id))
    // a separate 10.00 refund made in the Square app: real money, kept apart and flagged for review
    const pos = await r.sim.api.refunds.refund(sqKey('rf', 'pos-mixed'), { payment_id: s.pays[0]!.id, amount_money: usd(1000) })
    r.sim.store.advance(5_000)
    expect(await r.ingestRefund(pos.id)).toMatchObject({ note: expect.stringMatching(/needs review/) })
    expect(await s.event(staff.event.id)).toMatchObject({ processor_state: 'confirmed', processor_ref: null })
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 2000 })
    const alerts = await squareExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager: false })
    expect(alerts.filter((a) => a.kind === 'square_external_refund')).toHaveLength(1)
  })

  it('a refund Square refuses when sent (more than the payment can give back) fails at once', async () => {
    const r = await coreRig(t)
    const s = await paidBySquare(r)
    // money given back directly at Square, unknown to the planner
    await r.sim.api.refunds.refund(sqKey('rf', 'outside'), { payment_id: s.pays[0]!.id, amount_money: usd(4000) })
    const out = await s.refund(1000)
    const rep = await runSquareRefunds(s.job)
    expect(rep).toMatchObject({ planned: 1, failed: 1 })
    expect((await s.legs(out.event.id))[0]).toMatchObject({ state: 'failed', error: expect.stringMatching(/REFUND_AMOUNT_INVALID/) })
    expect((await s.event(out.event.id)).processor_state).toBe('failed')
  })

  it('a refund the Square money on the invoice cannot cover is marked failed without sending anything', async () => {
    const r = await coreRig(t)
    const s = await paidBySquare(r, [1000])
    // a staff card entry confirmed by hand (not Square) carries the rest
    const extra = await r.staffCard(s.inv, 3280)
    await t.db.updateTable('ledger_events').set({ processor_state: 'confirmed' }).where('id', '=', extra).execute()
    const out = await s.refund(2000)
    const before = r.sim.sim.log.length
    expect(await runSquareRefunds(s.job)).toMatchObject({ uncovered: 1, planned: 0 })
    expect(r.sim.sim.log.length).toBe(before)
    expect((await s.event(out.event.id)).processor_state).toBe('failed')
  })

  it('the webhook may report our refund before the job records Square’s answer: one leg, one refund, confirmed once', async () => {
    const r = await coreRig(t)
    const s = await paidBySquare(r)
    const out = await s.refund(700)
    const rep: RefundRunReport = { status: 'ok', planned: 0, uncovered: 0, submitted: 0, failed: 0, retry: 0 }
    await planSquareRefundLegs(s.job, rep)
    const [leg] = await s.legs(out.event.id)
    // the job's call reached Square, its answer was lost (a crash): Square's refund exists under the leg's key
    const sent = await r.sim.api.refunds.refund(sqKey('rf', leg!.id), { payment_id: leg!.square_payment_id, amount_money: usd(700), reason: 'Service issue' })
    await r.ingestRefund(sent.id)
    expect((await s.legs(out.event.id))[0]).toMatchObject({ square_refund_id: sent.id, state: 'pending' })
    await submitSquareRefundLegs(s.job, rep)
    expect(r.sim.store.refunds.size).toBe(1)
    r.sim.store.advance(5_000)
    await r.ingestRefund(sent.id)
    expect((await s.event(out.event.id)).processor_state).toBe('confirmed')
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 700 })
  })

  it('a refund made in the Square POS app: attached to the staff refund of that amount, or recorded for review', async () => {
    const r = await coreRig(t, { PAYMENT_PROCESSOR: 'squarespace' })
    const s = await paidBySquare(r, [4280])
    // before the cutover a card refund is the staff's to finish (no processor): done in the Square app
    const staff = await s.refund(1000)
    expect((await s.event(staff.event.id)).processor).toBeNull()
    const pos = await r.sim.api.refunds.refund(sqKey('rf', 'pos-1'), { payment_id: s.pays[0]!.id, amount_money: usd(1000) })
    r.sim.store.advance(5_000)
    expect(await r.ingestRefund(pos.id)).toMatchObject({ note: expect.stringMatching(/attached/) })
    expect(await s.event(staff.event.id)).toMatchObject({ processor_state: 'confirmed', processor: 'square', processor_ref: pos.id })
    const other = await r.sim.api.refunds.refund(sqKey('rf', 'pos-2'), { payment_id: s.pays[0]!.id, amount_money: usd(500) })
    r.sim.store.advance(5_000)
    expect(await r.ingestRefund(other.id)).toMatchObject({ note: expect.stringMatching(/needs review/) })
    const ext = await t.db.selectFrom('ledger_events').selectAll().where('idempotency_key', '=', `square:refund:${other.id}`).executeTakeFirstOrThrow()
    expect(ext).toMatchObject({ type: 'refund', amount_cents: 500, needs_review: true, source: 'square', reason: 'Refunded in Square' })
    await r.ingestRefund(other.id)
    expect(await r.calc(s.inv.id)).toMatchObject({ refunded: 1500 })
    const alerts = await squareExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager: false })
    expect(alerts.filter((a) => a.kind === 'square_external_refund')).toEqual([expect.objectContaining({ tone: 'amber', title: expect.stringMatching(/^Refunded in the Square app · /) })])
    // the job never touches them (no processor square awaiting)
    expect(await runSquareRefunds({ ...s.job, env: squareEnvFor() })).toMatchObject({ planned: 0, submitted: 0 })
  })

  it('observe-only or before the cutover the job sends nothing', async () => {
    const r = await coreRig(t, { SQUARE_WRITES_ENABLED: 'false' })
    const s = await paidBySquare(r)
    await s.refund(1000)
    expect(await runSquareRefunds(s.job)).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/observe-only/) })
    expect(r.sim.sim.log.filter((x) => x.method !== 'GET')).toEqual([])
    expect(await runSquareRefunds({ ...s.job, env: squareEnvFor({ PAYMENT_PROCESSOR: 'squarespace' }) })).toMatchObject({ status: 'skipped' })
  })
})
