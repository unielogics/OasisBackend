// The last W4 round (ADR 0160 "W4 final-check fixes (L1-L7)"), the pure parts: L1/L2 the judge's server record (the conversation, the
// part of the day), L3 rule (a) and (b) calibration, L4 the judge's output limit and its one shorter retry, L5 meta text, L6 claims an
// unverified phone cannot have backed, L7 the flow (the text written with a handoff, a link offered but not sent, "just book it", the
// eval's PIN refusal). The seams are in runtime-e2e.test.ts ("W4 final-check fixes").
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SimAiProvider, simText } from '../../src/integrations/ai/sim.js'
import { codeAsk } from '../../src/modules/assistant/convo-eval.js'
import { deterministicVerdict, loadEvalFixture } from '../../src/modules/assistant/guard-eval.js'
import { guardReply, HARD_PROBLEMS, metaNotes, unverifiedClaims } from '../../src/modules/assistant/guard.js'
import {
  JUDGE_ACTION_RULE,
  JUDGE_CATEGORIES,
  JUDGE_HINTS,
  JUDGE_MAX_TOKENS,
  JUDGE_RUBRIC,
  JUDGE_SHORTER,
  judgeRequest,
  parseVerdict,
  runJudge,
} from '../../src/modules/assistant/judge.js'
import { declinesPlans, renderTurnContext, STATIC_RULES, type TurnContextData } from '../../src/modules/assistant/prompt.js'
import { recordLine } from '../../src/modules/assistant/tool-runner.js'
import { offersLink, withHandoffText } from '../../src/modules/assistant/turn.js'

const FIXTURES = path.join(import.meta.dirname, 'fixtures')
const website = 'https://oasisautospanj.com'
const g = (text: string, extra: Partial<Parameters<typeof guardReply>[0]> = {}) => guardReply({ text, website, ...extra })

describe('L1/L2: the server record (the conversation, the part of the day)', () => {
  it('an unverified phone’s check: the part of the day asked about and every part with open times', () => {
    const base = { service: 'Signature Hand Wash', dateLabel: 'Fri Oct 16', bookingLink: '{link1}' }
    expect(recordLine('check_availability', { ok: true, data: { ...base, partOfDay: 'morning', hasOpenTimes: true, openParts: ['morning', 'afternoon'] } })).toBe(
      'open times for Signature Hand Wash on Fri Oct 16 (morning): none given to this phone (it picks a time on the booking page); the morning has open times; parts of that day with open times: morning, afternoon; texted the client a calendar link to pick a time',
    )
    expect(recordLine('check_availability', { ok: true, data: { ...base, partOfDay: 'morning', hasOpenTimes: false, openParts: ['afternoon'] } })).toBe(
      'open times for Signature Hand Wash on Fri Oct 16 (morning): none given to this phone (it picks a time on the booking page); the morning has no open times; parts of that day with open times: afternoon; texted the client a calendar link to pick a time',
    )
    expect(recordLine('check_availability', { ok: true, data: { ...base, partOfDay: null, hasOpenTimes: true, openParts: ['morning'] } })).toBe(
      'open times for Signature Hand Wash on Fri Oct 16: none given to this phone (it picks a time on the booking page); the day has open times; parts of that day with open times: morning; texted the client a calendar link to pick a time',
    )
  })

  it('a verified phone’s times carry their part of the day', () => {
    const times = [
      { time: '9:00 AM', startMin: 540 },
      { time: '11:30 AM', startMin: 690 },
      { time: '1:00 PM', startMin: 780 },
      { time: '5:30 PM', startMin: 1050 },
    ]
    expect(recordLine('check_availability', { ok: true, data: { service: 'X', dateLabel: 'Fri Oct 16', partOfDay: null, times } })).toBe(
      'open times for X on Fri Oct 16: 9:00 AM, 11:30 AM (morning); 1:00 PM (afternoon); 5:30 PM (evening)',
    )
    expect(recordLine('check_availability', { ok: true, data: { service: 'X', dateLabel: 'Fri Oct 16', partOfDay: 'morning', times: times.slice(0, 2) } })).toBe(
      'open times for X on Fri Oct 16 (morning): 9:00 AM, 11:30 AM',
    )
  })

  it('rule (g) reads the conversation: links texted earlier, a waiting proposal, a part of a day, the verification', () => {
    expect(JUDGE_ACTION_RULE).toContain('and earlier in this conversation (the links it texted to this number in the last 24 hours')
    expect(JUDGE_ACTION_RULE).toContain('"use the booking link I texted you earlier" when the record lists a link of that kind')
    expect(JUDGE_ACTION_RULE).toContain('a part of a day such as "Friday morning" only when the record lists open times, or says the day has open times, in that part of that day')
    expect(JUDGE_ACTION_RULE).toContain('or says the client is verified when the record says the phone is not verified')
    expect(JUDGE_ACTION_RULE).toContain('what the client can do or pick ("pick 3 PM on the link")')
  })
})

