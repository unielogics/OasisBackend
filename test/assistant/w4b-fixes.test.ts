// The W4b fixes' pure parts (ADR 0160 W4b, after the conversation eval's independent check): the conversation language and the
// server's own words in it (X5), the disclosure on whichever text goes first (X1), card numbers masked at rest (X6), the claim check
// (X3) and the judge's facts and server record (X2, X3). The seams themselves are in runtime-e2e.test.ts.
import { describe, expect, it } from 'vitest'
import { placeholderValues } from '../../src/modules/assistant/facts.js'
import { actionClaims, guardReply, HARD_PROBLEMS, PROBLEM_HINTS } from '../../src/modules/assistant/guard.js'
import {
  JUDGE_ACTION_RULE,
  JUDGE_CATEGORIES,
  JUDGE_FACTS_RULE,
  JUDGE_HINTS,
  JUDGE_RUBRIC,
  judgeMessage,
  judgeRequest,
  parseVerdict,
} from '../../src/modules/assistant/judge.js'
import {
  actionConfirmText,
  CARD_LINES,
  detectLanguage,
  DISCLOSURE,
  FALLBACK_TEXTS,
  SAFETY_LINES,
  withDisclosure,
} from '../../src/modules/assistant/lang.js'
import {
  PROMPT_VERSION,
  renderTurnContext,
  STATIC_RULES,
  type TurnContextData,
} from '../../src/modules/assistant/prompt.js'
import { composeReply } from '../../src/modules/assistant/turn.js'
import { isGsm7 } from '../../src/integrations/sms/gsm.js'
import { holdsCardNumber, maskCardNumbers } from '../../src/modules/messaging/inbound/cards.js'
import { hasStopNotice } from '../../src/modules/messaging/policy/body.js'
import { maskInboundCards } from '../../src/modules/messaging/webhook.js'
import { redactText } from '../../src/modules/assistant/transcript.js'
import { maskForModel } from '../../src/modules/assistant/context.js'
import type { ShopFacts } from '../../src/modules/assistant/contract.js'

