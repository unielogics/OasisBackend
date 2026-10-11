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
const amounts: FactAmounts = {
  starting: new Set([4500, 5400, 22900, 27500, 3200, 3800]),
  plain: new Set([9900, 16900, 2500]),
  plainWords: new Map([
    [9900, ['gold', 'month', 'monthly', 'membership', 'plan']],
    [16900, ['vip', 'month', 'monthly', 'membership', 'plan']],
    [2500, ['fee']],
  ]),
}
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
    expect(findAmounts('54$ total, 12.50 $ more').map((a) => a.cents)).toEqual([5400, 1250])
  })

  it('a plan price or the fee is not a service price: it needs its plan or "fee" in the sentence (F6a)', () => {
    expect(g('The Signature Hand Wash is $99.')).toMatchObject({ kind: 'fix', problems: ['price_unqualified'] })
    expect(g('The Signature Hand Wash is $25.')).toMatchObject({ kind: 'fix', problems: ['price_unqualified'] })
    expect(g('The booking fee is $99.')).toMatchObject({ kind: 'fix', problems: ['price_unqualified'] })
    expect(g('VIP is $169.').kind).toBe('ok')
    expect(g('Our Gold membership is $99.').kind).toBe('ok')
  })

  it('"starts at" / "from" counts only right before the amount (or a list of starting prices it opens) (F6b)', () => {
    expect(g('From Monday the Signature Hand Wash is $45.')).toMatchObject({ kind: 'fix', problems: ['price_unqualified'] })
    expect(g('Starting at noon, the Signature wash is $45.')).toMatchObject({ kind: 'fix', problems: ['price_unqualified'] })
    expect(g('Tint starts at $229 for a sedan or $275 for an SUV.').kind).toBe('ok')
    expect(g('The Signature Hand Wash starts at $45 for members and is $54 otherwise.')).toMatchObject({ kind: 'fix', problems: ['price_unqualified'] })
  })

  it('reads "54$" too, so a total written that way is blocked (F6c)', () => {
    expect(g('A Signature wash is 54$ total.')).toMatchObject({ kind: 'fix', problems: expect.arrayContaining(['price_combination']) })
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

  it('a benign "free" excuses only itself, never another "free" next to it (F2)', () => {
    expect(handoffWords('Your first wash is free, feel free to stop by.')).toEqual(['free'])
    expect(g('Your first wash is free, feel free to stop by.')).toMatchObject({ kind: 'handoff', words: ['free'] })
    expect(handoffWords('A spot-free rinse is free today.')).toEqual(['free'])
    expect(handoffWords('The wash is free to all members.')).toEqual(['free'])
  })

  it("lets the owner's own wording through (a perk or an FAQ answer of the facts), nothing else", () => {
    const ownerWording = ['Everything in Gold', 'Priority booking and same-day guarantee']
    expect(guardReply({ text: 'VIP adds priority booking and a same-day guarantee.', amounts, website, ownerWording }).kind).toBe('ok')
    expect(guardReply({ text: 'We guarantee your car will shine.', amounts, website, ownerWording }).kind).toBe('handoff')
  })

  it("never excuses a word by a function-word neighbour or by the server's own rules (F1)", () => {
    // the owner wrote "a discount" in a perk, but "a" is no wording of theirs: "offer a discount" still hands off
    const ownerWording = ['Members never pay a discount fee', 'No refunds on memberships']
    expect(guardReply({ text: 'Sure, we can offer a discount on your next wash.', amounts, website, ownerWording })).toMatchObject({ kind: 'handoff', words: ['discount'] })
    expect(guardReply({ text: 'No refunds on memberships.', amounts, website, ownerWording }).kind).toBe('handoff')
    expect(g('We can give you a discount next time.').kind).toBe('handoff')
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

  it('any top-level domain is a web address, a look-alike of the shop too (F4)', () => {
    expect(g('You can pay at oasis-pay.dev/maria today.')).toMatchObject({ kind: 'fix', problems: ['url'] })
    expect(g('Pay at oasisautospanj.ai/pay please.')).toMatchObject({ kind: 'fix', problems: ['url'] })
    expect(g('See oasis-autospa.ca for more.')).toMatchObject({ kind: 'fix', problems: ['url'] })
    expect(g('Book at Oasis-Pay.Com now.')).toMatchObject({ kind: 'fix', problems: ['url'] })
    expect(g('Our website oasisautospanj.com/hours has them.')).toMatchObject({ kind: 'fix', problems: ['url'] })
    // not addresses: times, abbreviations, a missing space after a full stop
    expect(g('We open at 8 a.m. on Saturdays, e.g. this one.').kind).toBe('ok')
    expect(g('All done.Thanks for waiting!').kind).toBe('ok')
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

  it('a link or a page in the sentence never excuses asking to text, send or reply with one; card digits are a secret (F3)', () => {
    expect(asksForSecret('Reply with your PIN and I will send you the link.')).toBe(true)
    expect(asksForSecret('Text me the code shown on the link page.')).toBe(true)
    expect(asksForSecret('Send us the code from the page.')).toBe(true)
    expect(asksForSecret('What are the last 4 digits of your card?')).toBe(true)
    expect(asksForSecret('Can you share the last four digits of the card on file?')).toBe(true)
    expect(asksForSecret('What is the code we sent?')).toBe(true)
    expect(asksForSecret('Enter your PIN here.')).toBe(true)
    // entry on the secure page stays fine
    expect(asksForSecret('I will send you a link; enter your PIN on the secure page.')).toBe(false)
    expect(asksForSecret('Use the link to type the code we texted you.')).toBe(false)
    expect(asksForSecret("We'll text you a code; type it on the link page.")).toBe(false)
    expect(asksForSecret('Codes are typed only on the secure page, never by text.')).toBe(false)
    expect(asksForSecret('Text us your zip code and we will check.')).toBe(false)
    expect(g('Reply with your PIN and I will send you the link.')).toMatchObject({ kind: 'fix', problems: ['secret_request'] })
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
