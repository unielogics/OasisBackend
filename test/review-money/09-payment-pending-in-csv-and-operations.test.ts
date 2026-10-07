// Review finding 9: DV-212 (user decision) says an invoice whose card money staff recorded but Squarespace has not confirmed
// reads "Payment pending" instead of "Paid" on every screen that shows an invoice status, Operations included. The Payments
// table gets it from the list row's `awaiting` flag, but (a) the CSV export of that table prints "Paid", and (b) the Operations
// invoice summary (scheduling port, gateway, HTTP schema) carries no awaiting flag at all, so board.payView says "Paid".
import { describe, expect, it } from 'vitest'
import { payView } from '../../src/modules/scheduling/board.js'
import { createInvoiceGateway, summariesByAppointment } from '../../src/modules/payments/gateway.js'
import { PaymentsService } from '../../src/modules/payments/commands.js'
import { defaultPorts } from '../../src/modules/payments/ports.js'
import { transaction } from '../../src/platform/db.js'
import { makeAppointment, makeService } from '../domain-schema/helpers.js'
import { makeCustomer, makeInvoice } from '../payments/helpers.js'
import { usePayHarness } from '../payments/http.js'
import { ctxFor, makeUser, stubActor } from './helpers.js'

const p = usePayHarness()

describe('card money awaiting Squarespace reads "Payment pending"', () => {
  it('the CSV export reads like the table row', async () => {
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    expect((await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'card' })).statusCode).toBe(
      201,
    )
    const list = (await p.get(rafael, 'payments/invoices?range=today')).json() as {
      items: { id: string; awaiting: string | null; statusLabel: string }[]
    }
    const row = list.items.find((r) => r.id === inv.id)!
    expect(row.awaiting).toBe('payment')
    const csv = (await p.get(rafael, 'payments/export.csv?range=today')).body
      .replace(/^\uFEFF/, '')
      .split('\r\n')
      .filter(Boolean)
    const header = csv[0]!.split(',')
    const cells = csv[1]!.split(',')
    expect(cells[header.indexOf('Status')]).toBe('Payment pending')
  })

  it('the Operations pay label reads Payment pending while the card money is unconfirmed', async () => {
    const env = p.env()
    const f = { location: env.location, locationId: env.locationId, newId: env.newId }
    const customerId = await makeCustomer(p.h.t.db, env, { name: 'Priya Nair' })
    const serviceId = await makeService(p.h.t.db, f, {
      kind: 'package',
      name: 'Express Hand Wash',
      priceCents: 4500,
    })
    const appointmentId = await makeAppointment(p.h.t.db, f, {
      customerId,
      serviceId,
      start: new Date('2026-06-13T10:30:00-04:00'),
    })
    const gw = createInvoiceGateway({ clock: p.h.t.clock, newId: env.newId })
    const s0 = await transaction(p.h.t.db, (tx) =>
      gw.ensureForAppointment(tx, {
        appointmentId,
        locationId: env.locationId,
        customerId,
        clientName: 'Priya Nair',
        vehicleLabel: '2022 Tesla Model Y',
        staffLabel: 'Lena K.',
        occurredAt: new Date('2026-06-13T10:30:00-04:00'),
        packageName: 'Express Hand Wash',
        packagePriceCents: 4500,
        addons: [],
      }),
    )
    const user = await makeUser(p.h.t.db, env.newId, 'Rafael')
    const service = new PaymentsService({ clock: p.h.t.clock, newId: env.newId, ports: defaultPorts() })
    await transaction(p.h.t.db, (tx) =>
      service.collect(tx, ctxFor(env.locationId, stubActor(user, { refund: null })), s0.invoiceId, {
        method: 'card',
      }),
    )
    const summary = (await summariesByAppointment(p.h.t.db, [appointmentId])).get(appointmentId)!
    expect(payView(summary).label).toBe('Payment pending')
  })
})
