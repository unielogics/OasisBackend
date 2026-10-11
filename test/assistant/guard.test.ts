// The output guard (ADR 0160, design sections 3 and 3b; the owner-level redesign of 2026-10-11: ALLOW-LISTS, never excusals).
// Table-driven: every row is a reply the model might write and what the guard must say about it. MUST BLOCK rows name the
// problem the rewrite call is told about; MUST PASS rows go out as written. Every example of the two review rounds is here
// (F1-F7 of w3-core-verify1, N1-N6 of w3-core-recheck1), with the owner's own examples.
import { describe, expect, it } from 'vitest'
import {
  cutAfterFirstQuestion,
  cutAtSentence,
  findAmounts,
  foreignPhone,
  guardReply,
  MAX_REPLY_CHARS,
  mentionsSecret,
  promiseWords,
  SAFETY_LINE,
  SAFETY_LINES,
  stripMarkdown,
  toGsm7,
  urlProblems,
  type GuardProblem,
} from '../../src/modules/assistant/guard.js'
import { itemNames, type FactAmounts } from '../../src/modules/assistant/facts.js'
import { maskForModel } from '../../src/modules/assistant/context.js'
import { redactText } from '../../src/modules/assistant/transcript.js'

// The website catalog: Signature Hand Wash starts at $45 for members, $54 otherwise; Exterior Hand Wash $32 / $38; Interior detail
// $149; window tint (Carbon) from $229 / $275; Gold $99 and VIP $169 a month; the guest booking fee $25.
const tint = ['tint', 'window tint', 'carbon']
const amounts: FactAmounts = {
  starting: new Map([
    [4500, itemNames('Signature Hand Wash', 'Wash')],
    [5400, itemNames('Signature Hand Wash', 'Wash')],
    [3200, itemNames('Exterior Hand Wash', 'Wash')],
    [3800, itemNames('Exterior Hand Wash', 'Wash')],
    [14900, itemNames('Interior detail', 'Detail')],
    [22900, tint],
    [27500, tint],
  ]),
  plans: new Map([
    [9900, ['gold']],
    [16900, ['vip']],
  ]),
  fee: 2500,
}
const website = 'https://oasisautospanj.com'
const shopNumbers = ['(862) 388-5827', '(201) 598-6304']
const shopAddress = '468 River Drive, Garfield NJ 07026'
const g = (text: string, extra: { extraAmounts?: number[]; placeholders?: string[] } = {}) =>
  guardReply({ text, amounts, website, shopNumbers, shopAddress, ...extra })

type Row = [text: string, why: string, opts?: { extraAmounts?: number[]; placeholders?: string[] }]

