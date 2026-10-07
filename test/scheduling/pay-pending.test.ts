// DV-212 on the Operations board: card money staff recorded and Squarespace has not confirmed reads "Payment pending"
// (never "Paid") on the card, in the file and in the snapshot, and becomes "Paid" once the processor leg is confirmed.
// Every payment change also tells the `ops` channel (appointment.updated, change "payment"; kpi.dirty), so a second
// browser on the board refreshes without polling. The seeded design day carries real invoices (parity-ops).
import { describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { useHarness } from '../auth/harness.js'
import { freshKey } from '../payments/http.js'

const h = useHarness()

interface Card {
  id: string
  customer: { name: string }
  pay: { label: string; kind: string; balanceCents: number; awaitingCents: number }
}

describe('Payment pending on the Operations board', () => {
  it('shows pending for unconfirmed card money, paid after confirmation, and announces both on the ops channel', async () => {
    await runSeed({ db: h.t.db, clock: h.clock, profile: 'parity-ops' })
    const user = await h.createUser({ email: 'pay-pending@example.test', roles: ['mgmt', 'acct'] })
    const s = await h.login(user, '10.9.0.1')
    const get = (url: string) => h.call('GET', url, { session: s })
    const post = (url: string, body: unknown = {}) =>
      h.call('POST', url, { session: s, body, headers: { 'idempotency-key': freshKey() } })

    const snap = async () =>
      (await get('/api/v1/ops/snapshot?window=next24')).json() as {
        timeline: { groups: { items: Card[] }[] }
        completed: { items: Card[] }
        kpis: { key: string; raw: number }[]
      }
    const find = (b: Awaited<ReturnType<typeof snap>>, name: string): Card =>
      [...b.timeline.groups.flatMap((g) => g.items), ...b.completed.items].find(
        (c) => c.customer.name === name,
      )!

    // the seeded design day has invoices: Tom Bradley (a10) is unpaid
    const before = find(await snap(), 'Tom Bradley')
    expect(before.pay).toMatchObject({ kind: 'due', awaitingCents: 0 })
    expect(before.pay.balanceCents).toBeGreaterThan(0)

    const file0 = (await get(`/api/v1/appointments/${before.id}`)).json() as {
      invoice: { invoiceId: string; balanceCents: number }
    }
    const t0 = (
      await h.t.db.selectFrom('realtime_events').select('id').orderBy('id', 'desc').executeTakeFirst()
    )?.id
    const collect = await post(`/api/v1/invoices/${file0.invoice.invoiceId}/payments`, { method: 'card' })
    expect(collect.statusCode).toBe(201)
    const eventId = (collect.json() as { event: { id: string } }).event.id

    const pending = find(await snap(), 'Tom Bradley')
    expect(pending.pay).toMatchObject({
      label: 'Payment pending',
      kind: 'pending',
      balanceCents: 0,
      awaitingCents: file0.invoice.balanceCents,
    })
    const file1 = (await get(`/api/v1/appointments/${before.id}`)).json() as {
      overview: { pay: { label: string; kind: string } }
      invoice: { awaitingCents: number; status: string }
    }
    expect(file1.overview.pay).toMatchObject({ label: 'Payment pending', kind: 'pending' })
    expect(file1.invoice).toMatchObject({ awaitingCents: file0.invoice.balanceCents, status: 'paid' })

    const opsEvents = async () =>
      await h.t.db
        .selectFrom('realtime_events')
        .select(['type', 'payload'])
        .where('channel', '=', 'ops')
        .where('id', '>', t0 ?? 0)
        .execute()
    const afterCollect = await opsEvents()
    expect(afterCollect.map((e) => e.type)).toEqual(
      expect.arrayContaining(['appointment.updated', 'kpi.dirty']),
    )
    expect(afterCollect.find((e) => e.type === 'appointment.updated')!.payload).toMatchObject({
      id: before.id,
      change: 'payment',
    })

    const t1 = (await h.t.db
      .selectFrom('realtime_events')
      .select('id')
      .orderBy('id', 'desc')
      .executeTakeFirst())!.id
    const confirm = await post(`/api/v1/ledger-events/${eventId}/confirm-processor`)
    expect(confirm.statusCode).toBeLessThan(300)
    const paid = find(await snap(), 'Tom Bradley')
    expect(paid.pay).toMatchObject({ label: 'Paid', kind: 'paid', awaitingCents: 0 })
    const afterConfirm = await h.t.db
      .selectFrom('realtime_events')
      .select(['type', 'payload'])
      .where('channel', '=', 'ops')
      .where('id', '>', t1)
      .execute()
    expect(afterConfirm.find((e) => e.type === 'appointment.updated')!.payload).toMatchObject({
      id: before.id,
      change: 'payment',
    })
  })

  it('confirmed deposits keep the deposit label', async () => {
    await runSeed({ db: h.t.db, clock: h.clock, profile: 'parity-ops' })
    const user = await h.createUser({ email: 'pay-partial@example.test', roles: ['mgmt', 'acct'] })
    const s = await h.login(user, '10.9.0.2')
    const snap = (await h.call('GET', '/api/v1/ops/snapshot?window=next24', { session: s })).json() as {
      timeline: { groups: { items: Card[] }[] }
    }
    // a5 and a7 carry confirmed deposits: their pill is the deposit label, not pending
    const deposits = snap.timeline.groups.flatMap((g) => g.items).filter((c) => c.pay.kind === 'deposit')
    expect(deposits.length).toBeGreaterThan(0)
    for (const c of deposits) {
      expect(c.pay.label).toMatch(/^Deposit · \$[\d,.]+ due$/)
      expect(c.pay.awaitingCents).toBe(0)
    }
  })
})
