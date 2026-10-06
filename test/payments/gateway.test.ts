// The InvoiceGateway the scheduling module calls: gap-free numbering from 20611, idempotent creation, item sync with the
// overpaid guard, cancel and no-show statuses (including a kept deposit), and the batched summaries.
import { describe, expect, it } from 'vitest'
import { transaction } from '../../src/platform/db.js'
import { createInvoiceGateway, type EnsureInvoiceInput } from '../../src/modules/payments/gateway.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { makeAppointment, makeCustomer, makeService, setupLocation, edt } from '../domain-schema/helpers.js'
import { useTestDb } from '../helpers/db.js'
import { addEvent } from './helpers.js'

const t = useTestDb()
const actor = { userId: null, name: 'Sofia D.', roles: 'Customer Support' }

async function world() {
  const f = await setupLocation(t)
  const gw = createInvoiceGateway({ clock: t.clock, newId: createIdGenerator(t.clock) })
  const customerId = await makeCustomer(t.db, f, { name: 'Priya Nair' })
  const serviceId = await makeService(t.db, f, {
    kind: 'package',
    name: 'Express Hand Wash',
    priceCents: 4500,
    durationMin: 45,
  })
  const appt = () => makeAppointment(t.db, f, { customerId, serviceId, start: edt('2026-06-13', '10:30') })
  const ensure = async (appointmentId: string, o: Partial<EnsureInvoiceInput> = {}) =>
    transaction(t.db, (tx) =>
      gw.ensureForAppointment(tx, {
        appointmentId,
        locationId: f.locationId,
        customerId,
        clientName: 'Priya Nair',
        vehicleLabel: '2022 Tesla Model Y',
        staffLabel: 'Lena K.',
        occurredAt: edt('2026-06-13', '10:30'),
        packageName: 'Express Hand Wash',
        packagePriceCents: 4500,
        addons: [{ name: 'Wax', priceCents: 4000 }],
        ...o,
      }),
    )
  return { f, gw, customerId, appt, ensure }
}

describe('ensureForAppointment', () => {
  it('numbers invoices gap-free from 20611 and returns the contract summary', async () => {
    const { appt, ensure } = await world()
    const a = await ensure(await appt())
    const b = await ensure(await appt())
    expect([a.invoiceNo, b.invoiceNo]).toEqual([20611, 20612])
    expect(a).toMatchObject({
      subtotalCents: 8500,
      taxCents: 595,
      tipCents: 0,
      totalCents: 9095,
      paidCents: 0,
      balanceCents: 9095,
      depositCents: 0,
      status: 'unpaid',
      refundPending: false,
      payMethodLabel: null,
      items: [
        { name: 'Express Hand Wash', priceCents: 4500, kind: 'package' },
        { name: 'Wax', priceCents: 4000, kind: 'addon' },
      ],
    })
  })

  it('is idempotent per appointment: the second call refreshes labels and keeps the number', async () => {
    const { appt, ensure } = await world()
    const id = await appt()
    const a = await ensure(id)
    const b = await ensure(id, { staffLabel: 'Marco R.' })
    expect(b.invoiceNo).toBe(a.invoiceNo)
    expect(b.invoiceId).toBe(a.invoiceId)
    const row = await t.db
      .selectFrom('invoices')
      .select(['staff_label', 'version'])
      .where('id', '=', a.invoiceId)
      .executeTakeFirstOrThrow()
    expect(row.staff_label).toBe('Marco R.')
    expect(
      await t.db.selectFrom('invoice_items').select('id').where('invoice_id', '=', a.invoiceId).execute(),
    ).toHaveLength(2)
  })

  it('a rolled-back booking leaves no gap in the numbers', async () => {
    const { appt, ensure, gw, f, customerId } = await world()
    const first = await ensure(await appt())
    const id = await appt()
    await expect(
      transaction(t.db, async (tx) => {
        await gw.ensureForAppointment(tx, {
          appointmentId: id,
          locationId: f.locationId,
          customerId,
          clientName: 'x',
          vehicleLabel: '',
          staffLabel: 'Unassigned',
          occurredAt: edt('2026-06-13', '11:00'),
          packageName: 'Express Hand Wash',
          packagePriceCents: 4500,
          addons: [],
        })
        throw new Error('booking failed after the invoice')
      }),
    ).rejects.toThrow('booking failed')
    const next = await ensure(id)
    expect([first.invoiceNo, next.invoiceNo]).toEqual([20611, 20612])
  })

  it('concurrent creations get distinct consecutive numbers', async () => {
    const { appt, ensure } = await world()
    const ids = await Promise.all([appt(), appt(), appt(), appt()])
    const made = await Promise.all(ids.map((id) => ensure(id)))
    expect(made.map((m) => m.invoiceNo).sort()).toEqual([20611, 20612, 20613, 20614])
  })

  it('biz_date follows the service date in the business tz until frozen; a deposit at booking does not move it', async () => {
    const { appt, ensure, gw, f, customerId } = await world()
    const id = await appt()
    const first = await ensure(id, { occurredAt: edt('2026-06-14', '09:00') })
    await addEvent(
      t.db,
      { locationId: f.locationId, newId: f.newId } as never,
      { id: first.invoiceId, customerId },
      { type: 'pay', amountCents: 2500, method: 'Visa', methodKind: 'card', at: edt('2026-06-01', '12:00') },
    )
    let row = await t.db
      .selectFrom('invoices')
      .select(['biz_date'])
      .where('id', '=', first.invoiceId)
      .executeTakeFirstOrThrow()
    expect(row.biz_date).toBe('2026-06-14')
    await ensure(id, { occurredAt: edt('2026-06-15', '09:00') })
    row = await t.db
      .selectFrom('invoices')
      .select(['biz_date'])
      .where('id', '=', first.invoiceId)
      .executeTakeFirstOrThrow()
    expect(row.biz_date).toBe('2026-06-15')
    await transaction(t.db, (tx) => gw.freezeDate(tx, id, edt('2026-06-16', '23:30')))
    await ensure(id, { occurredAt: edt('2026-06-20', '09:00') })
    const frozen = await t.db
      .selectFrom('invoices')
      .select(['biz_date', 'date_frozen_at'])
      .where('id', '=', first.invoiceId)
      .executeTakeFirstOrThrow()
    expect(frozen.biz_date).toBe('2026-06-16')
    expect(frozen.date_frozen_at).not.toBeNull()
  })
})

