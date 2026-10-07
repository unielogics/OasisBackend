// Review finding 1: a STOP that arrives after a text was queued does not stop that text. The policy gate runs at enqueue
// time only; the dispatcher claims and sends whatever is pending, and nothing cancels the outbox rows of a number that opts out.
import { describe, expect, it } from 'vitest'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld()
let n = 0

async function inbound(from: string, text: string) {
  n += 1
  const ev = w.signed('sms:received', { messageId: `rv-in-${n}`, sender: from, recipient: '+15555550100', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })
  const res = await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
  return res
}

const sentTexts = async (): Promise<string[]> => (await w.sim()).device.listMessages().map((m) => m.text)

describe('STOP arrives while a text is queued', () => {
  it('a reminder held overnight is not sent after the customer texted STOP', async () => {
    w.clock.set('2026-06-12T22:00:00-04:00')
    await w.rt.pollHealthAll()
    const maria = w.customer('Maria Delgado')
    const queued = await w.tx((tx) =>
      w.rt.queue.enqueue(tx, { customerId: maria.id, appointmentId: null, purpose: 'reminder', templateKey: 'reminder', vars: { when: 'tomorrow', time: '9:00 AM' } }),
    )
    expect(queued.queued).toBe(true)

    w.clock.set('2026-06-12T23:00:00-04:00')
    await w.rt.pollHealthAll()
    await inbound(maria.phone, 'STOP')
    await w.tick() // the opt-out confirmation, the one text a stopped number may still get
    expect(await sentTexts()).toHaveLength(1)

    w.clock.set('2026-06-13T08:05:00-04:00')
    await w.rt.pollHealthAll()
    await w.tick()
    await w.tick()

    const texts = await sentTexts()
    expect(texts.filter((t) => t.startsWith('Reminder:'))).toEqual([])
    const out = await w.messagesOf('Maria Delgado')
    expect(out.find((m) => m.template_key === 'reminder')?.status).toBe('canceled')
  })

  it('a text that was waiting for a retry is not sent after the customer texted STOP', async () => {
    await w.rt.pollHealthAll()
    const maria = w.customer('Maria Delgado')
    const sim = await w.sim()
    const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: maria.id, appointmentId: null, purpose: 'ready', templateKey: 'ready' }))
    sim.setOutage('error5xx', { once: true })
    await w.tick() // transient failure: back to pending with a backoff
    const row = await w.t.db.selectFrom('sms_outbox').select(['state', 'next_attempt_at']).where('id', '=', q.messageId!).executeTakeFirstOrThrow()
    expect(row.state).toBe('pending')

    await inbound(maria.phone, 'STOP')
    w.clock.advance(60_000)
    await w.rt.pollHealthAll()
    await w.tick()
    await w.tick()
    expect((await sentTexts()).filter((t) => t.includes('ready for pickup'))).toEqual([])
  })
})