// ---- MUST BLOCK: [text, the problem the guard must report, where the case comes from] -----------------------------------------
const MUST_BLOCK: [string, GuardProblem, string][] = [
  // (A) secrets: no warning excusal, no clause splitting, no link/page excusal
  ["Don't forget to text me your PIN.", 'secret', 'N1, owner example'],
  ["Don't hesitate to reply with the code.", 'secret', 'N1'],
  ['Do not forget to send us your PIN.', 'secret', 'N1'],
  ['Send us, when you can, your PIN.', 'secret', 'N1, owner example'],
  ['I need your PIN to continue.', 'secret', 'N1 (was missed before)'],
  ['Please let me know your PIN.', 'secret', 'N1 (was missed before)'],
  ['What code did you get?', 'secret', 'N1 (was missed before)'],
  ["We'll text you a code; reply with it here.", 'secret', 'N1 (was missed before)'],
  ['Reply with your PIN and I will send you the link.', 'secret', 'F3'],
  ['Text me the code shown on the link page.', 'secret', 'F3'],
  ['What are the last 4 digits of your card?', 'secret', 'F3'],
  ['Reply with your PIN on the link page.', 'secret', 'F3 recheck'],
  ['Tell me the digits on your card.', 'secret', 'F3 recheck'],
  ['Please text me your PIN.', 'secret', 'A'],
  ['What is your card number?', 'secret', 'A'],
  ['Reply with the code we sent.', 'secret', 'A'],
  ['Send me your credit card number to hold the spot.', 'secret', 'A'],
  ['What is the CVV on the back?', 'secret', 'A'],
  ['Your password is safe with us.', 'secret', 'A: never mentioned at all'],
  ['Open the link and enter your PIN on the secure page.', 'secret', 'A: the server writes the safety line, never the model'],
  ['Codes are typed only on the secure page, never by text.', 'secret', 'A: only the exact server lines pass'],
  ['Reply 482913 to confirm.', 'secret', 'A: a digit code'],
  ['Your verification number is 5521.', 'secret', 'A: a digit code'],
  [`Text me your PIN. ${SAFETY_LINE}`, 'secret', 'A: a safety line excuses only itself'],
  [`${SAFETY_LINE.replace('.', ',')} or text us your PIN.`, 'secret', 'A: a safety line is a whole sentence, exactly'],
  ['Text me your P.I.N. please.', 'secret', 'A: spelled out'],
  ['What is your pincode?', 'secret', 'A'],
  ['Send the pass-code here.', 'secret', 'A'],
  ['Read me the digits on the back of your card.', 'secret', 'A: card digits'],
  ['Reply #4821 to confirm.', 'secret', 'A: a digit code after "#"'],
  // (B) promise words: one rewrite, then the fallback
  ['Sure, we can offer a discount on your next wash.', 'promise_words', 'F1'],
  ['We can give you a discount next time.', 'promise_words', 'F1'],
  ['Your first wash is free, feel free to stop by.', 'promise_words', 'F2'],
  ["We'll add a free spot-free rinse.", 'promise_words', 'F2 recheck'],
  ['free spot cleaning', 'promise_words', 'N2, owner example'],
  ["We'll do a free spot cleaning on your seats.", 'promise_words', 'N2'],
  ['You get a free spot treatment with any wash.', 'promise_words', 'N2'],
  ['Gold gets a free time slot upgrade.', 'promise_words', 'N2'],
  ['Sorry about the paint damage, we will take care of it.', 'promise_words', 'N4: no owner-wording excusal'],
  ['VIP adds priority booking and a same-day guarantee.', 'promise_words', 'F1 recheck: owner wording excuses nothing now'],
  ['We have a free slot at 2 PM.', 'promise_words', 'B: say "open times" (the prompt says so)'],
  ['The wash is free to all members.', 'promise_words', 'B: "free to" is no allowed phrase'],
  ['We can refund that.', 'promise_words', 'B'],
  ['I can give you 10% off.', 'promise_words', 'B'],
  ['The tire shine is on the house.', 'promise_words', 'B'],
  ['We guarantee no streaks.', 'promise_words', 'B'],
  ['Your car will be ready by 3 PM.', 'promise_words', 'B'],
  ['Please talk to our lawyer.', 'promise_words', 'B'],
  ['We can waive the late charge.', 'promise_words', 'B'],
  ['Let me comp that for you.', 'promise_words', 'B'],
  ['Here is a coupon for your next visit.', 'promise_words', 'B'],
  ['Great deal this week!', 'promise_words', 'B'],
  ['It is complimentary with Gold.', 'promise_words', 'B'],
  ["Don't worry, it's on us.", 'promise_words', 'B'],
  ['You can get your money back.', 'promise_words', 'B'],
  ['Members get $10 off tint.', 'promise_words', 'B'],
  ['Save $10 with Gold.', 'promise_words', 'B'],
  ['Your car will be ready at 3 PM.', 'promise_words', 'B: a time promise'],
  ["We'll be done by noon.", 'promise_words', 'B: a time promise'],
  // (C) prices
  ['A Signature wash is $54 total.', 'price_combination', 'owner example "$54 total"'],
  ['You can get the wash and tint for $99 for both.', 'price_combination', 'owner example "$99 for both"'],
  ['A Signature wash is 54$ total.', 'price_combination', 'F6c'],
  ['It starts at $45 plus $10 for wax.', 'price_combination', 'C'],
  ['Tint starts at $229 plus tax.', 'price_combination', 'C'],
  ['The Signature Hand Wash is $99.', 'price_unqualified', 'F6a'],
  ['From Monday the Signature Hand Wash is $45.', 'price_unqualified', 'F6b'],
  ['Starting at noon, the Signature wash is $45.', 'price_unqualified', 'F6b'],
  ['With Gold, the Signature Hand Wash is $99.', 'price_unqualified', 'N6'],
  ['The Signature Hand Wash plan is $99.', 'price_unqualified', 'N6'],
  ['With Gold, the Signature Hand Wash is $99 a month.', 'price_unqualified', 'N6: the label must be next to the price'],
  ['The Signature Hand Wash is $99 a month.', 'price_unqualified', 'C2: no plan label'],
  ['The Signature Hand Wash starts at $45 a month.', 'price_unqualified', 'C1: a starting price is no monthly price'],
  ['Gold is $99 a month, which covers the $45 Signature wash.', 'price_unqualified', 'C1'],
  ['The fee for a Signature wash is $25.', 'price_unqualified', 'C3: the fee only as the fee'],
  ['Our Gold membership is $99.', 'price_unqualified', 'C2: "a month" is required'],
  ['VIP is $169.', 'price_unqualified', 'C2'],
  ['The Signature Hand Wash is $25.', 'price_unqualified', 'C3: the fee is no service price'],
  ['The booking fee is $99.', 'price_unqualified', 'C3'],
  ['A Signature wash is $45 for members.', 'price_unqualified', 'C1: no "starts at"'],
  ['That would be 45 dollars.', 'price_unqualified', 'C1'],
  ['Starts at $45.', 'price_unqualified', 'C1: no item named'],
  ['Tint starts at $45.', 'price_unqualified', 'C1: $45 is no tint price'],
  ['The Signature Hand Wash starts at $45 for members and is $54 otherwise.', 'price_unqualified', 'C1: "is" breaks the list'],
  ['Signature Hand Wash starts at $45; tint is $54.', 'price_unqualified', 'C1: a new clause'],
  ['A wash starts at $40.', 'price_unknown', 'C: not in the facts'],
  ['Your open balance is $12.50.', 'price_unknown', 'C4: only a balance a tool declared'],
  // (D) web addresses
  ['You can pay at oasis-pay.dev/maria today.', 'url', 'F4'],
  ['Pay at oasisautospanj.ai/pay please.', 'url', 'F4'],
  ['Pay at OASISPAY.DEV now.', 'url', 'F4 recheck'],
  ['Pay at OasisPay.Space today.', 'url', 'N3'],
  ['Pay at Oasis-Pay.Live now.', 'url', 'N3'],
  ['Visit oasis-deals.Shop', 'url', 'owner example'],
  ['See you soon.Thanks!', 'url', 'D: blocked, one rewrite adds the space'],
  ['It takes approx.ten minutes.', 'url', 'N3: blocked, one rewrite adds the space'],
  ['Book here: https://evil.example.com/x', 'url', 'D'],
  ['See www.oasisautospanj.com for hours.', 'url', 'D: the shop host only as plain text'],
  ['Our website oasisautospanj.com/hours has them.', 'url', 'D: no path'],
  ['Visit bit.ly/abc to book.', 'url', 'D'],
  ['See oasis-autospa.ca for more.', 'url', 'D'],
  ['Write to help@oasis-support.net.', 'url', 'D'],
  ['Open http colon slash slash.', 'url', 'D: "http"'],
  ['Pay at oasis-pay dot com today.', 'url', 'D: a spelled-out dot'],
  ['Pay at oasis-pay(dot)shop today.', 'url', 'D: a spelled-out dot'],
  // (E) phone numbers
  ['Call (201) 555-0123', 'phone', 'owner example, F5'],
  ['Text my colleague at 201.555.0123.', 'phone', 'E'],
  ['You can reach us on 555-0123.', 'phone', 'N5'],
  ['Call +1 201 555 0123 for help.', 'phone', 'E'],
  ['Call 2015550123 for help.', 'phone', 'E'],
]