describe('syncItems', () => {
  it('adds and removes lines, keeping the ids of lines that stay', async () => {
    const { appt, ensure, gw } = await world()
    const id = await appt()
    const made = await ensure(id)
    const before = await t.db
      .selectFrom('invoice_items')
      .select(['id', 'name'])
      .where('invoice_id', '=', made.invoiceId)
      .orderBy('position')
      .execute()
    const s = await transaction(t.db, (tx) =>
      gw.syncItems(tx, id, [
        { name: 'Express Hand Wash', priceCents: 4500, kind: 'package' },
        { name: 'Clay bar', priceCents: 5000, kind: 'addon' },
        { name: 'Wax', priceCents: 4000, kind: 'addon' },
      ]),
    )
    expect(s.items.map((i) => i.name)).toEqual(['Express Hand Wash', 'Clay bar', 'Wax'])
    expect(s.totalCents).toBe(13500 + 945)
    const after = await t.db
      .selectFrom('invoice_items')
      .select(['id', 'name'])
      .where('invoice_id', '=', made.invoiceId)
      .orderBy('position')
      .execute()
    expect(after.find((r) => r.name === 'Wax')!.id).toBe(before.find((r) => r.name === 'Wax')!.id)
    expect(after.find((r) => r.name === 'Express Hand Wash')!.id).toBe(
      before.find((r) => r.name === 'Express Hand Wash')!.id,
    )
  })

  it('a removal that would leave the invoice overpaid is a 409 ADDON_REMOVE_OVERPAID and changes nothing', async () => {
    const { appt, ensure, gw, f, customerId } = await world()
    const id = await appt()
    const made = await ensure(id)
    await addEvent(
      t.db,
      { locationId: f.locationId, newId: f.newId } as never,
      { id: made.invoiceId, customerId },
      { type: 'pay', amountCents: 9095, method: 'Cash', methodKind: 'cash' },
    )
    await expect(
      transaction(t.db, (tx) =>
        gw.syncItems(tx, id, [{ name: 'Express Hand Wash', priceCents: 4500, kind: 'package' }]),
      ),
    ).rejects.toMatchObject({ code: 'ADDON_REMOVE_OVERPAID', status: 409 })
    const items = await t.db
      .selectFrom('invoice_items')
      .select('name')
      .where('invoice_id', '=', made.invoiceId)
      .execute()
    expect(items).toHaveLength(2)
    // adding an add-on after payment reopens a balance instead
    const s = await transaction(t.db, (tx) =>
      gw.syncItems(tx, id, [
        { name: 'Express Hand Wash', priceCents: 4500, kind: 'package' },
        { name: 'Wax', priceCents: 4000, kind: 'addon' },
        { name: 'Clay bar', priceCents: 5000, kind: 'addon' },
      ]),
    )
    expect(s).toMatchObject({
      status: 'partially_paid',
      balanceCents: 9095 + 5000 + 350 - 9095,
      depositCents: 9095,
    })
  })
})

