// The live conversation eval's harness (scripts/eval-conversations.ts, ADR 0160 W4b) with simulated models: the personas run through
// the REAL runtime (the webhook, the gate, the welcome flow, the turn, the tools, the guard and the judge, the reply-number handler) on
// a schema of its own, and every outbound text is captured as the phone shows it. W4b runs the same harness against Bedrock.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { evalConversations, parseArgs, phonesOf, RpmGate, type EvalProviders } from '../../scripts/eval-conversations.js'
import { DEFAULT_SIM_VERDICT, POLICY_JUDGE_HEADER, SimAiProvider, simText, simToolUse } from '../../src/integrations/ai/sim.js'
import type { AiConverseRequest } from '../../src/integrations/ports/ai.js'
import { SAFETY_LINE } from '../../src/modules/assistant/guard.js'

const lastClientText = (req: AiConverseRequest): string => {
  const first = req.messages[0]!.content[0]
  const text = first && first.type === 'text' ? first.text : ''
  const lines = text.split('\n').filter((l) => / Client: /.test(l))
  return lines.at(-1)?.replace(/^.* Client: /, '') ?? ''
}
const toolRounds = (req: AiConverseRequest): number => req.messages.filter((m) => m.role === 'user' && m.content.some((b) => b.type === 'toolResult')).length

/** A scripted assistant: the price question, a booking for a verified client, a verify link for an unverified one. */
const assistant = new SimAiProvider((req) => {
  const said = lastClientText(req)
  const rounds = toolRounds(req)
  if (/book|go ahead/i.test(said)) {
    if (rounds === 0)
      return /Verified phone: yes/.test(req.system[2]!.text)
        ? simToolUse('propose_booking', { serviceKey: 'signature-hand-wash', addonKeys: [], date: '2026-10-15', startMin: 600, vehicle: null })
        : simToolUse('send_link', { kind: 'verify', appointmentRef: null, tier: null })
    return /confirmationTexted/.test(JSON.stringify(req.messages)) ? simText('{confirm}.') : simText('First confirm it is you here: {link1}')
  }
  if (/how much/i.test(said)) return rounds === 0 ? simToolUse('list_services', { category: 'wash' }) : simText('{price:signature-hand-wash}. What is your first name?')
  return simText('Thanks! A team member can help with anything else.')
})
const judge = new SimAiProvider((req) => {
  if (!req.system[0]?.text.startsWith(POLICY_JUDGE_HEADER)) throw new Error('not a judge request')
  return simText(DEFAULT_SIM_VERDICT)
})
const quality = new SimAiProvider(() => simText('{"helpfulness":5,"tone":5,"correctness":5,"flow":4,"overall":5,"reason":"fine","policyConcerns":[]}'))
const providers: EvalProviders = { assistant, judge, quality, simulator: null }

const PERSONAS = {
  version: 1,
  startAt: '2026-10-14T10:00:00-04:00',
  personas: [
    { id: 'price', category: 'new_texter', description: 'A stranger asks a price.', steps: [{ text: 'How much is a wash?' }] },
    {
      id: 'book-trusted',
      category: 'booking_trusted',
      description: 'A verified client books and confirms with the reply number, first from the wrong phone.',
      client: { name: 'Jonathan Franco', trusted: true },
      steps: [{ text: 'Can I book a Signature wash tomorrow at 10?' }, { text: '{{code}}', from: 'alt' }, { text: '{{code}}' }],
      expect: { booking: 'confirmed' },
    },
    {
      id: 'book-untrusted',
      category: 'booking_untrusted',
      description: 'An unverified client asks to book.',
      client: { name: 'Chloe Martin' },
      steps: [{ text: 'Please book me tomorrow at 10' }],
      expect: { link: ['verify'], booking: 'none' },
    },
    {
      id: 'ask-first',
      category: 'booking_trusted',
      description: 'The assistant asks one more question before it proposes: the {{code}} step answers it, then texts the number.',
      client: { name: 'Isabel Cruz', trusted: true },
      steps: [{ text: 'Can I get a wash tomorrow at 10?' }, { text: '{{code}}' }],
      expect: { booking: 'confirmed' },
    },
    { id: 'stop', category: 'stop', description: 'STOP mid-conversation.', steps: [{ text: 'How much is a wash?' }, { text: 'STOP' }, { text: 'hello?' }], expect: { optOut: true } },
    { id: 'uk', category: 'foreign_number', description: 'A +44 number.', phone: 'uk', steps: [{ text: 'How much is a wash?' }], expect: { noAiReply: true } },
  ],
}

