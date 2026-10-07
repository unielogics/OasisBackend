// The simulated device's own faults, end to end through the webhook path: duplicates and out-of-order delivery.
import { describe, expect, it } from 'vitest'
import { useWorld } from './world.js'

const w = useWorld({ autoProgress: 'instant' })

describe('simulator faults', () => {
  it('with instant progress the whole loop completes by itself', async () => {
    const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'booking_thanks', vars: { first: 'Maria' }, purpose: 'booking' }))
    await w.rt.pollHealthAll()
    await w.tick()
    await w.settle()
    expect((await w.messagesOf('Maria Delgado'))[0]).toMatchObject({ id: q.messageId, status: 'delivered' })
  })

  it('duplicate deliveries of one envelope are applied once', async () => {
    const sim = await w.sim()
    await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    sim.device.duplicateNextDeliveries(1)
    sim.injectInbound(w.customer('Maria Delgado').phone, 'Hello twice')
    await w.settle()
    expect((await w.messagesOf('Maria Delgado')).filter((m) => m.direction === 'in')).toHaveLength(1)
    const log = await w.t.db.selectFrom('webhook_log').select('status').execute()
    expect(log).toHaveLength(1) // one envelope id, one row; the repeat was dropped at the unique key
    expect(log[0]!.status).toBe('processed')
  })

  it('out-of-order delivery (delivered before sent) still ends delivered', async () => {
    const sim = await w.sim()
    const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'booking_thanks', vars: { first: 'Maria' }, purpose: 'booking' }))
    sim.device.holdDeliveries(true)
    await w.rt.pollHealthAll()
    await w.tick()
    expect(sim.device.flushHeld('reverse')).toBeGreaterThanOrEqual(2)
    await w.settle()
    expect((await w.messagesOf('Maria Delgado'))[0]).toMatchObject({ id: q.messageId, status: 'delivered' })
    expect(await w.t.db.selectFrom('sms_outbox').select('state').executeTakeFirstOrThrow()).toEqual({ state: 'delivered' })
  })
})