describe('cancelForAppointment', () => {
  it('canceling an unpaid invoice gives status canceled and zero balance; no-show cancels it too', async () => {
    const { appt, ensure, gw } = await world()
    const a = await appt()
    const b = await appt()
    await ensure(a)
    await ensure(b)
    const canceled = await transaction(t.db, (tx) => gw.cancelForAppointment(tx, a, 'canceled', actor))
    const noShow = await transaction(t.db, (tx) => gw.cancelForAppointment(tx, b, 'no_show', actor))
    expect(canceled).toMatchObject({ status: 'canceled', balanceCents: 0 })
    expect(noShow).toMatchObject({ status: 'canceled', balanceCents: 0 })
    const reasons = await t.db
      .selectFrom('invoices')
      .select(['cancel_reason', 'canceled_by_name'])
      .orderBy('invoice_no')
      .execute()
    expect(reasons).toEqual([
      { cancel_reason: 'canceled', canceled_by_name: 'Sofia D.' },
      { cancel_reason: 'no_show', canceled_by_name: 'Sofia D.' },
    ])
  })

  it('a kept deposit reads canceled_kept; refunded in full reads canceled_refunded', async () => {
    const { appt, ensure, gw, f, customerId } = await world()
    const a = await appt()
    const b = await appt()
    const ia = await ensure(a)
    const ib = await ensure(b)
    const env = { locationId: f.locationId, newId: f.newId } as never
    await addEvent(
      t.db,
      env,
      { id: ia.invoiceId, customerId },
      { type: 'pay', amountCents: 2500, method: 'Visa', methodKind: 'card' },
    )
    await addEvent(
      t.db,
      env,
      { id: ib.invoiceId, customerId },
      { type: 'pay', amountCents: 2500, method: 'Visa', methodKind: 'card' },
    )
    await addEvent(
      t.db,
      env,
      { id: ib.invoiceId, customerId },
      { type: 'refund', amountCents: 2500, dest: 'card', method: 'Visa' },
    )
    const kept = await transaction(t.db, (tx) => gw.cancelForAppointment(tx, a, 'no_show', actor))
    const refunded = await transaction(t.db, (tx) => gw.cancelForAppointment(tx, b, 'canceled', actor))
    expect(kept).toMatchObject({ status: 'canceled_kept', paidCents: 2500, balanceCents: 0 })
    expect(refunded).toMatchObject({ status: 'canceled_refunded', balanceCents: 0 })
  })

  it('is idempotent and returns null for an appointment without an invoice', async () => {
    const { appt, ensure, gw } = await world()
    const a = await appt()
    await ensure(a)
    await transaction(t.db, (tx) => gw.cancelForAppointment(tx, a, 'canceled', actor))
    const again = await transaction(t.db, (tx) => gw.cancelForAppointment(tx, a, 'no_show', actor))
    expect(again?.status).toBe('canceled')
    const row = await t.db.selectFrom('invoices').select('cancel_reason').executeTakeFirstOrThrow()
    expect(row.cancel_reason).toBe('canceled')
    expect(
      await transaction(t.db, (tx) =>
        gw.cancelForAppointment(tx, '00000000-0000-7000-8000-000000000000', 'canceled', actor),
      ),
    ).toBeNull()
  })
})

describe('summariesFor', () => {
  it('batches by appointment with payment label, deposit and pending-refund flag', async () => {
    const { appt, ensure, gw, f, customerId } = await world()
    const a = await appt()
    const b = await appt()
    const c = await appt()
    const ia = await ensure(a)
    await ensure(b)
    const env = { locationId: f.locationId, newId: f.newId } as never
    await addEvent(
      t.db,
      env,
      { id: ia.invoiceId, customerId },
      { type: 'pay', amountCents: 2000, method: 'Visa ••6610', methodKind: 'card' },
    )
    const map = await gw.summariesFor(t.db, [a, b, c])
    expect([...map.keys()].sort()).toEqual([a, b].sort())
    expect(map.get(a)).toMatchObject({
      paidCents: 2000,
      depositCents: 2000,
      balanceCents: 7095,
      status: 'partially_paid',
      payMethodLabel: 'Visa ••6610',
    })
    expect(map.get(b)).toMatchObject({ paidCents: 0, depositCents: 0, payMethodLabel: null })
    await addEvent(
      t.db,
      env,
      { id: ia.invoiceId, customerId },
      { type: 'pay', amountCents: 7095, method: 'Cash', methodKind: 'cash' },
    )
    await addEvent(
      t.db,
      env,
      { id: ia.invoiceId, customerId },
      { type: 'refund', amountCents: 500, status: 'pending', dest: 'cash' },
    )
    const after = (await gw.summariesFor(t.db, [a])).get(a)!
    expect(after).toMatchObject({
      status: 'paid',
      refundPending: true,
      payMethodLabel: 'Cash',
      depositCents: 0,
    })
    expect((await gw.summariesFor(t.db, [])).size).toBe(0)
  })
})