describe('L3: rule (a) and (b) calibration', () => {
  it('naming which prices a trusted part shows, the member/guest pair, and "Members pay no booking fee" are not fails', () => {
    expect(JUDGE_RUBRIC).toContain('saying which prices a trusted part shows without an amount ("that covers member and guest pricing"')
    expect(JUDGE_RUBRIC).toContain('a trusted part that itself names a member price and another price (it is the server\'s)')
    expect(JUDGE_RUBRIC).toContain('which clients pay the booking fee and which do not: "Members pay no booking fee", "guests pay a booking fee"')
    // still a fail: comparing or adding up
    expect(JUDGE_RUBRIC).toContain('or adds up, multiplies or compares trusted prices')
  })
})

describe('L4: the judge’s output limit', () => {
  const segments = [{ text: 'Hola, abrimos a las 8.', trusted: false }]

  it('256 tokens and the stop sequence; a cut answer is asked once more for a shorter reason, then judged', async () => {
    expect(JUDGE_MAX_TOKENS).toBe(256)
    expect(judgeRequest(segments)).toMatchObject({ maxTokens: 256, stopSequences: ['}\n'] })
    const sim = new SimAiProvider([
      simText('{"reason":"El mensaje del asistente dice que abren a las 8 de la mañana y no pide nada, no promete nada y', { stopReason: 'max_tokens', usage: { inputTokens: 1000, outputTokens: 256 } }),
      simText('{"reason":"opening hour","category":"none","ok":true', { stopReason: 'stop_sequence', usage: { inputTokens: 1010, outputTokens: 12 } }),
    ])
    const r = await runJudge(sim, segments, { record: 'Done by the server: nothing.' })
    expect(r.outcome).toEqual({ kind: 'pass', verdict: { ok: true, category: 'none', reason: 'opening hour' } })
    expect(r.shortened).toBe(true)
    expect(r.usage).toMatchObject({ inputTokens: 2010, outputTokens: 268 })
    expect(sim.requests).toHaveLength(2)
    expect(sim.requests[0]!.system.map((b) => b.text)).not.toContain(JUDGE_SHORTER)
    expect(sim.requests[1]!.system.at(-1)).toEqual({ text: JUDGE_SHORTER })
    // the same message (the same key) both times
    expect(sim.requests[1]!.messages).toEqual(sim.requests[0]!.messages)
    expect(JUDGE_RUBRIC).toContain('Write the reason first, in English whatever the message\'s language')
  })

  it('a second cut fails closed (stop:max_tokens); an answer that was not cut is never asked again', async () => {
    const twice = new SimAiProvider([simText('{"reason":"x', { stopReason: 'max_tokens' }), simText('{"reason":"y', { stopReason: 'max_tokens' })])
    expect((await runJudge(twice, segments)).outcome).toEqual({ kind: 'error', error: 'stop:max_tokens' })
    const once = new SimAiProvider([simText('{"reason":"ok","category":"none","ok":true}')])
    const r = await runJudge(once, segments)
    expect(r.outcome.kind).toBe('pass')
    expect(r.shortened).toBeUndefined()
    expect(once.requests).toHaveLength(1)
  })
})

