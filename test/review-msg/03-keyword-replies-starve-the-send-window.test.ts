// Review finding 3: every inbound HELP/START/C text earns a lane-0 reply with no per-number cap. Lane 0 may spend the whole
// 30-segment window, so anyone who can text the shop's number (no account, no signature needed) can burn the tablet's entire
// budget in a few messages and stall the transactional texts (welcome, ready for pickup) for the length of the window.
import { describe, expect, it } from 'vitest'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { STRANGER, useWorld } from '../messaging-db/world.js'

const w = useWorld()
let n = 0

async function inbound(from: string, text: string) {
  n += 1
  const ev = w.signed('sms:received', { messageId: `rv-flood-${n}`, sender: from, recipient: '+15555550100', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
}

describe('a stranger texting HELP over and over', () => {
  it('cannot use up the window that the ready-for-pickup text of another customer needs', async () => {
    await w.rt.pollHealthAll()
    for (let i = 0; i < 40; i++) await inbound(STRANGER, 'HELP')
    for (let i = 0; i < 5; i++) await w.tick()

    const david = w.customer('David Okafor')
    const ready = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: david.id, appointmentId: null, purpose: 'ready', templateKey: 'ready' }))
    expect(ready.queued).toBe(true)
    const [t] = await w.tick()
    expect(t!.report.sent).toEqual([ready.messageId])
  })
})