// ---- MUST PASS: [text, where the case comes from, options] -----------------------------------------------------------------------
const MUST_PASS: Row[] = [
  ['Signature Hand Wash starts at $45', 'owner example'],
  ['Gold is $99 a month', 'owner example'],
  ['Our Signature Hand Wash starts at $45 for members, $54 otherwise.', 'C1 with its list'],
  ['Signature Hand Wash: starts at $45 for members, $54 otherwise.', 'C1 as the facts write it'],
  ['Exterior Hand Wash starts at $32 for members, $38 otherwise.', 'C1'],
  ['Starting at $32 for members, the Exterior Hand Wash is quick.', 'C1'],
  ['Signature from just $45.', 'F6 recheck'],
  ['Interior detail starts at $149.', 'C1'],
  ['Detailing starts at $149.', 'C1: the category names it'],
  ['Window tint for a sedan is from $229.', 'C1'],
  ['Tint starts at $229 for a sedan or $275 for an SUV.', 'F6 recheck'],
  ['Gold is $99 a month and VIP is $169 a month.', 'F6 recheck'],
  ['Before you book: Gold is $99 a month and VIP is $169 a month, with member prices on everything.', 'C2 (the welcome test)'],
  ['The Gold plan costs $99/month.', 'C2'],
  ['It is $99 a month for Gold.', 'C2: the label after "a month"'],
  ['The booking fee is $25.', 'F6 recheck'],
  ['Guests pay a $25 booking fee at the shop.', 'C3'],
  ['Your open balance is $12.50.', 'C4: get_balance declared it', { extraAmounts: [1250] }],
  ['Feel free to text us anytime.', 'B: the allowed phrase'],
  ['A spot-free rinse comes with every wash.', 'B: "spot-free" means without spots'],
  ['We have open times at 2 PM and 4 PM today.', 'B: open times, not free times'],
  ['Our website oasisautospanj.com has the hours.', 'D: the shop host as text'],
  ['Email us at support@oasisautospanj.com.', 'D: the shop host'],
  ['Pick a time here: {link1}', 'D: a registered placeholder', { placeholders: ['{link1}'] }],
  ['We open at 8 a.m. on Saturdays, e.g. this one.', 'D: abbreviations are no host'],
  ['All done. Thanks for waiting!', 'D: a full stop with its space'],
  ['Call us at (201) 598-6304.', "E: the shop's calling number"],
  ['Text us at 862-388-5827 anytime.', "E: the shop's texting number"],
  ['We are at 468 River Drive, Garfield NJ 07026.', "A: the shop's address digits are no code"],
  ['Your 2019 Honda CR-V is on file.', 'A: a year is no code'],
  ['Text us your zip code and we will check.', 'A: "zip code" is an allowed phrase'],
  [SAFETY_LINE, 'A: the server line itself'],
  [`Here is your secure link: {link1} ${SAFETY_LINE}`, 'A: the server line after a link', { placeholders: ['{link1}'] }],
  [`${SAFETY_LINES[1]} Reply here if you need a new link.`, 'A: the code_on_link_page line'],
  ['We open at 8 AM tomorrow. See you then!', 'plain'],
  ['The Signature Hand Wash takes about 45 minutes.', 'a duration is no time promise'],
  ['Gold starts at $99 a month.', 'C2'],
  ['Members pay no booking fee.', 'the facts\' own wording'],
  ['Scan the barcode at the gate.', 'A: "barcode" is no code'],
]

