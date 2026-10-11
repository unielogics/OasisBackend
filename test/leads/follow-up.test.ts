// The one automatic follow-up of a lead (ADR 0160, plan J; job leads.follow_up; wave W3b): exactly once, after the delay since their
// last text, inside business hours, within the reply window, never after STOP (even after START), never once they booked, nothing
// while the assistant or the follow-up is off. The personal calendar link rides as a secretVar: masked in the thread.
import { describe, expect, it } from 'vitest'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { createNewTexters } from '../../src/modules/assistant/welcome/new-texters.js'
import { createLeadJobs, LEAD_FOLLOW_UP_JOB, runLeadFollowUps } from '../../src/modules/leads/index.js'
import { interestPhrase } from '../../src/modules/leads/follow-up.js'
import { noteLeadInterest } from '../../src/modules/leads/service.js'
import { STRANGER, useToolWorld } from '../assistant-tools/world.js'

const w = useToolWorld()
const MIN = 60_000
let n = 0

async function inbound(phone: string, text: string) {
  n += 1
  const ev = w.signed('sms:received', { messageId: `lead-${n}`, sender: phone, recipient: '+18623885827', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
}

/** A stranger texts while the assistant is on: the welcome flow creates the client and the lead (interest tint). */
async function strangerLead(): Promise<string> {
  await w.assistantOn()
  w.rt.useAssistant({ newTexters: createNewTexters(w.deps) })
  await inbound(STRANGER, 'How much is window tint?')
  await w.tx((tx) => noteLeadInterest(tx, { locationId: w.locationId, phone: STRANGER, categories: ['tint'], at: w.clock.now() }))
  return (await w.t.db.selectFrom('customers').select('id').where('phone_e164', '=', STRANGER).executeTakeFirstOrThrow()).id
}

const followUps = () =>
  w.t.db.selectFrom('messages').select(['body', 'klass', 'template_key', 'sender_kind', 'idempotency_key']).where('klass', '=', 'lead_follow_up').execute()
const lead = () => w.t.db.selectFrom('leads').selectAll().executeTakeFirstOrThrow()
const job = () => createLeadJobs(w.deps).find((j) => j.name === LEAD_FOLLOW_UP_JOB)!
const runJob = async () => {
  const j = job()
  await j.handler({ db: w.t.db, clock: w.clock, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } as never }, {} as never, { id: 'test' })
}

describe('leads.follow_up', () => {
  it('sends nothing while the assistant is off (the default), even with a lead due', async () => {
    await w.t.db
      .insertInto('leads')
      .values({ id: w.newId(), location_id: w.locationId, phone_e164: STRANGER, source: 'text', first_contact_at: w.clock.now(), last_contact_at: w.clock.now(), follow_up_at: w.clock.now() })
      .execute()
    w.clock.advance(200 * MIN)
    const r = await runLeadFollowUps(w.deps)
    expect(r).toMatchObject({ off: 1, sent: 0, considered: 0 })
    expect(await followUps()).toEqual([])
  })

  it('sends exactly one follow-up after the delay, with the interest and a personal calendar link masked in the thread', async () => {
    await strangerLead()
    w.clock.advance(120 * MIN)
    expect(await runLeadFollowUps(w.deps)).toMatchObject({ sent: 0, considered: 0 })
    w.clock.advance(61 * MIN) // 3 h 1 min after the text, Saturday 1:37 PM: open
    await runJob()
    const [m, ...more] = await followUps()
    expect(more).toEqual([])
    expect(m).toMatchObject({ template_key: 'lead_follow_up', sender_kind: 'ai' })
    expect(m!.body).toMatch(/^Hi, thanks for reaching out to Oasis Auto Spa about window tint\. Reply here and we.ll save you a spot\. Or pick a time: \[private link\]/)
    const out = await w.t.db.selectFrom('sms_outbox').select('body').where('klass', '=', 'lead_follow_up').executeTakeFirstOrThrow()
    expect(out.body).toMatch(/https:\/\/oasisautospanj\.com\/#\/c\/[A-Za-z0-9_-]{43}/)
    expect(await lead()).toMatchObject({ status: 'followed_up', follow_up_at: null })
    // again, and later: never a second one
    await runJob()
    w.clock.advance(4 * 60 * MIN)
    await inbound(STRANGER, 'thanks')
    w.clock.advance(4 * 60 * MIN)
    await runJob()
    expect(await followUps()).toHaveLength(1)
  })

  it('a newer text moves the follow-up: it waits for the delay after their last text', async () => {
    await strangerLead()
    w.clock.advance(170 * MIN)
    await inbound(STRANGER, 'still thinking')
    w.clock.advance(20 * MIN)
    expect(await runLeadFollowUps(w.deps)).toMatchObject({ sent: 0, deferred: 1 })
    expect((await lead()).follow_up_at).toEqual(new Date(w.clock.now().getTime() - 20 * MIN + 180 * MIN))
    w.clock.advance(161 * MIN)
    expect(await runLeadFollowUps(w.deps)).toMatchObject({ sent: 1 })
  })

  it('never after STOP, even after a later START', async () => {
    await strangerLead()
    await inbound(STRANGER, 'STOP')
    w.clock.advance(5 * MIN)
    await inbound(STRANGER, 'START')
    w.clock.advance(200 * MIN)
    expect(await runLeadFollowUps(w.deps)).toMatchObject({ sent: 0, dropped: { opted_out: 1 } })
    expect(await followUps()).toEqual([])
  })

  it('never once they booked: the lead is closed as booked first', async () => {
    const id = await strangerLead()
    await w.t.db.updateTable('customers').set({ full_name: 'Ana Lopez', needs_details: false }).where('id', '=', id).execute()
    const appt = w.newId()
    const svc = await w.t.db.selectFrom('services').select(['id', 'name', 'price_cents', 'duration_min']).where('kind', '=', 'package').executeTakeFirstOrThrow()
    await w.t.db
      .insertInto('appointments')
      .values({ id: appt, location_id: w.locationId, customer_id: id, service_id: svc.id, package_name: svc.name, price_cents: svc.price_cents, duration_min: svc.duration_min, scheduled_start: new Date('2026-06-15T10:00:00-04:00'), scheduled_end: new Date('2026-06-15T11:00:00-04:00') })
      .execute()
    w.clock.advance(200 * MIN)
    expect(await runLeadFollowUps(w.deps)).toMatchObject({ reconciledBooked: 1, sent: 0 })
    expect(await lead()).toMatchObject({ status: 'booked', booked_appointment_id: appt })
    expect(await followUps()).toEqual([])
  })

  it('outside business hours it waits for the next opening inside the window; beyond the window it is dropped', async () => {
    w.clock.advance((16 * 60 - (10 * 60 + 36)) * MIN) // Saturday 4:00 PM
    await strangerLead()
    w.clock.advance(185 * MIN) // 7:05 PM: closed (Saturday 8-5)
    expect(await runLeadFollowUps(w.deps)).toMatchObject({ sent: 0, deferred: 1 })
    expect((await lead()).follow_up_at).toEqual(new Date('2026-06-14T09:00:00-04:00')) // Sunday opens 9:00
    w.clock.set(new Date('2026-06-14T09:01:00-04:00'))
    expect(await runLeadFollowUps(w.deps)).toMatchObject({ sent: 1 })
  })

  it('drops a follow-up whose next opening is past the window, and one past the window altogether', async () => {
    w.clock.advance((16 * 60 - (10 * 60 + 36)) * MIN) // Saturday 4:00 PM
    await strangerLead()
    await w.setting('leads.within_hours', 12)
    w.clock.advance(185 * MIN)
    expect(await runLeadFollowUps(w.deps)).toMatchObject({ sent: 0, dropped: { no_business_hours_in_window: 1 } })
    expect((await lead()).follow_up_at).toBeNull()
    expect(await followUps()).toEqual([])
  })

  it('without personal links the text has no link and is readable in the thread; leads.follow_up_enabled off sends nothing', async () => {
    await strangerLead()
    w.clock.advance(181 * MIN)
    await w.setting('leads.follow_up_enabled', false)
    expect(await runLeadFollowUps(w.deps)).toMatchObject({ off: 1, sent: 0 })
    await w.setting('leads.follow_up_enabled', true)
    const deps = { ...w.deps, env: { ...w.deps.env, PUBLIC_LINKS_ENABLED: false } }
    expect(await runLeadFollowUps(deps)).toMatchObject({ sent: 1 })
    const [m] = await followUps()
    expect(m!.body).toMatch(/^Hi, thanks for reaching out to Oasis Auto Spa about window tint\. Reply here and we.ll save you a spot\./)
    expect(m!.body).not.toMatch(/link|http/)
    expect(await w.t.db.selectFrom('client_links').select('id').execute()).toEqual([])
  })

  it('keeps to the rollout stage: an allowlist stage follows up only listed numbers', async () => {
    await strangerLead()
    await w.setting('assistant.stage', 'allowlist')
    await w.setting('assistant.allowlist', ['+12015550100'])
    w.clock.advance(181 * MIN)
    expect(await runLeadFollowUps(w.deps)).toMatchObject({ sent: 0, dropped: { not_in_stage: 1 } })
    expect(await followUps()).toEqual([])
  })

  it('names the interests in plain words', () => {
    const labels = new Map([['ppf', 'Paint protection']])
    expect(interestPhrase(['tint'], labels)).toBe('window tint')
    expect(interestPhrase(['wash', 'detail', 'tint'], labels)).toBe('a wash and detailing')
    expect(interestPhrase(['ppf'], labels)).toBe('paint protection')
    expect(interestPhrase([], labels)).toBeNull()
  })
})