describe('X5: the conversation language', () => {
  it('detects Spanish and English from the client’s texts; a name, "ok" or a time decides nothing', () => {
    for (const t of [
      'Hola, cuánto cuesta un lavado?',
      'Quiero reservar un lavado',
      'Me llamo Luis',
      '¿Abren el domingo?',
      'buenos dias, necesito una cita para mañana',
      'Hola',
    ])
      expect(detectLanguage([t]), t).toBe('es')
    for (const t of [
      'How much is a wash?',
      'Can I book a Signature wash tomorrow at 10?',
      'Gold sounds good, how do I sign up?',
      'what time do you close',
    ])
      expect(detectLanguage([t]), t).toBe('en')
    for (const t of ['ok', 'Jake', 'Lena', '10am works', '👍', '483920'])
      expect(detectLanguage([t]), t).toBeNull()
  })

  it('the server’s own words exist in both languages, as GSM-7 the phone shows them; the Spanish footer counts as the STOP notice', () => {
    for (const lang of ['en', 'es'] as const) {
      for (const t of [
        DISCLOSURE[lang].open,
        DISCLOSURE[lang].footer,
        SAFETY_LINES[lang],
        CARD_LINES[lang],
        FALLBACK_TEXTS[lang],
        actionConfirmText('X', lang),
      ])
        expect(isGsm7(t.replace(/[’—]/g, "'")), t).toBe(true)
      expect(hasStopNotice(withDisclosure('Hi', lang))).toBe(true)
    }
    expect(withDisclosure('Hola!', 'es')).toBe(
      'Asistente automatizado de Oasis Auto Spa. Hola! Responde STOP para no recibir mas mensajes.',
    )
    expect(actionConfirmText('Signature Hand Wash, Mon Jun 15 at 10:00 AM', 'es')).toBe(
      'Signature Hand Wash, Mon Jun 15 at 10:00 AM. Responde {code} para confirmar.',
    )
    expect(hasStopNotice('Responde STOP para no recibir mas mensajes.')).toBe(true)
    expect(hasStopNotice('Hola Stop')).toBe(false)
  })

  it('composeReply: the disclosure, the footer, the safety and card lines in the conversation’s language (English unchanged)', () => {
    const links = new Map([['{link1}', 'https://x/#/v/abc']])
    expect(composeReply({ text: 'Hola!', disclose: true, links: new Map(), lang: 'es' }).text).toBe(
      withDisclosure('Hola!', 'es'),
    )
    expect(
      composeReply({ text: 'Aqui: {link1}', disclose: false, links, safety: true, card: true, lang: 'es' })
        .text,
    ).toBe(`Aqui: {link1} ${SAFETY_LINES.es} ${CARD_LINES.es}`)
    expect(composeReply({ text: 'Hi!', disclose: true, links: new Map() }).text).toBe(
      'Oasis Auto Spa’s automated assistant here. Hi! Reply STOP to opt out.',
    )
  })

  it('the placeholders render in Spanish for a Spanish conversation', () => {
    const facts = {
      catalog: {
        items: [
          {
            key: 'sig',
            name: 'Signature Hand Wash',
            kind: 'package',
            quoteOnly: false,
            memberFromCents: 4500,
            guestFromCents: 5400,
          },
          {
            key: 'cer',
            name: 'Ceramic Coating',
            kind: 'package',
            quoteOnly: true,
            memberFromCents: null,
            guestFromCents: null,
          },
        ],
        tint: [
          {
            vehicle: 'sedan',
            film: 'carbon',
            vehicleLabel: 'Sedan / Coupe',
            filmLabel: 'Carbon',
            memberFromCents: 22900,
            guestFromCents: 27900,
          },
        ],
      },
      plans: [
        {
          key: 'gold',
          label: 'Gold',
          monthlyPriceCents: 9900,
          perks: ['4 hand washes a month', 'No booking fees'],
        },
      ],
      fee: { guestBookingFeeCents: 2500 },
    } as unknown as ShopFacts
    const es = placeholderValues(facts, { lang: 'es', balanceCents: 1250, confirmTexted: true })
    expect(Object.fromEntries(es)).toEqual({
      '{price:sig}': 'Signature Hand Wash: desde $45 para miembros, $54 para los demas',
      '{price:cer}': 'Ceramic Coating: precio por cotizacion - envianos una foto',
      '{price:tint:sedan:carbon}':
        'Polarizado Carbon para Sedan/Coupe: desde $229 para miembros, $279 para los demas',
      '{plan:gold}': 'Gold cuesta $99 al mes',
      '{perks:gold}': 'Gold incluye: 4 hand washes a month; no booking fees',
      '{fee}': 'Quienes no son miembros pagan una tarifa de reserva de $25',
      '{balance}': 'Tu saldo pendiente es $12.50',
      '{confirm}': 'Te acabo de enviar los detalles para confirmar',
    })
    for (const v of es.values()) expect(isGsm7(v), v).toBe(true)
    // English stays the default
    expect(placeholderValues(facts).get('{price:sig}')).toBe(
      'Signature Hand Wash starts at $45 for members, $54 otherwise',
    )
  })

  it('the turn context names a Spanish conversation; the prompt says the server writes its parts in the client’s language', () => {
    const base: TurnContextData = {
      nowLabel: 'n',
      firstName: null,
      unknownNumber: true,
      firstContact: true,
      trusted: false,
      trustUntilLabel: null,
      actionsEnabled: true,
      membership: null,
      vehicles: [],
      appointments: [],
      intake: 'name',
    }
    expect(renderTurnContext({ ...base, language: 'es' })).toContain(
      'Language: Spanish (write your text in Spanish).',
    )
    expect(renderTurnContext(base)).not.toContain('Language:')
    expect(STATIC_RULES).toContain(
      'the server writes its own parts (prices, the disclosure, the security lines) in that language too',
    )
    expect(PROMPT_VERSION).toMatch(/^w4b-2026-10-13\.\d+$/)
  })
})

