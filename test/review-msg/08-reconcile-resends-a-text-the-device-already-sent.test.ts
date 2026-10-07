// Review finding 8: reconcile treats `accepted` and `sent` alike. A text the device itself reported as sent (the sms:sent
// webhook arrived) is resent as a duplicate when the device later answers 404 for its id (app data cleared or reinstalled
// inside the 6-hour reconcile horizon). Only a message the device never confirmed is safe to send again.
import { describe, expect, it } from 'vitest'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld()

describe('reconcile after the tablet lost its message history', () => {
  it('does not text the customer a second time for a message that was confirmed sent', async () => {
    await w.rt.pollHealthAll()
    const maria = w.customer('Maria Delgado')
    const sim = await w.sim()
    const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: maria.id, appointmentId: null, purpose: 'ready', templateKey: 'ready' }))
    await w.tick()
    expect(sim.markSent(q.messageId!)).toBe(true)
    await w.settle()
    expect((await w.t.db.selectFrom('sms_outbox').select('state').where('id', '=', q.messageId!).executeTakeFirstOrThrow()).state).toBe('sent')
    expect(sim.device.listMessages().filter((m) => m.phone === maria.phone)).toHaveLength(1)

    sim.wipeDevice() // the app was reinstalled: it forgets every message id
    w.clock.advance(6 * 60_000)
    await w.rt.pollHealthAll()
    await w.rt.reconcileAll()
    await w.tick()
    await w.tick()

    // the device lost its history, so any message it now holds for her is a second copy of the one it already sent
    expect(sim.device.listMessages().filter((m) => m.phone === maria.phone)).toHaveLength(0)
  })
})
