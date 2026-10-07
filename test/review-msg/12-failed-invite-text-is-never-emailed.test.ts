// Review finding 12: the e-mail fallback of staff invites and password resets only covers a text that WAITED in the queue
// (device away for five minutes). A text the device or the carrier refuses (a landline, a mistyped number) ends `failed`, its
// live link is wiped from sms_outbox the moment it is final, and nothing is e-mailed: the person never gets the link even though
// the employee has an address on file.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { MessagingAccountNotifier } from '../../src/modules/messaging/adapters/accounts.js'
import { makeUser } from '../helpers/factories.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld()

describe('an invite whose text fails permanently', () => {
  it('reaches the employee by e-mail', async () => {
    const phone = '+13055550198' // on the test allow-list
    const { employeeId } = await makeUser(w.t.db, w.newId, { first: 'Kevin', email: 'kevin-failed-invite@example.test' })
    await sql`update employees set phone_e164 = ${phone}, email = 'kevin.employee@example.test', status = 'invited' where id = ${employeeId}`.execute(w.t.db)
    await w.rt.pollHealthAll()
    const notifier = new MessagingAccountNotifier(w.rt)
    const r = await notifier.deliver({
      kind: 'invite',
      employeeId,
      firstName: 'Kevin',
      phone,
      email: 'kevin.employee@example.test',
      link: 'https://dashboard.oasis.test/invite?token=LINK-12345',
      expiresAt: new Date(w.clock.now().getTime() + 7 * 86_400_000),
    })
    expect(r.channel).toBe('sms')
    await w.tick()
    const sim = await w.sim()
    const out = await w.t.db.selectFrom('sms_outbox').select('id').where('klass', '=', 'staff_invite').executeTakeFirstOrThrow()
    expect(sim.fail(out.id, 'Invalid destination address')).toBe(true)
    await w.settle()
    expect((await w.t.db.selectFrom('sms_outbox').select('state').where('id', '=', out.id).executeTakeFirstOrThrow()).state).toBe('failed')

    for (let i = 0; i < 3; i++) {
      w.clock.advance(3 * 60_000)
      await w.rt.pollHealthAll()
      await w.rt.tickAll()
      await w.rt.emailSender.sendDue()
    }
    const mails = await w.t.db.selectFrom('outbox_emails').select(['template', 'to_email']).execute()
    expect(mails).toEqual([{ template: 'staff_invite', to_email: 'kevin.employee@example.test' }])
  })
})