describe('X6: card numbers at rest', () => {
  it('a Luhn-valid 13 to 19 digit number becomes "[card ending 1234]"; a phone number, a wrong digit or a short run stays', () => {
    expect(maskCardNumbers('My card is 4111 1111 1111 1111 exp 04/28')).toBe(
      'My card is [card ending 1111] exp 04/28',
    )
    expect(maskCardNumbers('5500-0000-0000-0004 and 378282246310005')).toBe(
      '[card ending 0004] and [card ending 0005]',
    )
    expect(maskCardNumbers('4111 1111 1111 1112')).toBe('4111 1111 1111 1112')
    expect(maskCardNumbers('call me at 201 555 0123')).toBe('call me at 201 555 0123')
    expect(holdsCardNumber('[card ending 1111]')).toBe(true)
    expect(holdsCardNumber('4111111111111111')).toBe(true)
    expect(holdsCardNumber('no card here 1234')).toBe(false)
  })

  it('the stored webhook delivery masks its text fields only (timestamps and ids untouched); transcripts and the model’s view mask it too', () => {
    const raw = JSON.stringify({
      id: 'e1',
      event: 'sms:received',
      at: 1791771988000,
      payload: { messageId: 'm-4111111111111111', message: 'card 4111111111111111 thanks', receivedAt: 'x' },
    })
    const out = JSON.parse(maskInboundCards(raw)) as {
      at: number
      payload: { messageId: string; message: string }
    }
    expect(out.payload.message).toBe('card [card ending 1111] thanks')
    expect(out.at).toBe(1791771988000)
    expect(out.payload.messageId).toBe('m-4111111111111111')
    expect(maskInboundCards('{"payload":{"message":"hi"}}')).toBe('{"payload":{"message":"hi"}}')
    expect(maskInboundCards('not json 4111 1111 1111 1111')).toBe('not json [card ending 1111]')
    expect(redactText('pay with 4111 1111 1111 1111')).toBe('pay with [card ending 1111]')
    expect(maskForModel('pay with 4111-1111-1111-1111')).toBe('pay with [card ending 1111]')
  })
})

describe('X3: claims that an action was done', () => {
  it('finds "all set", "you’re booked", "I’ve cancelled it", Spanish claims; not questions, conditions or what is not done yet', () => {
    for (const t of [
      'Monday the 19th at 10:00 AM is all set to go.',
      "You're booked for Saturday at 9:00 AM!",
      'Your appointment has been moved to Friday at 3:00 PM.',
      "I've cancelled your visit.",
      "You're confirmed for tomorrow.",
      'We have you down for Monday at 10.',
      'Listo, ya esta reservado para el lunes.',
      'Te agende para el viernes a las 11.',
    ])
      expect(actionClaims(t), t).not.toEqual([])
    for (const t of [
      'Nothing is booked until you confirm with that text.',
      'Once you reply with that text, you are all set.',
      "You'll be all set once you confirm.",
      'Is it all set?',
      'Want me to book you for Monday at 10?',
      'That time is booked, but 11:00 AM is open.',
      'The wash is done by hand.',
      'Here is your link to pick a time: {link1}',
      'I just texted you the details with how to confirm.',
      'Cuando confirmes, queda reservado.',
    ])
      expect(actionClaims(t), t).toEqual([])
  })

  it('guardReply flags a claim only when asked to (nothing done, no rewrite used yet)', () => {
    const base = { text: "You're all set for Monday at 10:00 AM!", website: 'https://oasisautospanj.com' }
    expect(guardReply({ ...base, checkActionClaims: true })).toMatchObject({
      kind: 'fix',
      problems: ['action_claim'],
    })
    expect(guardReply(base)).toMatchObject({ kind: 'ok' })
  })
})