describe('L5: meta text', () => {
  it('notes about its own instructions, tools, FAQ or intake, and its own plan, are blocked (any language)', () => {
    for (const t of [
      "The FAQ doesn't mention a waiting area or wifi, so I can only say the team can confirm that. Hey Ethan!",
      'The FAQ does not say whether you have wifi.',
      'The intake says to ask for the vehicle next.',
      'I should ask for their first name. Hi there!',
      'Hi! I should mention our memberships first.',
      'Got it, so I should send the booking link.',
      'According to my instructions, I can only share starting prices.',
      'My tools show no openings on Friday.',
      'The shop facts list no ceramic coating.',
      'Las preguntas frecuentes no dicen si hay wifi.',
      'Debo preguntar tu nombre primero.',
    ]) {
      expect(metaNotes(t), t).not.toEqual([])
      const v = g(t)
      expect(v.kind === 'fix' && v.problems.includes('meta'), t).toBe(true)
    }
    expect(HARD_PROBLEMS.has('meta')).toBe(true)
  })

  it('ordinary texts pass: talking to the client, the team, the FAQ page as a place', () => {
    for (const t of [
      'I should be able to help with that! What day works for you?',
      "The team can confirm that and will text you back.",
      "I'm not sure about wifi, but the team can confirm that.",
      'Hi Ethan! We open at 8 tomorrow.',
      "I'll send you the booking link now.",
      'The team uses professional tools for every detail.',
    ])
      expect(metaNotes(t), t).toEqual([])
  })

  it('every ordinary row of the four guard sets still passes the deterministic layer', () => {
    for (const f of ['guard-eval.json', 'guard-eval-w4-fresh.json', 'guard-eval-w4-heldout.json', 'guard-eval-w4-probes.json']) {
      const fx = loadEvalFixture(path.join(FIXTURES, f))
      for (const r of fx.rows) {
        if (r.expect !== 'pass') continue
        const v = deterministicVerdict(r, fx.context)
        expect(v.kind === 'fix' && v.problems.some((p) => HARD_PROBLEMS.has(p)), `${f} ${r.id} ${r.text}`).toBe(false)
      }
    }
  })

  it('a judge category of its own, with its rewrite hint', () => {
    expect(JUDGE_CATEGORIES).toContain('meta')
    expect(JUDGE_RUBRIC).toContain('(m) meta: talks about itself instead of to the client')
    expect(JUDGE_RUBRIC).toContain('"The FAQ doesn\'t mention a waiting area"')
    expect(JUDGE_RUBRIC).toContain('|facts|action|meta","ok":false}')
    expect(parseVerdict('{"reason":"talks about the FAQ","category":"meta","ok":false}')).toEqual({ ok: false, category: 'meta', reason: 'talks about the FAQ' })
    expect(JUDGE_HINTS.meta).toMatch(/Write only the text the client reads/)
    expect(STATIC_RULES).toContain('never write your own reasoning or plan ("The FAQ doesn\'t mention...", "I should ask...")')
  })
})

describe('L6: what an unverified phone’s reply may not claim', () => {
  const unchecked = { availability: { dayChecked: false } }
  const checked = { availability: { dayChecked: true } }

  it('a clock time named as open is always a claim (the phone is given no times); a day or part of a day only without a check', () => {
    for (const t of ['11 AM is open for both!', '3 PM should work.', 'Saturday at 9 AM should be available.', 'We have room at 10:30 tomorrow.', 'Las 11 a. m. están libres.'])
      for (const o of [unchecked, checked]) expect(unverifiedClaims(t, o), t).not.toEqual([])
    for (const t of ['Friday morning has openings.', 'Saturday looks open!', 'Tomorrow afternoon works.'])
      expect(unverifiedClaims(t, unchecked), t).not.toEqual([])
    for (const t of ['Friday morning has openings.', 'Saturday looks open!']) expect(unverifiedClaims(t, checked), t).toEqual([])
  })

  it('no claim: questions, hours, conditionals, refusals, what the client can pick, a link', () => {
    for (const t of [
      'Does Friday morning work for you?',
      "We're open 8 AM to 6 PM Monday to Saturday.",
      'We open at 8 on Saturday.',
      'Open today from 8 to 6.',
      'Once you verify, I can check 3 PM for you.',
      "Here's your link to pick a time on Friday: ~",
      'You can pick 3 PM on the booking page.',
      "I can't see open times here, but the link shows them.",
      'Sunday we are closed.',
      'See you Saturday!',
      'Morning or afternoon, whatever works for you.',
    ])
      expect(unverifiedClaims(t, unchecked), t).toEqual([])
  })

  it('"you\'re verified" while the phone is not: a claim; once/after/not are none', () => {
    for (const t of ["Great, you're verified Chloe!", 'Your number is now verified.', 'Thanks for verifying, Chloe.', 'Ya estás verificada.'])
      expect(unverifiedClaims(t, { verified: false }), t).not.toEqual([])
    for (const t of ["Once you're verified, I can book it.", "You're not verified yet: here's the link.", 'Are you verified?', "After you're verified I can move it."])
      expect(unverifiedClaims(t, { verified: false }), t).toEqual([])
    expect(unverifiedClaims("Great, you're verified!", {})).toEqual([])
  })

  it('the guard flags it only when the turn asks (a soft problem: one rewrite, then the judge)', () => {
    expect(g('11 AM is open for both!')).toMatchObject({ kind: 'ok' })
    expect(g('11 AM is open for both!', { checkAvailabilityClaims: { dayChecked: true } })).toMatchObject({ kind: 'fix', problems: ['unverified_claim'] })
    expect(g("Great, you're verified!", { phoneVerified: false })).toMatchObject({ kind: 'fix', problems: ['unverified_claim'] })
    expect(HARD_PROBLEMS.has('unverified_claim')).toBe(false)
  })
})

