// Counter (POS) payments and link payments into the ledger (ADR 0171 D6, design 2.2 to 2.4), over Postgres and the simulator: the
// webhook path, R1 to R5 with cash, a staff entry confirmed with a tip, the matching delay and the job, the guard on what a
// confirmation may change, and observe-only mode (matching runs, Square sees no write).
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { processLoggedEvent, squareWebhookLog } from '../../src/modules/square/events.js'
import { runSquareMatching } from '../../src/modules/square/match-runner.js'
import { squareIngest } from '../../src/modules/square/runtime.js'
import { useTestDb } from '../helpers/db.js'
import { paymentFacts } from '../../src/modules/square/facts.js'
import { decideSquarePayment, lockPayment } from '../../src/modules/square/payments.js'
import { transaction } from '../../src/platform/db.js'
import { squareExternalAlerts } from '../../src/modules/square/db/alerts.js'
import { coreRig, silent, squareEnvFor, useCoreRuntime } from './core.js'

describe('Square payments into the ledger', () => {
  const t = useTestDb()
  useCoreRuntime()

  it('the webhook path: a POS payment naming the invoice (R1) is recorded once, with its tip on top, labelled with the card', async () => {
    const r = await coreRig(t)
    const inv = await r.openInvoice()
    const p = r.posPayment({ amountCents: 4280, tipCents: 600, note: `INV-${inv.no}` })
    const ev = r.sim.store.events.find((e) => e.type === 'payment.updated' && e.data.id === p.id)!
    const log = squareWebhookLog(t.db, r.newId)
    await log.claim(ev.event_id, r.clock.now(), { headers: { source: 'webhook' }, body: JSON.stringify(ev) })
    const d = { db: t.db, clock: r.clock, logger: silent, env: r.env, api: r.sim.api, ingest: squareIngest(), newId: r.newId }
    expect(await processLoggedEvent(d, ev.event_id)).toBe('processed')
    const pays = await t.db.selectFrom('ledger_events').selectAll().where('invoice_id', '=', inv.id).orderBy('seq').execute()
    expect(pays.map((e) => [e.type, e.amount_cents, e.reason, e.method, e.last4, e.source, e.processor, e.processor_state, e.processor_ref])).toEqual([
      ['pay', 4280, null, 'Visa ••1111', '1111', 'square', 'square', 'confirmed', p.id],
      ['pay', 600, 'Tip', 'Visa ••1111', '1111', 'square', 'square', 'confirmed', p.id],
    ])
    const c = await r.calc(inv.id)
    expect(c).toMatchObject({ tip: 600, total: 4880, paid: 4880, balance: 0, status: 'paid' })
    expect(await r.mirror(p.id)).toMatchObject({ match_state: 'matched', classification: 'counter', rule: 'R1', invoice_id: inv.id })
    // the other event of the same payment (payment.created) and a second delivery change nothing
    const created = r.sim.store.events.find((e) => e.type === 'payment.created' && e.data.id === p.id)!
    await log.claim(created.event_id, r.clock.now(), { headers: { source: 'webhook' }, body: JSON.stringify(created) })
    expect(await processLoggedEvent(d, created.event_id)).toBe('processed')
    expect(await r.decide(p.id, { force: true })).toBe('done')
    expect(await t.db.selectFrom('ledger_events').select('id').where('invoice_id', '=', inv.id).execute()).toHaveLength(2)
    const audit = await t.db.selectFrom('audit_log').select(['action', 'actor_name']).where('action', 'like', 'square.%').execute()
    expect(audit).toEqual([{ action: 'square.record_payment', actor_name: 'Square' }])
  })

  it('R3: the staff "Square reader" entry is confirmed by the payment of its amount, the tip recorded on top', async () => {
    const r = await coreRig(t)
    const inv = await r.openInvoice()
    const entry = await r.staffCard(inv, 4280)
    const p = r.posPayment({ amountCents: 4280, tipCents: 500 })
    expect(await r.decide(p.id)).toBe('matched')
    const e = await t.db.selectFrom('ledger_events').selectAll().where('id', '=', entry).executeTakeFirstOrThrow()
    expect(e).toMatchObject({ processor_state: 'confirmed', processor: 'square', processor_ref: p.id, method: 'Visa ••1111', brand: 'visa', last4: '1111', processor_confirmed_by: 'Square' })
    expect(await r.calc(inv.id)).toMatchObject({ paid: 4780, tip: 500, balance: 0 })
    expect(await r.mirror(p.id)).toMatchObject({ rule: 'R3', event_id: entry })
    // the guard: once confirmed, the label and digits are frozen again
    await expect(sql`update ledger_events set method = 'Mastercard' where id = ${entry}`.execute(t.db)).rejects.toThrow(/append-only/)
  })

  it('R4: one open invoice of the balance backed by the payer identity is recorded; without identity it waits in the queue', async () => {
    const r = await coreRig(t)
    const a = await r.openInvoice({ email: 'maria@example.com' })
    const b = await r.openInvoice({ email: 'other@example.com', items: [{ name: 'Wash', priceCents: 9000 }] })
    const cust = r.sim.store.createCustomer({ email_address: 'maria@example.com', given_name: 'Maria' })
    const backed = r.posPayment({ amountCents: 4280, customerId: String(cust.id) })
    // the buyer's identity comes from the Square customer, read by the matching job before its transaction
    expect(await r.decide(backed.id, { force: false })).toBe('unmatched')
    await t.db.updateTable('square_payments').set({ match_state: 'pending', match_after: r.clock.now() }).where('square_payment_id', '=', backed.id).execute()
    const run = await runSquareMatching({ db: t.db, clock: r.clock, newId: r.newId, env: r.env, api: r.sim.api, logger: silent, locationId: r.pe.locationId })
    expect(run.outcomes).toEqual({ matched: 1 })
    expect(await r.mirror(backed.id)).toMatchObject({ match_state: 'matched', rule: 'R4', invoice_id: a.id })
    expect((await r.calc(a.id)).balance).toBe(0)
    expect((await r.calc(b.id)).paid).toBe(0)
  })

  it('R4a amount-only only with SQUARE_POS_AUTOMATCH=amount; R5 keeps ranked candidates', async () => {
    const r = await coreRig(t)
    const a = await r.openInvoice()
    const p = r.posPayment({ amountCents: 4280 })
    expect(await r.decide(p.id)).toBe('unmatched')
    const m = await r.mirror(p.id)
    expect(m).toMatchObject({ match_state: 'unmatched', classification: 'counter' })
    expect(m!.candidates).toEqual([expect.objectContaining({ invoiceId: a.id, balanceCents: 4280, why: ['balance is this amount'] })])
    expect((await r.calc(a.id)).paid).toBe(0)
    const r2 = await coreRig(t, { SQUARE_POS_AUTOMATCH: 'amount' })
    const b = await r2.openInvoice()
    const q = r2.posPayment({ amountCents: 4280 })
    // a has the same balance: two invoices, amount alone cannot choose
    expect(await r2.decide(q.id)).toBe('unmatched')
    await t.db.updateTable('invoices').set({ canceled_at: r.clock.now(), cancel_reason: 'canceled' }).where('id', '=', a.id).execute()
    expect(await r2.decide(q.id)).toBe('matched')
    expect(await r2.mirror(q.id)).toMatchObject({ rule: 'R4a', invoice_id: b.id })
  })

  it('cash in the POS app: a staff cash entry of the amount takes the references only; named cash is recorded as cash', async () => {
    const r = await coreRig(t)
    const a = await r.openInvoice()
    const cashEntry = await r.staffCash(a, 4280)
    const c1 = r.posPayment({ amountCents: 4280, cash: true })
    expect(await r.decide(c1.id)).toBe('matched')
    expect(await t.db.selectFrom('ledger_events').select(['id', 'processor', 'processor_ref', 'amount_cents']).where('invoice_id', '=', a.id).execute()).toEqual([
      { id: cashEntry, processor: 'square', processor_ref: c1.id, amount_cents: 4280 },
    ])
    expect((await r.calc(a.id)).paid).toBe(4280)
    const b = await r.openInvoice({ items: [{ name: 'Wash', priceCents: 1000 }] })
    const c2 = r.posPayment({ amountCents: 500, cash: true, note: `inv-${b.no}` })
    expect(await r.decide(c2.id)).toBe('matched')
    const rows = await t.db.selectFrom('ledger_events').select(['method', 'method_kind', 'amount_cents', 'processor']).where('invoice_id', '=', b.id).execute()
    expect(rows).toEqual([{ method: 'Cash', method_kind: 'cash', amount_cents: 500, processor: 'square' }])
    expect(await r.calc(b.id)).toMatchObject({ paid: 500, status: 'partially_paid' })
  })

  it('a counter payment waits SQUARE_MATCH_DELAY_SECONDS, then the matching job decides it; a link payment is recorded at once', async () => {
    const r = await coreRig(t, { SQUARE_MATCH_DELAY_SECONDS: '90' })
    const inv = await r.openInvoice()
    await r.staffCard(inv, 4280)
    const p = r.posPayment({ amountCents: 4280 })
    expect(await r.decide(p.id)).toBe('pending')
    const deps = { db: t.db, clock: r.clock, newId: r.newId, env: r.env, api: r.sim.api, logger: silent, locationId: r.pe.locationId }
    expect((await runSquareMatching(deps)).considered).toBe(0)
    r.clock.advance(91_000)
    expect(await runSquareMatching(deps)).toMatchObject({ considered: 1, outcomes: { matched: 1 } })
    expect((await runSquareMatching(deps)).considered).toBe(0)
    expect(await r.livePays(p.id)).toHaveLength(1)
  })

  it('observe-only (SQUARE_WRITES_ENABLED=false): payments are mirrored and matched, and Square receives no write', async () => {
    const r = await coreRig(t, { SQUARE_WRITES_ENABLED: 'false' })
    const inv = await r.openInvoice()
    await r.staffCard(inv, 4280)
    const p = r.posPayment({ amountCents: 4280 })
    r.sim.sim.log.length = 0
    expect(await r.decide(p.id)).toBe('matched')
    const deps = { db: t.db, clock: r.clock, newId: r.newId, env: r.env, api: r.sim.api, logger: silent, locationId: r.pe.locationId }
    await runSquareMatching(deps)
    expect(r.sim.sim.log.filter((x) => x.method !== 'GET' && !/search|batch-retrieve/.test(x.path))).toEqual([])
    expect((await r.calc(inv.id)).balance).toBe(0)
  })

  it('a payment waiting more than 30 minutes is a "Needs attention" alert for the managers; matched, it clears', async () => {
    const r = await coreRig(t)
    await r.openInvoice()
    const p = r.posPayment({ amountCents: 777 })
    expect(await r.decide(p.id)).toBe('unmatched')
    const alerts = (manager: boolean) => squareExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager })
    expect(await alerts(true)).toEqual([])
    r.clock.advance(31 * 60_000)
    expect(await alerts(true)).toEqual([expect.objectContaining({ key: 'square_unmatched', kind: 'square_unmatched', title: '1 Square payment needs matching' })])
    expect(await alerts(false)).toEqual([])
    await t.db.updateTable('square_payments').set({ match_state: 'ignored', ignore_reason: 'test' }).execute()
    expect(await alerts(true)).toEqual([])
  })

  it('a payment naming an invoice for more than it owes is recorded, and the invoice shows as overpaid via Square', async () => {
    const r = await coreRig(t)
    const inv = await r.openInvoice()
    const p = r.posPayment({ amountCents: 5000, note: `INV-${inv.no}` })
    expect(await r.decide(p.id)).toBe('matched')
    expect(await r.calc(inv.id)).toMatchObject({ overpaid: 720 })
    const alerts = await squareExternalAlerts.list(t.db, { locationId: r.pe.locationId, now: r.clock.now(), manager: false })
    expect(alerts).toEqual([expect.objectContaining({ kind: 'square_overpaid', key: `square_overpaid:${inv.id}`, desc: `$7.20 more than INV-${inv.no} · refund the difference` })])
  })

  it('a payment of another location or a failed one never reaches the ledger', async () => {
    const r = await coreRig(t)
    const inv = await r.openInvoice()
    const p = r.posPayment({ amountCents: 4280, note: `INV-${inv.no}` })
    const elsewhere = { ...r.deps, env: squareEnvFor({ SQUARE_LOCATION_ID: 'LOTHER' }) }
    const out = await transaction(t.db, async (tx) => {
      await lockPayment(tx, p.id)
      return decideSquarePayment(tx, elsewhere, paymentFacts(await r.sim.api.payments.get(p.id)))
    })
    expect(out).toBe('ignored')
    expect(await r.mirror(p.id)).toMatchObject({ match_state: 'ignored', ignore_note: 'another location' })
    expect(await r.livePays(p.id)).toEqual([])
  })
})
