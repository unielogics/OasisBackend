// Review finding 12: reopening a canceled or no-show appointment calls InvoiceGateway.ensureForAppointment again (scheduling
// lifecycle.reopenAppointment). The in-memory gateway the scheduling tests run against revives the invoice; the real one only
// refreshes labels and the date, so canceled_at stays set: balance is forced to 0, Collect answers "nothing to collect",
// adjust and tip are refused, and the job can be completed and picked up with no way to charge it.
import { describe, expect, it } from 'vitest'
import { createInvoiceGateway, type EnsureInvoiceInput } from '../../src/modules/payments/gateway.js'
import { transaction } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { makeAppointment, makeCustomer, makeService, setupLocation, edt } from '../domain-schema/helpers.js'
import { useTestDb } from '../helpers/db.js'
import { addEvent } from '../payments/helpers.js'

const t = useTestDb()

describe('reopen revives the invoice', () => {
  it('ensureForAppointment after a cancel (with a kept deposit) leaves a live invoice with the right balance', async () => {
    const f = await setupLocation(t)
    const gw = createInvoiceGateway({ clock: t.clock, newId: createIdGenerator(t.clock) })
    const customerId = await makeCustomer(t.db, f, { name: 'Priya Nair' })
    const serviceId = await makeService(t.db, f, {
      kind: 'package',
      name: 'Express Hand Wash',
      priceCents: 4500,
      durationMin: 45,
    })
    const appointmentId = await makeAppointment(t.db, f, {
      customerId,
      serviceId,
      start: edt('2026-06-13', '10:30'),
    })
    const input: EnsureInvoiceInput = {
      appointmentId,
      locationId: f.locationId,
      customerId,
      clientName: 'Priya Nair',
      vehicleLabel: '2022 Tesla Model Y',
      staffLabel: 'Lena K.',
      occurredAt: edt('2026-06-13', '10:30'),
      packageName: 'Express Hand Wash',
      packagePriceCents: 4500,
      addons: [],
    }
    const first = await transaction(t.db, (tx) => gw.ensureForAppointment(tx, input))
    await addEvent(
      t.db,
      { location: f.location, locationId: f.locationId, newId: f.newId },
      { id: first.invoiceId, customerId },
      {
        type: 'pay',
        amountCents: 1000,
        method: 'Cash',
        methodKind: 'cash',
      },
    )
    const canceled = await transaction(t.db, (tx) =>
      gw.cancelForAppointment(tx, appointmentId, 'canceled', { userId: null, name: 'Sofia D.' }),
    )
    expect(canceled?.status).toBe('canceled_kept')

    // lifecycle.reopenAppointment: the appointment is booked again and the invoice is ensured again
    const again = await transaction(t.db, (tx) => gw.ensureForAppointment(tx, input))
    expect(again.invoiceId).toBe(first.invoiceId)
    expect(again.status, 'a booked appointment must not keep a canceled invoice').toBe('partially_paid')
    expect(again.balanceCents).toBe(4815 - 1000)
  })
})
