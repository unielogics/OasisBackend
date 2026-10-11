// The AI's sub-cap on Postgres (ADR 0160, design section 10 "40 inbound texts in 10 min keep AI within its sub-cap while a lane-0
// 'ready' text goes on time"): the window accounting records the class of each send, and the dispatcher of the real runtime (from
// the environment: 30 segments per 30 minutes, 6 reserved for lane 0, AI_SMS_SEGMENTS_PER_30MIN=12) never lets the AI's texts pass
// their share.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { useWorld } from './world.js'

const w = useWorld()
let n = 0
const PEOPLE = ['Maria Delgado', 'Liam Chen', 'David Okafor', 'Priya Nair']

async function inbound(from: string, text: string): Promise<void> {
  n += 1
  const ev = w.signed('sms:received', { messageId: `flood-${n}`, sender: from, recipient: '+18623885827', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
}

const aiReply = (customer: string, text: string) =>
  w.tx(async (tx) => {
    const t = (await w.rt.queue.target(tx, w.locationId, w.customer(customer).id))!
    return w.rt.queue.enqueueFor(tx, {
      locationId: w.locationId,
      customerId: w.customer(customer).id,
      recipient: t.recipient,
      appointmentId: null,
      text,
      klass: 'ai_reply',
      purpose: 'assistant',
      senderKind: 'ai',
    })
  })

describe('a 40-text flood answered by the AI', () => {
  it('keeps the AI within 12 segments per 30 minutes while a lane-0 ready text goes at once', async () => {
    await w.rt.pollHealthAll()
    const sent: Array<{ id: string; at: number }> = []
    let readyId = ''
    // 40 texts in 10 minutes (4 clients), each answered by the AI
    for (let i = 0; i < 40; i++) {
      const who = PEOPLE[i % PEOPLE.length]!
      await inbound(w.customer(who).phone, `question ${i}`)
      const out = await aiReply(who, `Answer ${i}`)
      expect(out.queued).toBe(true)
      if (i === 20) {
        const r = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'ready', purpose: 'test' }))
        readyId = r.messageId!
        const [tick] = await w.tick()
        // the ready text is the first thing the dispatcher hands over on that tick
        expect(tick!.report.sent[0]).toBe(readyId)
      } else {
        const [tick] = await w.tick()
        for (const id of tick!.report.sent) sent.push({ id, at: w.clock.now().getTime() })
      }
      w.clock.advance(15_000)
    }
    const usage = await w.t.db.selectFrom('sms_usage').select(['klass', 'segments']).execute()
    const ai = usage.filter((u) => u.klass === 'ai_reply').reduce((s, u) => s + u.segments, 0)
    expect(ai).toBe(12)
    expect(usage.filter((u) => u.klass === 'ready')).toHaveLength(1)
    const states = await sql<{ state: string; n: number }>`select o.state, count(*)::int as n from sms_outbox o where o.klass = 'ai_reply' group by 1 order by 1`.execute(w.t.db)
    expect(states.rows).toEqual([
      { state: 'accepted', n: 12 },
      { state: 'pending', n: 28 },
    ])
    // the ones left waiting expire with their 15 minutes; none of them is ever sent inside this window
    w.clock.advance(16 * 60_000)
    await w.tick()
    expect((await w.t.db.selectFrom('sms_outbox').select('state').where('klass', '=', 'ai_reply').where('state', '=', 'pending').execute()).length).toBe(0)
    expect((await w.t.db.selectFrom('sms_usage').select('klass').where('klass', '=', 'ai_reply').execute()).length).toBe(12)
  })
})
