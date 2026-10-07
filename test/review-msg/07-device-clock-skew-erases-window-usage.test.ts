// Review finding 7: the sliding-window budget counts a send at the time the DEVICE reports in `sms:sent` (sentAt), replacing
// the time Oasis handed it over. A tablet whose clock runs behind (or a replayed/late envelope with an old sentAt) moves its
// usage out of the 30-minute window, so the dispatcher thinks the window is empty and keeps sending until Android's own
// limit raises the confirmation dialog the budget exists to avoid.
import { describe, expect, it } from 'vitest'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld()

describe('sms:sent with a device timestamp far in the past', () => {
  it('does not lower the window usage', async () => {
    await w.rt.pollHealthAll()
    const maria = w.customer('Maria Delgado')
    const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: maria.id, appointmentId: null, purpose: 'ready', templateKey: 'ready' }))
    await w.tick()
    const device = await w.device()
    const status = async () => (await w.rt.dispatcherFor(device).dispatcher.status()).budget.used
    expect(await status()).toBe(1)

    const twoHoursAgo = new Date(w.clock.now().getTime() - 2 * 3600_000).toISOString()
    const ev = w.signed('sms:sent', { messageId: q.messageId!, sender: '+15555550100', recipient: maria.phone, simNumber: 1, partsCount: 1, sentAt: twoHoursAgo })
    expect((await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)).status).toBe(200)
    await w.settle()
    expect(await status()).toBe(1)
  })
})