describe('scripts/eval-conversations.ts (simulated models, the real runtime)', () => {
  it('parses its options', () => {
    expect(parseArgs(['--only', 'a,b', '--catalog', 'both', '--concurrency', '3', '--budget-usd', '7', '--no-quality', '--rpm', '30'])).toMatchObject({
      only: ['a', 'b'],
      catalog: 'both',
      concurrency: 3,
      budgetUsd: 7,
      quality: false,
      rpm: 30,
    })
    expect(() => parseArgs(['--catalog', 'x'])).toThrow()
    expect(phonesOf(3, { phone: 'us' } as never)).toEqual({ primary: '+12015550103', alt: '+19735550103' })
  })

  it('the rpm gate lets a turn start only while the last minute’s calls and the running turns stay under the budget', async () => {
    let t = 0
    const waits: number[] = []
    const gate = new RpmGate(10, 4, () => t, async (ms) => {
      waits.push(ms)
      t += 15_000
    })
    await gate.enter()
    for (let i = 0; i < 4; i++) gate.record()
    // 4 calls this minute + 2 running turns x 4 = 12 > 10: waits until the calls age out
    await gate.enter()
    expect(waits.length).toBe(4)
    gate.leave()
    gate.leave()
  })

  it('runs the personas: price placeholders rendered, booking only by the reply number from the right phone, verify link with the safety line, STOP honoured, +44 ignored', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oasis-convo-eval-'))
    const file = path.join(dir, 'personas.json')
    writeFileSync(file, JSON.stringify(PERSONAS))
    const out = await evalConversations(['--personas', file, '--concurrency', '2', '--json', path.join(dir, 'out.json')], {
      providers,
      schemaPrefix: `t_convo_eval_${process.env.VITEST_POOL_ID ?? '0'}`,
      log: () => undefined,
    })
    const byId = new Map(out.results.map((r) => [r.personaId, r]))
    expect(out.results).toHaveLength(6)
    for (const r of out.results) expect(r.check.breaches, r.personaId).toEqual([])
    for (const r of out.results) expect(r.check.misses, r.personaId).toEqual([])

    const price = byId.get('price')!
    const first = price.run.messages.find((m) => m.dir === 'out')!
    expect(first.text).toMatch(/^Oasis Auto Spa.s automated assistant here\. Signature Hand Wash starts at \$45 for members, \$54 otherwise\. What is your first name\? Reply STOP to opt out\.$/)
    expect(price.quality?.overall).toBe(5)
    expect(price.turns).toBe(1)

    const book = byId.get('book-trusted')!
    expect(book.run.appointmentChanges).toEqual([{ kind: 'created', viaReplyNumber: true, source: 'sms_ai' }])
    const texts = book.run.messages.map((m) => `${m.dir}:${m.phone}:${m.templateKey ?? ''}`)
    // the code from the wrong phone books nothing (its text goes to staff as an ordinary message); the right phone's does
    expect(texts).toContain('in:alt:')
    expect(book.run.messages.filter((m) => m.templateKey === 'action_booked')).toHaveLength(1)
    expect(book.run.messages.find((m) => m.templateKey === 'action_confirm')!.text).toMatch(/Reply \d{4} to confirm\./)

    // no reply number yet at the {{code}} step: the client says "Yes, please go ahead.", then texts the number the server sent
    const askFirst = byId.get('ask-first')!
    expect(askFirst.run.messages.filter((m) => m.dir === 'in').map((m) => m.text.replace(/^\d{4}$/, '[code]'))).toEqual(['Can I get a wash tomorrow at 10?', 'Yes, please go ahead.', '[code]'])
    expect(askFirst.run.appointmentChanges).toEqual([{ kind: 'created', viaReplyNumber: true, source: 'sms_ai' }])

    const untrusted = byId.get('book-untrusted')!
    const link = untrusted.run.messages.find((m) => m.links.includes('verify'))!
    expect(link.text).toContain('[link:verify]')
    expect(link.text).toContain(SAFETY_LINE)
    expect(untrusted.run.appointmentChanges).toEqual([])

    const stop = byId.get('stop')!
    expect(stop.run.optedOutAfterSeq).not.toBeNull()
    expect(stop.run.messages.filter((m) => m.dir === 'out').map((m) => m.templateKey)).toEqual(['ai_reply', 'opt_out_confirm'])

    const uk = byId.get('uk')!
    expect(uk.turns).toBe(0)
    expect(uk.run.messages.filter((m) => m.dir === 'out')).toEqual([])
    expect(uk.quality).toBeNull()

    expect(out.lines.join('\n')).toContain('hard-assertion breaches: 0 in 0 conversations')
  }, 120_000)
})