describe('X2/X3: the judge reads the shop facts and the server record', () => {
  it('two new fail categories, their hints, the rubric rules; facts as a cached second system block; the record after the message', () => {
    expect(JUDGE_CATEGORIES).toEqual([
      'none',
      'price',
      'promise',
      'secret',
      'link_or_phone',
      'other',
      'facts',
      'action',
    ])
    expect(parseVerdict('{"reason":"invents a waiting area","category":"facts","ok":false}')).toEqual({
      ok: false,
      category: 'facts',
      reason: 'invents a waiting area',
    })
    expect(parseVerdict('{"reason":"says it is booked","category":"action","ok":false}')).toEqual({
      ok: false,
      category: 'action',
      reason: 'says it is booked',
    })
    expect(JUDGE_HINTS.facts).toMatch(/the team can confirm that/)
    expect(JUDGE_HINTS.action).toMatch(/never say so/i)
    // rules (f) and (g) go with the facts and the record only (guard polish after W4b-fix)
    expect(JUDGE_RUBRIC).not.toContain('(f) facts:')
    expect(JUDGE_FACTS_RULE).toContain('(f) facts:')
    // rule (g) is its own system block, sent only with a server record (guard polish after W4b-fix)
    expect(JUDGE_RUBRIC).not.toContain('(g) action:')
    expect(JUDGE_ACTION_RULE).toContain('(g) action:')
    // a link offered to do it is no claim; pointing to a link texted earlier writes no address (W4b spot check on Bedrock)
    expect(JUDGE_ACTION_RULE).toContain('Not claims: a link or an offer to book, move or cancel')
    expect(JUDGE_RUBRIC).toContain('Pointing to a link the shop texted ("the link I texted you", "the booking link above") writes no address and passes.')
    expect(JUDGE_RUBRIC).toContain('|facts|action","ok":false}')
    const seg = [{ text: 'Yes, there is a waiting area.', trusted: false }]
    const req = judgeRequest(seg, 120, 'abcd1234', {
      facts: 'SHOP FACTS\nBusiness: X',
      record: 'Done by the server: nothing.',
    })
    expect(req.system).toEqual([
      { text: JUDGE_RUBRIC, cache: true },
      { text: JUDGE_FACTS_RULE },
      { text: 'SHOP FACTS\nBusiness: X', cache: true },
      { text: JUDGE_ACTION_RULE, cache: true },
    ])
    expect(judgeRequest(seg, 120, 'abcd1234', { facts: 'SHOP FACTS\nBusiness: X' }).system).toHaveLength(3)
    expect(judgeMessage(seg, 'abcd1234', 'Done <by> the server: nothing.')).toBe(
      '<message key="abcd1234" trusted-parts="0">\nYes, there is a waiting area.\n</message>\n<own-text>\nYes, there is a waiting area.\n</own-text>\n<server-record>\nDone ‹by› the server: nothing.\n</server-record>',
    )
    // without facts or a record (the guard eval): the W4a request
    expect(judgeRequest(seg, 120, 'abcd1234').system).toEqual([{ text: JUDGE_RUBRIC, cache: true }])
    expect(judgeMessage(seg, 'abcd1234')).not.toContain('server-record')
  })

  it('the prompt forbids invented shop facts and claims of actions the server did not take; untrusted bookings get the link, not times', () => {
    expect(STATIC_RULES).toContain('ONLY WHAT SHOP FACTS SAY')
    expect(STATIC_RULES).toContain('otherwise say "the team can confirm that"')
    expect(STATIC_RULES).toContain(
      'Never say anything is booked, moved, cancelled, confirmed, reserved or "all set" unless the server did it',
    )
    expect(STATIC_RULES).toContain("here's your link to pick a time: {link1}")
    expect(STATIC_RULES).toContain('Never list or offer specific times')
    expect(STATIC_RULES).toContain('even when the day or the time is still open and even for a new client')
    expect(STATIC_RULES).toContain('A vehicle is never needed to book: when the client has not named one, propose with vehicle null')
  })
})

describe('the full Bedrock run: the model’s own notes never reach the client', () => {
  it('a note about "the client", a self-correction or a recited writing rule is a hard problem (one rewrite, then the fallback)', () => {
    // book-trusted-thursday (unseeded run 1791782709) and the X spot checks: both passed the judge and went out
    for (const text of [
      "The client hasn't clarified which service they want. I need to ask one more time gently. Hey Jonathan, Express or Premium?",
      'Wait - no emoji, plain text only. Let me redo: Hi Ana! Want to book?',
      'Let me rewrite that. Hi! We open at 8.',
      'El cliente no dijo que lavado quiere. Hola Luis, ¿cual prefieres?',
    ]) {
      const v = guardReply({ text, website: 'https://oasisautospanj.com' })
      expect(v.kind, text).toBe('fix')
      if (v.kind === 'fix') expect(v.problems, text).toContain('meta')
    }
    expect(HARD_PROBLEMS.has('meta')).toBe(true)
    expect(PROBLEM_HINTS.meta).toContain('Write only the text the client reads')
    // ordinary texts pass
    for (const text of [
      'Let me check that for you. We open at 8 AM.',
      'Our clients love the Signature wash. Want to book?',
      'No problem, the team can confirm that and will text you back.',
      'Clients can confirm a booking by replying C to the confirmation text.',
    ])
      expect(guardReply({ text, website: 'https://oasisautospanj.com' }).kind, text).toBe('ok')
  })
})