describe('the guard table (owner-level redesign 2026-10-11)', () => {
  it.each(MUST_BLOCK)('MUST BLOCK %j -> %s (%s)', (text, problem) => {
    const v = g(text)
    expect(v.kind, text).toBe('fix')
    if (v.kind === 'fix') expect(v.problems, text).toContain(problem)
  })

  it.each(MUST_PASS)('MUST PASS %j (%s)', (text, _why, opts) => {
    expect(g(text, opts ?? {})).toEqual({ kind: 'ok', text })
  })
})

describe('(A) secrets', () => {
  it('a safety line passes only as a whole sentence, exactly as the server writes it', () => {
    expect(mentionsSecret(SAFETY_LINE)).toBe(false)
    expect(mentionsSecret(`Done. ${SAFETY_LINE}`)).toBe(false)
    expect(mentionsSecret(SAFETY_LINE.toLowerCase())).toBe(true)
    expect(mentionsSecret(`Text me your PIN.${SAFETY_LINE}`)).toBe(true)
  })

  it("the shop's own address digits and years are no code; any other 4-8 digit run is", () => {
    expect(mentionsSecret('We are at 468 River Drive, Garfield NJ 07026.', shopAddress)).toBe(false)
    expect(mentionsSecret('We are at 468 River Drive, Garfield NJ 07026.')).toBe(true)
    expect(mentionsSecret('Since 1998, and still in 2026.')).toBe(false)
    expect(mentionsSecret('Prices from $1299 or 1,299 dollars, 10:30, 45.50, 15%.')).toBe(false)
  })
})

describe('(B) promise words', () => {
  it('reports each word as found; an allowed phrase excuses only the word inside it', () => {
    expect(promiseWords('Your first wash is free, feel free to stop by.')).toEqual(['free'])
    expect(promiseWords('Feel free to stop by for a spot-free rinse.')).toEqual([])
    expect(promiseWords('A spot-free rinse free of charge.')).toEqual(['free of charge'])
    expect(promiseWords('We can refund or discount it.')).toEqual(['refund', 'discount'])
    expect(g('We can refund that.')).toMatchObject({ kind: 'fix', problems: ['promise_words'], words: ['refund'] })
  })
})

