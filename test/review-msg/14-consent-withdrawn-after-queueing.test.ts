// Review finding 14: consent is checked when a text is queued only. Staff turning the customer's SMS opt-in off (the consent
// route, or the customer profile) while a text is waiting does not stop that text; it goes out to a customer the policy would
// now refuse.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld()

describe('SMS opt-in switched off while a text is queued', () => {
  it('the queued text is not sent', async () => {
    const maria = w.customer('Maria Delgado')
    const sim = await w.sim()
    w.clock.set('2026-06-12T22:00:00-04:00') // quiet hours: the reminder waits for morning
    await w.rt.pollHealthAll()
    const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: maria.id, appointmentId: null, purpose: 'reminder', templateKey: 'reminder', vars: { when: 'tomorrow', time: '9:00 AM' } }))
    expect(q.queued).toBe(true)

    await sql`update customers set sms_opted_in = false, sms_opt_in_source = null where id = ${maria.id}`.execute(w.t.db)

    w.clock.set('2026-06-13T08:05:00-04:00')
    await w.rt.pollHealthAll()
    await w.tick()
    await w.tick()
    expect(sim.device.listMessages().map((m) => m.text)).toEqual([])
  })
})
