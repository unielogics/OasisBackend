// Alert 12 reaches the Operations "Needs attention" list through the real composition (apiModules): card money recorded by staff
// but not confirmed by Squarespace within 2 hours, and orders waiting in the manual queue (managers only).
import { describe, expect, it } from 'vitest'
import { useMemRig } from './harness.js'

interface AlertDto {
  kind: string
  tone: string
  title: string
  desc: string
  actionLabel: string
  appointmentId: string | null
  action: { type: string; appointmentId: string | null }
}

describe('Operations alert 12 from the Squarespace sync', () => {
  const m = useMemRig()
  const alerts = async (s = m.superS()) =>
    ((await m.get(s, '/ops/alerts')).json() as { alerts: AlertDto[] }).alerts

  it('a staff-recorded card payment becomes an alert after 2 hours and clears when Squarespace confirms it', async () => {
    const a = await m.book('Liam Chen', 'Express Hand Wash')
    const pay = await m.send(m.superS(), 'POST', `/invoices/${a.invoiceId}/payments`, { method: 'card' })
    expect(pay.statusCode, pay.body).toBe(201)
    expect((await alerts()).filter((x) => x.kind === 'awaiting_processor')).toEqual([])
    m.h.clock.advance(2 * 3600_000 + 60_000)
    const list = (await alerts()).filter((x) => x.kind === 'awaiting_processor')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      tone: 'amber',
      title: 'Card payment not confirmed · Liam Chen',
      actionLabel: 'Confirm',
      appointmentId: a.appointmentId,
      action: { type: 'open', appointmentId: a.appointmentId },
    })
    expect(list[0]?.desc).toMatch(/^\$48\.15 on INV-\d+ recorded 2 h ago/)
    const ev = await m.h.t.db
      .selectFrom('ledger_events')
      .select('id')
      .where('invoice_id', '=', a.invoiceId)
      .executeTakeFirstOrThrow()
    const confirm = await m.send(m.superS(), 'POST', `/ledger-events/${ev.id}/confirm-processor`, {})
    expect(confirm.statusCode, confirm.body).toBe(200)
    expect((await alerts()).filter((x) => x.kind === 'awaiting_processor')).toEqual([])
  })

  it('orders in the manual queue are shown to managers (set.billing) and not to the front desk', async () => {
    await m.h.t.db
      .insertInto('sqsp_manual_queue')
      .values({
        id: m.h.t.app.newId(),
        location_id: m.locationId(),
        idempotency_key: 'k1',
        sqsp_order_id: 'o-1',
        reason: 'no_candidate',
        arrival: '{}',
      })
      .execute()
    const mgr = await alerts(m.superS())
    expect(mgr.find((x) => x.kind === 'unmatched_order')).toMatchObject({
      title: '1 Squarespace order needs matching',
      actionLabel: 'Review',
    })
    const desk = await alerts(m.limited())
    expect(desk.some((x) => x.kind === 'unmatched_order')).toBe(false)
  })
})
