// Review finding 20: a queued text keeps the number it was addressed to. Staff fixing a mistyped phone number while a text is
// waiting (quiet hours, a device outage, a retry) does not redirect or stop it: the old number, now somebody else's, still
// gets "your vehicle is ready" and the like.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld()

describe('a customer whose phone number was corrected while a text was queued', () => {
  it('the text is not sent to the old number', async () => {
    const maria = w.customer('Maria Delgado')
    const sim = await w.sim()
    w.clock.set('2026-06-12T22:00:00-04:00') // quiet hours: the reminder waits for morning
    await w.rt.pollHealthAll()
    const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: maria.id, appointmentId: null, purpose: 'reminder', templateKey: 'reminder', vars: { when: 'tomorrow', time: '9:00 AM' } }))
    expect(q.queued).toBe(true)

    await sql`update customers set phone_e164 = '+13055550177' where id = ${maria.id}`.execute(w.t.db) // the typo is fixed

    w.clock.set('2026-06-13T08:05:00-04:00')
    await w.rt.pollHealthAll()
    await w.tick()
    await w.tick()
    expect(sim.device.listMessages().map((m) => m.phone)).not.toContain(maria.phone)
  })
})