describe('(D) web addresses', () => {
  it('any label.label with a 2+ letter last label is a host, any case; the shop host as plain text only', () => {
    expect(urlProblems('oasisautospanj.com', website)).toBe(false)
    expect(urlProblems('OasisAutoSpaNJ.com', website)).toBe(false)
    expect(urlProblems('oasisautospanj.com:8080', website)).toBe(true)
    expect(urlProblems('evil.oasisautospanj.com', website)).toBe(true)
    expect(urlProblems('my-oasisautospanj.com', website)).toBe(true)
    expect(urlProblems('done.Thanks', website)).toBe(true)
    expect(urlProblems('8 a.m. e.g. i.e. $45.50 v2.0', website)).toBe(false)
  })
})

describe('(E) phone numbers', () => {
  it("only the shop's own numbers may be written", () => {
    expect(foreignPhone('Call (201) 598-6304 or text 8623885827.', shopNumbers)).toBe(false)
    expect(foreignPhone('Call 598-6304.', shopNumbers)).toBe(false)
    expect(foreignPhone('Call (201) 555-0123', shopNumbers)).toBe(true)
    expect(foreignPhone('Open 8:00 to 18:00 on 2026-06-13, $1,299.', shopNumbers)).toBe(false)
  })

  it('masks every phone form for the model and in the stored transcript (F5, N5)', () => {
    for (const n of ['(201) 555-0123', '201.555.0123', '201-555-0123', '+1 201 555 0123', '2015550123', '555-0123', '555.0123']) {
      expect(maskForModel(`Call ${n} please`), n).toBe('Call [number] please')
      expect(redactText(`Call ${n} please`), n).not.toMatch(/555.?0123|5550123/)
      expect(redactText(`Call ${n} please`), n).toContain('0123')
    }
    // not numbers: a date, a time, a price, a ZIP+4, an invoice number
    for (const t of ['Sat 2026-06-13 at 10:30, $1,299', 'Garfield NJ 07026-1234', 'invoice INV-2026-0042', 'from 9:00-17:00'])
      expect(maskForModel(t), t).toBe(t)
  })
})

describe('(C) amounts', () => {
  it('reads every form of an amount', () => {
    expect(findAmounts('$45, $1,299, $45.50, 45 dollars and 12 bucks').map((a) => a.cents)).toEqual([4500, 129900, 4550, 4500, 1200])
    expect(findAmounts('54$ total, 12.50 $ more').map((a) => a.cents)).toEqual([5400, 1250])
  })

  it('an item is named by its name, its distinctive words or its category', () => {
    expect(itemNames('Signature Hand Wash', 'Wash')).toEqual(['signature hand wash', 'signature', 'wash', 'wash'])
    expect(itemNames('Tire shine', 'Add-ons')).toEqual(['tire shine', 'tire', 'shine', 'add-ons', 'add-on'])
  })
})

describe('form', () => {
  it('strips markdown and lists into one plain line, GSM-7 only', () => {
    expect(stripMarkdown('**Hours:**\n- Mon 8:00 AM\n- Tue 8:00 AM')).toBe('Hours: Mon 8:00 AM Tue 8:00 AM')
    expect(toGsm7('Great 👍 — see you “soon” 你好')).toBe('Great - see you "soon"')
    expect(g('**Hi!** We’re open _today_.')).toEqual({ kind: 'ok', text: "Hi! We're open today." })
  })

  it('allows one question, at most MAX_REPLY_CHARS characters (or the limit the turn passes)', () => {
    expect(g('What is your name? And what car do you drive?')).toMatchObject({ kind: 'fix', problems: ['questions'] })
    expect(cutAfterFirstQuestion('Hi Maria! What is your name? And your car?')).toBe('Hi Maria! What is your name?')
    const long = `${'We wash cars by hand. '.repeat(20)}`.trim()
    expect(g(long)).toMatchObject({ kind: 'fix', problems: ['too_long'] })
    const cut = cutAtSentence(long)
    expect(cut.length).toBeLessThanOrEqual(MAX_REPLY_CHARS)
    expect(cut.endsWith('hand.')).toBe(true)
    expect(guardReply({ text: 'We wash cars by hand.', amounts, website, maxChars: 10 })).toMatchObject({ kind: 'fix', problems: ['too_long'] })
    expect(g('').kind).toBe('fix')
    expect(g('Pick a time here: {link2}', { placeholders: ['{link1}'] })).toMatchObject({ kind: 'fix', problems: ['unknown_placeholder'] })
  })
})
