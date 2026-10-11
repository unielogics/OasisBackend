// The output guard (ADR 0160, design sections 3 and 3b): plain GSM-7 text, the 320-character limit, no web address but the shop's
// own and the server's placeholders, the pricing rule (only starting prices / plan prices / the fee of the CURRENT facts, a service
// price introduced by "starts at" or "from", never a total or a combination), handoff words, never asking for a PIN or a card.
import { describe, expect, it } from 'vitest'
import {
  asksForSecret,
  cutAfterFirstQuestion,
  cutAtSentence,
  findAmounts,
  guardReply,
  handoffWords,
  MAX_REPLY_CHARS,
  stripMarkdown,
  toGsm7,
} from '../../src/modules/assistant/guard.js'
import type { FactAmounts } from '../../src/modules/assistant/facts.js'

// Signature Hand Wash starts at $45 for members, $54 otherwise; tint from $229 / $275; Gold $99 a month; the guest fee $25
const amounts: FactAmounts = { starting: new Set([4500, 5400, 22900, 27500, 3200, 3800]), plain: new Set([9900, 16900, 2500]) }
const website = 'https://oasisautospanj.com'
const g = (text: string, extra: { extraAmounts?: number[]; placeholders?: string[] } = {}) => guardReply({ text, amounts, website, ...extra })

describe('the pricing rule (design section 3b)', () => {
  it('accepts a starting price introduced by "starts at", "starting at" or "from", member and guest in one sentence', () => {
    expect(g('Our Signature Hand Wash starts at $45 for members, $54 otherwise.')).toEqual({
      kind: 'ok',
      text: 'Our Signature Hand Wash starts at $45 for members, $54 otherwise.',
    })
    expect(g('Window tint for a sedan is from $229.').kind).toBe('ok')
    expect(g('Starting at $32 for members, the Exterior Hand Wash is quick.').kind).toBe('ok')
  })

  it('blocks a total: "$54 total"', () => {
    expect(g('A Signature wash is $54 total.')).toMatchObject({ kind: 'fix', problems: expect.arrayContaining(['price_combination']) })
    expect(g('That comes to $54 total with the add-on.')).toMatchObject({ kind: 'fix' })
  })

  it('blocks a combination: "$99 for both"', () => {
    expect(g('You can get the wash and tint for $99 for both.')).toMatchObject({ kind: 'fix', problems: expect.arrayContaining(['price_combination']) })
    expect(g('It starts at $45 plus $10 for wax.')).toMatchObject({ kind: 'fix' })
  })

  it('blocks an amount that is not in the current facts, and a service price without "starts at" / "from"', () => {
    expect(g('A wash starts at $40.')).toMatchObject({ kind: 'fix', problems: ['price_unknown'] })
    expect(g('A Signature wash is $45 for members.')).toMatchObject({ kind: 'fix', problems: ['price_unqualified'] })
    expect(g('That would be 45 dollars.')).toMatchObject({ kind: 'fix', problems: ['price_unqualified'] })
  })

  it('states plan prices, the guest fee and a balance a tool declared as they are', () => {
    expect(g('Gold is $99 a month and VIP is $169 a month.').kind).toBe('ok')
    expect(g('Guests pay a $25 booking fee at the shop.').kind).toBe('ok')
    expect(g('Your open balance is $12.50.').kind).toBe('fix')
    expect(g('Your open balance is $12.50.', { extraAmounts: [1250] }).kind).toBe('ok')
  })

  it('reads every form of an amount', () => {
    expect(findAmounts('$45, $1,299, $45.50, 45 dollars and 12 bucks').map((a) => a.cents)).toEqual([4500, 129900, 4550, 4500, 1200])
  })
})

describe('handoff words', () => {
  it('hands refunds, discounts, free things, guarantees, "ready by", damage and legal words to a person', () => {
    for (const t of [
      'We can refund that.',
      'I can give you a 10% discount.',
      'The tire shine is free with any wash.',
      'We guarantee no streaks.',
      'Your car will be ready by 3 PM.',
      'Sorry about the damage to your mirror.',
      'Please talk to our lawyer.',
    ])
      expect(g(t).kind, t).toBe('handoff')
    expect(handoffWords('Feel free to text us. We have a free slot at 2 PM, spot-free rinse included.')).toEqual([])
  })

  it("lets the owner's own wording through (a perk or an FAQ answer of the facts), nothing else", () => {
    const factsText = '- vip: $169 a month. perks: everything in gold; priority booking and same-day guarantee.'
    expect(guardReply({ text: 'VIP adds priority booking and a same-day guarantee.', amounts, website, factsText }).kind).toBe('ok')
    expect(guardReply({ text: 'We guarantee your car will shine.', amounts, website, factsText }).kind).toBe('handoff')
  })
})

describe('links and placeholders', () => {
  it('blocks any web address but the shop website as text and the registered placeholders', () => {
    expect(g('Book here: https://evil.example.com/x').kind).toBe('fix')
    expect(g('See www.oasisautospanj.com for hours.').kind).toBe('fix')
    expect(g('Our website oasisautospanj.com has the hours.').kind).toBe('ok')
    expect(g('Visit bit.ly/abc to book.').kind).toBe('fix')
    expect(g('Pick a time here: {link1}', { placeholders: ['{link1}'] }).kind).toBe('ok')
    expect(g('Pick a time here: {link2}', { placeholders: ['{link1}'] })).toMatchObject({ kind: 'fix', problems: ['unknown_placeholder'] })
  })
})

describe('secrets', () => {
  it('never asks for a PIN, a code, a password or card numbers by text', () => {
    expect(asksForSecret('Please text me your PIN.')).toBe(true)
    expect(asksForSecret('What is your card number?')).toBe(true)
    expect(asksForSecret('Reply with the code we sent.')).toBe(true)
    expect(asksForSecret('Open the link and enter your PIN on the secure page.')).toBe(false)
    expect(g('Send me your credit card number to hold the spot.')).toMatchObject({ kind: 'fix', problems: ['secret_request'] })
  })
})

describe('form', () => {
  it('strips markdown and lists into one plain line, GSM-7 only', () => {
    expect(stripMarkdown('**Hours:**\n- Mon 8:00 AM\n- Tue 8:00 AM')).toBe('Hours: Mon 8:00 AM Tue 8:00 AM')
    expect(toGsm7('Great 👍 — see you “soon” 你好')).toBe('Great - see you "soon"')
    expect(g('**Hi!** We’re open _today_.')).toEqual({ kind: 'ok', text: "Hi! We're open today." })
  })

  it('allows one question, at most MAX_REPLY_CHARS characters', () => {
    expect(g('What is your name? And what car do you drive?')).toMatchObject({ kind: 'fix', problems: ['questions'] })
    expect(cutAfterFirstQuestion('Hi Maria! What is your name? And your car?')).toBe('Hi Maria! What is your name?')
    const long = `${'We wash cars by hand. '.repeat(20)}`.trim()
    expect(g(long)).toMatchObject({ kind: 'fix', problems: ['too_long'] })
    const cut = cutAtSentence(long)
    expect(cut.length).toBeLessThanOrEqual(MAX_REPLY_CHARS)
    expect(cut.endsWith('hand.')).toBe(true)
    expect(g('').kind).toBe('fix')
  })
})