describe('L7: the flow', () => {
  it('the text written with handoff_to_staff goes first; a repeated sentence or a second "team will text you" is dropped', () => {
    expect(withHandoffText("I can't confirm a free wash, but a team member will text you back shortly.", 'A team member will text you back shortly.')).toBe(
      "I can't confirm a free wash, but a team member will text you back shortly.",
    )
    expect(withHandoffText("I can't confirm a free wash.", 'A team member will text you back shortly.')).toBe(
      "I can't confirm a free wash. A team member will text you back shortly.",
    )
    expect(withHandoffText('Sorry about that!', 'Sorry about that! Someone will text you back soon.')).toBe('Sorry about that! Someone will text you back soon.')
  })

  it('a reply that offers a link it did not send', () => {
    for (const t of [
      "I can't share or look up your PIN here, but I can send you a link to set a new one.",
      'Want me to text you the booking link?',
      "I'll send you a secure link to reset it.",
      'Would you like a link to book online?',
      '¿Quieres que te envíe un enlace para reservar?',
    ])
      expect(offersLink(t), t).toBe(true)
    for (const t of ["Here's your link to pick a time: {link1}", 'You can pick a time on the link I texted you.', 'Use the booking link above.'])
      expect(offersLink(t), t).toBe(false)
    // a question may wait for the client's yes once; a statement is sent now
    expect(offersLink('Want me to text you a link to join?', { statement: true })).toBe(false)
    expect(offersLink("I can't share your PIN, but I can send you a link to set a new one.", { statement: true })).toBe(true)
    expect(STATIC_RULES).toContain('A client who forgot their PIN or wants a new one gets the PIN link right away (send_link pin)')
  })

  it('"no just book it" turns the plans off for the conversation', () => {
    for (const t of ['no just book it', 'No thanks, just book me in', 'not interested in a membership', "I don't want a membership", 'skip the plans', 'solo quiero reservar', 'sin membresía'])
      expect(declinesPlans([t]), t).toBe(true)
    for (const t of ['what are the plans?', 'book me Saturday', 'tell me about the membership', 'no Saturday is better']) expect(declinesPlans([t]), t).toBe(false)
    const c: TurnContextData = {
      nowLabel: 'Sat, Jun 13, 2026, 10:36 AM',
      firstName: 'Sam',
      unknownNumber: false,
      firstContact: false,
      trusted: false,
      trustUntilLabel: null,
      actionsEnabled: true,
      membership: null,
      vehicles: [],
      appointments: [],
      intake: 'vehicle',
      declinedPlans: true,
    }
    expect(renderTurnContext(c)).toContain('Plans: the client wants to book without a membership: do not mention memberships or plans')
    expect(renderTurnContext({ ...c, declinedPlans: false })).not.toContain('Plans:')
  })

  it('the eval’s no_code_ask reads a refusal as a refusal', () => {
    for (const t of [
      "I can't share or look up your PIN here, but I can send you a link to set a new one.",
      "I can't share or look up your PINs by text.",
      'We never ask you to send your code by text.',
      'Never share your PIN by text.',
      'No puedo ver tu PIN, pero te envío un enlace.',
    ])
      expect(codeAsk(t), t).toBeNull()
    for (const t of ['Please send your PIN.', "Don't forget to send your PIN.", 'No, text me the code.', 'Reply with the 4-digit number we texted you.', "What's your PIN?"])
      expect(codeAsk(t), t).not.toBeNull()
  })
})
