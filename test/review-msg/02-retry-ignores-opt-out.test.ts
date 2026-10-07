// Review finding 2: staff "retry" (and a customer's own STOP after a failure) is not re-checked. A failed or expired text
// is put back to pending with a fresh TTL without passing the SMS policy again, so it goes out to a number that has since
// opted out.
import { describe, expect, it } from 'vitest'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld()

describe('retrying a failed text after the customer opted out', () => {
  it('never reaches the device', async () => {
    await w.rt.pollHealthAll()
    const maria = w.customer('Maria Delgado')
    const sim = await w.sim()
    const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: maria.id, appointmentId: null, purpose: 'receipt', templateKey: 'receipt' }))
    await w.tick()
    // the device accepted it and then reported a permanent failure (invalid destination)
    expect(sim.fail(q.messageId!, 'Invalid destination address')).toBe(true)
    await w.settle()
    expect((await w.t.db.selectFrom('sms_outbox').select('state').where('id', '=', q.messageId!).executeTakeFirstOrThrow()).state).toBe('failed')

    // the customer texts STOP
    const ev = w.signed('sms:received', { messageId: 'rv-stop-1', sender: maria.phone, recipient: '+15555550100', simNumber: 1, message: 'STOP', receivedAt: w.clock.now().toISOString() })
    await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
    await w.settle()
    await w.tick() // opt-out confirmation
    const before = sim.device.listMessages().length

    // staff presses "retry" on the failed text
    const device = await w.device()
    const ok = await w.tx(async (tx) => w.rt.dispatcherFor(device, tx).dispatcher.retryFailed(q.messageId!))
    expect(ok).toBe(true)
    await w.rt.pollHealthAll()
    await w.tick()
    await w.tick()
    const sentAfterStop = sim.device.listMessages().slice(before).map((m) => m.text)
    expect(sentAfterStop).toEqual([])
  })
})
