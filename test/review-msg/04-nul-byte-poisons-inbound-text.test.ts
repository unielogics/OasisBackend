// Review finding 4: a signed inbound text that contains U+0000 cannot be stored (Postgres text rejects it), so the whole
// event transaction fails on every attempt: the envelope stays `received`, is retried every 30 s for a day, then abandoned.
// When that text is a STOP the opt-out is never recorded.
import { describe, expect, it } from 'vitest'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld()

describe('an inbound text with a NUL character', () => {
  it('still records the STOP it carries', async () => {
    const maria = w.customer('Maria Delgado')
    const ev = w.signed('sms:received', { messageId: 'rv-nul-1', sender: maria.phone, recipient: '+15555550100', simNumber: 1, message: 'STOP\u0000', receivedAt: w.clock.now().toISOString() })
    const res = await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
    expect(res.status).toBe(200)
    await w.settle()
    await w.rt.webhooks.sweep()
    await w.settle()
    const optOuts = await w.t.db.selectFrom('sms_opt_outs').select('phone_e164').execute()
    expect(optOuts).toEqual([{ phone_e164: maria.phone }])
  })
})
