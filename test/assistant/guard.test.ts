// The output guard v3 (ADR 0160, design sections 3, 3b and 3c: SENSITIVE CONTENT IS SERVER-RENDERED, NOT WRITTEN BY THE MODEL).
// Table-driven: every row is a reply the model might write and what the guard must say about it. MUST BLOCK rows name a problem
// the rewrite call is told about; MUST PASS rows go out as written (placeholders rendered from the facts). The MUST BLOCK table holds
// every adversarial string of the w3-core-recheck2 probe (the 65 rows that leaked through guard v2 and the 33 it blocked), the rows of
// the earlier review rounds (F1-F7 of w3-core-verify1, N1-N6 of w3-core-recheck1) and the owner's examples. The MUST PASS table
// holds the reviewer's legitimate replies (the one that states a raw $ amount, "Gold is $99 a month.", in its placeholder form; the
// raw form is a MUST BLOCK row now) and the orchestrator's six rows.
import { describe, expect, it } from 'vitest'
import {
  cutAfterFirstQuestion,
  cutAtSentence,
  guardReply,
  hostSkeleton,
  MAX_REPLY_CHARS,
  numberProblems,
  promiseWords,
  renderPlaceholders,
  SAFETY_LINE,
  secretWords,
  skeleton,
  stripMarkdown,
  toGsm7,
  urlWords,
  type GuardProblem,
} from '../../src/modules/assistant/guard.js'
import { maskForModel, vehicleLiterals } from '../../src/modules/assistant/context.js'
import { redactText } from '../../src/modules/assistant/transcript.js'

// The website catalog as facts.ts placeholderValues renders it: Signature Hand Wash starts at $45 for members, $54 otherwise;
// Exterior Hand Wash $32 / $38; Interior detail $149; window tint (sedan, Carbon) from $229 / $275; Gold $99 and VIP $169 a month;
// the guest booking fee $25; a quote-only ceramic coating.
const values = new Map<string, string>([
  ['{price:signature-hand-wash}', 'starts at $45 for members, $54 otherwise'],
  ['{price:exterior-hand-wash}', 'starts at $32 for members, $38 otherwise'],
  ['{price:interior-detail}', 'starts at $149'],
  ['{price:ceramic-coating}', 'is priced by quote - text us a photo'],
  ['{price:tint:sedan:carbon}', 'starts at $229 for members, $275 otherwise'],
  ['{plan:gold}', 'is $99 a month'],
  ['{plan:vip}', 'is $169 a month'],
  ['{fee}', 'a $25 booking fee for guests'],
  ['{link1}', '{link1}'],
])
const website = 'https://oasisautospanj.com'
const shopNumbers = ['(862) 388-5827', '(201) 598-6304']
const shopAddress = '468 River Drive, Garfield NJ 07026'
// the client's vehicles on file (the turn passes context.ts vehicleLiterals of them) and the shop's address (facts.ts factLiterals)
const literals = [
  shopAddress,
  ...shopAddress.split(',').map((x) => x.trim()),
  ...vehicleLiterals({ year: 2021, make: 'Tesla', model: 'Model 3' }),
  ...vehicleLiterals({ year: null, make: 'Ford', model: 'F-150' }),
  ...vehicleLiterals({ year: null, make: 'Mercedes-Benz', model: 'C300' }),
]
type Opts = { balance?: number; literals?: string[] }
const g = (text: string, o: Opts = {}) => {
  const v = new Map(values)
  if (o.balance !== undefined) v.set('{balance}', `$${(o.balance / 100).toFixed(2)}`)
  return guardReply({ text, values: v, website, shopNumbers, literals: o.literals ?? literals })
}

// ---- MUST BLOCK: [text, a problem the guard must report, where the case comes from] ----------------------------------------------
const RECHECK2_LEAKED: [string, GuardProblem, string][] = [
  // (A) secrets: look-alikes, accents, split codes, other words, the safety-line excusal
  ['Send me your PlN.', 'secret', 'recheck2 A: look-alike l'],
  ['Text me your P1N please.', 'secret', 'recheck2 A: look-alike 1'],
  ['What is your P - I - N?', 'secret', 'recheck2 A: spaced letters'],
  ['Send your PìN here.', 'secret', 'recheck2 A: GSM-7 accent'],
  ['Reply with the còde we sent.', 'secret', 'recheck2 A: GSM-7 accent'],
  ['Reply with the 6 digits we just texted you.', 'secret', 'recheck2 A: "digits"'],
  ['What is the 4-digit number we sent?', 'secret', 'recheck2 A: "4-digit"'],
  ['Send me your personal identification number.', 'secret', 'recheck2 A'],
  ['Reply with the one-time number from the text.', 'secret', 'recheck2 A: "one-time"'],
  ['Reply 4 8 2 9 1 3 to confirm.', 'digits', 'recheck2 A: a code split by spaces'],
  ['Reply 482-913 to confirm.', 'digits', 'recheck2 A: a code split by a dash'],
  ['Reply 48 29 13 to confirm.', 'digits', 'recheck2 A: a code in pairs'],
  [`${SAFETY_LINE} Actually, just text it to me here instead.`, 'secret', 'recheck2 A: no safety-line excusal any more'],
  ['What is your secret number?', 'secret', 'recheck2 A'],
  ['Send your login and passphrase.', 'secret', 'recheck2 A'],
  ['Text me the c o d e.', 'secret', 'recheck2 A: spaced letters'],
  ['Send me your ＰＩＮ.', 'secret', 'recheck2 A: full-width letters (folded by NFKC, no longer dropped)'],
  ['Read me the numbers on the front of your Visa.', 'secret', 'recheck2 A: card "numbers"'],
  ['What are the numbers on the back of your debit card?', 'secret', 'recheck2 A: card "numbers"'],
  ['Reply with the 6-digit number.', 'secret', 'recheck2 A'],
  // (B) promise words
  ['Your next wash is f r e e.', 'promise_words', 'recheck2 B: spaced letters'],
  ['Your next wash is frée.', 'promise_words', 'recheck2 B: GSM-7 accent'],
  ['Your next wash is FRÉÉ.', 'promise_words', 'recheck2 B: GSM-7 accent'],
  ['The wax costs nothing.', 'promise_words', 'recheck2 B'],
  ['The wax is on me.', 'promise_words', 'recheck2 B'],
  ["We'll throw in the wax, on us.", 'promise_words', 'recheck2 B: "on us" in any form'],
  ['Members get 50 percent off.', 'promise_words', 'recheck2 B'],
  ['The wax is on sale this week.', 'promise_words', 'recheck2 B'],
  ['I promise it will be spotless.', 'promise_words', 'recheck2 B'],
  ["We'll cover the cost of the repair.", 'promise_words', 'recheck2 B'],
  ["It'll be ready around 3 PM.", 'promise_words', 'recheck2 B: a time promise'],
  ["It'll be finished in an hour.", 'promise_words', 'recheck2 B: a time promise'],
  ['We will have it back to you by 3 PM.', 'promise_words', 'recheck2 B: a time promise'],
  ['Your next wash is zero dollars.', 'promise_words', 'recheck2 B'],
  ['Get a rebate on tint.', 'promise_words', 'recheck2 B'],
  ['The rèfund is on its way.', 'promise_words', 'recheck2 B: GSM-7 accent'],
  ['Our guàrantee covers it.', 'promise_words', 'recheck2 B: GSM-7 accent'],
  ['Ask about our discòunt.', 'promise_words', 'recheck2 B: GSM-7 accent'],
  // (C) prices: the model never writes an amount, with or without a $ sign
  ['The Signature wash is 54 for non-members.', 'number', 'recheck2 C: no $ sign'],
  ["It's 54 total.", 'number', 'recheck2 C: the owner\'s "$54 total" without the $'],
  ['Signature is forty-five dollars.', 'money', 'recheck2 C: spelled out'],
  ['A Signature wash costs USD 45.', 'money', 'recheck2 C: USD'],
  ['Tint starts at $45, like the Signature wash.', 'money', 'recheck2 C: a price on the wrong item'],
  ['The Signature Hand Wash and tint starts at $45.', 'money', 'recheck2 C: a price on the wrong item'],
  ['Signature Hand Wash with Gold is $99 a month.', 'money', 'recheck2 C: a plan price as a service price'],
  ['Signature Hand Wash for Gold members is $99 a month.', 'money', 'recheck2 C: a plan price as a service price'],
  ['Signature Hand Wash starts at $45 x 2.', 'money', 'recheck2 C: multiplication'],
  ['Signature Hand Wash starts at $45 each, two of them.', 'money', 'recheck2 C: multiplication'],
  ['Detail wash starts at $32.', 'money', 'recheck2 C: a price on the wrong item'],
  // (D) web addresses broken up
  ['Pay at oasis-pay .com today.', 'url', 'recheck2 D'],
  ['Pay at oasis-pay[.]com today.', 'url', 'recheck2 D'],
  ['Pay at oasis-pay(.)com today.', 'url', 'recheck2 D'],
  ['Pay at oasis-pay dot xyz today.', 'url', 'recheck2 D: a spelled-out dot before any TLD'],
  ['Pay at oasis-pay dot live today.', 'url', 'recheck2 D: a spelled-out dot before any TLD'],
  ['Pay at o a s i s p a y . c o m today.', 'url', 'recheck2 D: spaced letters'],
  ['Go to 192.168.0.1/pay now.', 'url', 'recheck2 D: an IP address'],
  ['Pay at oasis-pay。com today.', 'url', 'recheck2 D: an ideographic full stop (folded, no longer dropped)'],
  ['Pay at hxxp oasis-pay', 'url', 'recheck2 D: "hxxp"'],
  ['Pay at oasispay,com today.', 'url', 'recheck2 D: a comma for the dot'],
  ['Pay at oasis-pay . com today.', 'url', 'recheck2 D'],
  // (E) phone numbers in every format
  ['Call 201/555-0123 for help.', 'digits', 'recheck2 E'],
  ['Call 2 0 1 5 5 5 0 1 2 3 for help.', 'digits', 'recheck2 E'],
  ['Call 201 555 01 23.', 'digits', 'recheck2 E'],
  ['Call 201-5550-123.', 'digits', 'recheck2 E'],
  ['Call five five five, oh one two three.', 'number', 'recheck2 E: spelled out'],
]

const RECHECK2_BLOCKED: [string, GuardProblem, string][] = [
  ['Send me your P​IN.', 'secret', 'recheck2: a zero-width space'],
  ['Your plate ABC1234 is on file.', 'digits', 'recheck2: 4+ digits'],
  ['Your next wash is FREE!', 'promise_words', 'recheck2'],
  ['The wax is complimentary.', 'promise_words', 'recheck2'],
  ['The wax is at no charge.', 'promise_words', 'recheck2'],
  ['Members get 10 dollars off.', 'money', 'recheck2'],
  ['Members pay $10 less.', 'money', 'recheck2'],
  ['The rinse is gratis.', 'promise_words', 'recheck2'],
  ['We will credit your account $10.', 'money', 'recheck2'],
  ['Your next wash is on the house.', 'promise_words', 'recheck2'],
  ['Freebie wax today!', 'promise_words', 'recheck2'],
  ['Spot-free and free!', 'promise_words', 'recheck2: "spot-free" passes, the second "free" does not'],
  ['Gold is $99 a month for unlimited Signature Hand Washes, so each wash is $45.', 'money', 'recheck2'],
  ['Interior detail starts at $149 and the Signature starts at $45, so $194 for both.', 'money', 'recheck2'],
  ['A Signature wash from $45 plus Gold, around $144.', 'money', 'recheck2'],
  ['Your balance is $0.', 'money', 'recheck2: {balance} renders a balance, the model never writes one'],
  ['The Signature Hand Wash is $45.00 after the fee.', 'money', 'recheck2'],
  ['Fee: $99.', 'money', 'recheck2'],
  ['Gold: $25 a month.', 'money', 'recheck2'],
  ['Signature Hand Wash starts at $45 + tax.', 'money', 'recheck2'],
  ['Signature Hand Wash starts at $45; with Gold it is $0.', 'money', 'recheck2'],
  ['Pay at OASIS-PAY.COM.', 'url', 'recheck2'],
  ['Visit oasisautospanj.com.evil.io today.', 'url', 'recheck2: the shop host as a prefix'],
  ['Visit oasisautospanj.com/pay today.', 'url', 'recheck2: the shop host with a path'],
  ['Go to oasisautospanj dot net', 'url', 'recheck2'],
  ['Visit evil.io', 'url', 'recheck2'],
  ['Visit EVIL.IO', 'url', 'recheck2'],
  ['Pay at pay.oasisautospanj.com', 'url', 'recheck2: a subdomain of the shop host'],
  ['Visit t.co/x', 'url', 'recheck2'],
  ['Call +44 20 7946 0958.', 'digits', 'recheck2'],
  ['Call 1-201-555-0123.', 'digits', 'recheck2'],
  ['Call (201)555-0123.', 'digits', 'recheck2'],
  ['Call 201.555.0123 ext 4.', 'digits', 'recheck2'],
  // the reviewer's extra pass row and the reviewer's raw-amount pass row: a raw $ amount is never the model's to write now
  ['Interior detail starts at $149 for members, $169 otherwise.', 'money', 'recheck2 FP row: write "Interior detail {price:interior-detail}."'],
  ['Gold is $99 a month.', 'money', 'recheck2 pass row, now "Gold {plan:gold}." (rendering is the only way a $ amount reaches a client)'],
]

const EARLIER_ROUNDS: [string, GuardProblem, string][] = [
  // (A) secrets: no warning excusal, no clause splitting, no link/page excusal, no safety-line excusal
  ["Don't forget to text me your PIN.", 'secret', 'N1, owner example'],
  ["Don't hesitate to reply with the code.", 'secret', 'N1'],
  ['Do not forget to send us your PIN.', 'secret', 'N1'],
  ['Send us, when you can, your PIN.', 'secret', 'N1, owner example'],
  ['I need your PIN to continue.', 'secret', 'N1'],
  ['Please let me know your PIN.', 'secret', 'N1'],
  ['What code did you get?', 'secret', 'N1'],
  ["We'll text you a code; reply with it here.", 'secret', 'N1'],
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
  ['Codes are typed only on the secure page, never by text.', 'secret', 'A'],
  [SAFETY_LINE, 'secret', 'A v3: the model writing the safety line is a mention like any other'],
  ['For your security, codes are only entered on your secure link page, never by text.', 'secret', 'A v3: the template line too'],
  ['Reply 482913 to confirm.', 'digits', 'A: a digit code'],
  ['Your verification number is 5521.', 'secret', 'A: a digit code'],
  [`Text me your PIN. ${SAFETY_LINE}`, 'secret', 'A'],
  ['Text me your P.I.N. please.', 'secret', 'A: spelled out'],
  ['What is your pincode?', 'secret', 'A'],
  ['Send the pass-code here.', 'secret', 'A'],
  ['Read me the digits on the back of your card.', 'secret', 'A: card digits'],
  ['Reply #4821 to confirm.', 'digits', 'A: a digit code after "#"'],
  ['Text us your zip code and we will check.', 'secret', 'A v3: no "code" at all (no allow-list for the model)'],
  ['Your 2019 Honda CR-V is on file.', 'digits', 'A v3: a year is a 4-digit group unless that vehicle is on file (see MUST PASS)'],
  // (B) promise words
  ['Sure, we can offer a discount on your next wash.', 'promise_words', 'F1'],
  ['We can give you a discount next time.', 'promise_words', 'F1'],
  ['Your first wash is free, feel free to stop by.', 'promise_words', 'F2'],
  ["We'll add a free spot-free rinse.", 'promise_words', 'F2 recheck'],
  ['free spot cleaning', 'promise_words', 'N2, owner example'],
  ["We'll do a free spot cleaning on your seats.", 'promise_words', 'N2'],
  ['You get a free spot treatment with any wash.', 'promise_words', 'N2'],
  ['Gold gets a free time slot upgrade.', 'promise_words', 'N2'],
  ['Sorry about the paint damage, we will take care of it.', 'promise_words', 'N4'],
  ['VIP adds priority booking and a same-day guarantee.', 'promise_words', 'F1 recheck'],
  ['We have a free slot at 2 PM.', 'promise_words', 'B: say "open times"'],
  ['The wash is free to all members.', 'promise_words', 'B'],
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
  ['Members get $10 off tint.', 'money', 'B'],
  ['Save $10 with Gold.', 'promise_words', 'B'],
  ['Your car will be ready at 3 PM.', 'promise_words', 'B'],
  ["We'll be done by noon.", 'promise_words', 'B'],
  ['A cost-free upgrade for Gold members.', 'promise_words', 'B v3: a money "-free" compound is no allowed phrase'],
  // (C) prices: every raw amount, whatever the wording
  ['A Signature wash is $54 total.', 'money', 'owner example "$54 total"'],
  ['You can get the wash and tint for $99 for both.', 'money', 'owner example "$99 for both"'],
  ['A Signature wash is 54$ total.', 'money', 'F6c'],
  ['It starts at $45 plus $10 for wax.', 'money', 'C'],
  ['Tint starts at $229 plus tax.', 'money', 'C'],
  ['The Signature Hand Wash is $99.', 'money', 'F6a'],
  ['From Monday the Signature Hand Wash is $45.', 'money', 'F6b'],
  ['Starting at noon, the Signature wash is $45.', 'money', 'F6b'],
  ['With Gold, the Signature Hand Wash is $99.', 'money', 'N6'],
  ['The Signature Hand Wash plan is $99.', 'money', 'N6'],
  ['With Gold, the Signature Hand Wash is $99 a month.', 'money', 'N6'],
  ['The Signature Hand Wash starts at $45 a month.', 'money', 'C1'],
  ['Gold is $99 a month, which covers the $45 Signature wash.', 'money', 'C1'],
  ['The fee for a Signature wash is $25.', 'money', 'C3'],
  ['Our Gold membership is $99.', 'money', 'C2'],
  ['VIP is $169.', 'money', 'C2'],
  ['The booking fee is $99.', 'money', 'C3'],
  ['That would be 45 dollars.', 'money', 'C1'],
  ['Starts at $45.', 'money', 'C1'],
  ['A wash starts at $40.', 'money', 'C'],
  ['Your open balance is $12.50.', 'money', 'C4: {balance}, never the amount'],
  ['Signature Hand Wash starts at 45.', 'number', 'C v3: a bare number'],
  ['The Signature starts at 10.', 'number', 'C v3: "starts at" is a price, not a clock time'],
  ['Wax is ten bucks.', 'money', 'C v3'],
  ['Gold runs ninety-nine a month.', 'number', 'C v3: a number in words'],
  ['Our wash is 45.50 today.', 'digits', 'C v3: a decimal is a 4-digit group'],
  // (D) web addresses
  ['You can pay at oasis-pay.dev/maria today.', 'url', 'F4'],
  ['Pay at oasisautospanj.ai/pay please.', 'url', 'F4'],
  ['Pay at OASISPAY.DEV now.', 'url', 'F4 recheck'],
  ['Pay at OasisPay.Space today.', 'url', 'N3'],
  ['Pay at Oasis-Pay.Live now.', 'url', 'N3'],
  ['Visit oasis-deals.Shop', 'url', 'owner example'],
  ['See you soon.Thanks!', 'url', 'D: blocked, one rewrite adds the space'],
  ['It takes approx.ten minutes.', 'url', 'N3'],
  ['Book here: https://evil.example.com/x', 'url', 'D'],
  ['See www.oasisautospanj.com for hours.', 'url', 'D'],
  ['Our website oasisautospanj.com/hours has them.', 'url', 'D: no path'],
  ['Visit bit.ly/abc to book.', 'url', 'D'],
  ['See oasis-autospa.ca for more.', 'url', 'D'],
  ['Write to help@oasis-support.net.', 'url', 'D'],
  ['Open http colon slash slash.', 'url', 'D'],
  ['Pay at oasis-pay dot com today.', 'url', 'D'],
  ['Pay at oasis-pay(dot)shop today.', 'url', 'D'],
  ['Pay at 0asis-pay.c0m today.', 'url', 'D v3: look-alike digits'],
  // (E) phone numbers
  ['Call (201) 555-0123', 'digits', 'owner example, F5'],
  ['Text my colleague at 201.555.0123.', 'digits', 'E'],
  ['You can reach us on 555-0123.', 'digits', 'N5'],
  ['Call +1 201 555 0123 for help.', 'digits', 'E'],
  ['Call 2015550123 for help.', 'digits', 'E'],
]

// ---- MUST PASS: [text, where the case comes from, the text that goes out when placeholders render, options] ---------------------
type PassRow = [text: string, why: string, rendered?: string, opts?: Opts]
const REVIEWER_LEGIT: PassRow[] = [
  ['Hi Maria! How can I help you today?', 'recheck2 legit'],
  ['We are open 8 AM to 6 PM, Monday to Saturday.', 'recheck2 legit'],
  ["We're closed on Sundays.", 'recheck2 legit'],
  ['Your appointment is set for Saturday, Oct 14 at 2:30 PM.', 'recheck2 legit'],
  ['Which day works best for you?', 'recheck2 legit'],
  ['I have openings at 10 AM, 12 PM and 3 PM tomorrow.', 'recheck2 legit'],
  ['Thanks, Maria! See you Saturday.', 'recheck2 legit'],
  ["I've passed this to our team; someone will text you back soon.", 'recheck2 legit'],
  ['Your Gold membership renews on Nov 1.', 'recheck2 legit'],
  ['You have 3 washes left this month.', 'recheck2 legit'],
  ['We are at 468 River Drive, Garfield NJ 07026.', "recheck2 legit: the shop's address (facts literal)"],
  ['Your 2021 Tesla Model 3 is on file.', 'recheck2 legit: a vehicle on file (context literal)'],
  ['We take cards and cash at the shop.', 'recheck2 legit'],
  ['The Signature Hand Wash takes about 45 minutes.', 'recheck2 legit: a duration'],
  ['Sorry for the wait!', 'recheck2 legit'],
  ['No problem at all.', 'recheck2 legit'],
  ["We'll text you when your car is ready.", 'recheck2 legit'],
  ['Drop-off starts at 8 a.m. and pickup is until 6 p.m.', 'recheck2 legit'],
  ['For tint, text us a photo for a quote.', 'recheck2 legit'],
  ['Gold members get priority booking.', 'recheck2 legit'],
  ['Your next appointment is Oct 14.', 'recheck2 legit'],
  ['Here is your booking link: {link1}', 'recheck2 legit'],
  ['Your car is ready for pickup.', 'recheck2 legit'],
  ['Is 2:30 PM okay?', 'recheck2 legit'],
  ['Your Ford F-150 is booked for Monday.', 'recheck2 legit: a vehicle on file (context literal)'],
  ['We use pH-neutral soap and microfiber towels.', 'recheck2 legit'],
  ['Ceramic coating lasts up to 2 years.', 'recheck2 legit'],
  ['Would you like the Signature Hand Wash or the Exterior Hand Wash?', 'recheck2 legit'],
  ['Mon.-Sat. we open at 8.', 'recheck2 legit: a bare hour about opening'],
  ['The team confirms the exact price at the shop.', 'recheck2 legit'],
  ['Reply STOP to opt out.', 'recheck2 legit'],
  ["You're all set. See you then!", 'recheck2 legit'],
  ['We have openings Mon. through Sat.', 'recheck2 legit'],
  ['Gold {plan:gold}.', 'recheck2 legit "Gold is $99 a month." as v3 writes it', 'Gold is $99 a month.'],
  ['Our Mercedes-Benz C300 slot is at 9:00.', 'recheck2 legit: a vehicle on file (context literal)'],
  ['Ok, I cancelled your 3 PM appointment.', 'recheck2 legit'],
  ['Got it, thanks!', 'recheck2 legit'],
]
const ORCHESTRATOR_ROWS: PassRow[] = [
  ['We have openings Saturday at 10 and 11:30.', 'orchestrator'],
  ['Your appointment is on Oct 12 at 9 AM.', 'orchestrator'],
  ['Signature Hand Wash {price:signature-hand-wash}.', 'orchestrator', 'Signature Hand Wash starts at $45 for members, $54 otherwise.'],
  ['Gold {plan:gold}.', 'orchestrator', 'Gold is $99 a month.'],
  ['Want me to book 2 add-ons?', 'orchestrator'],
  ['Feel free to text us anytime.', 'orchestrator'],
]
const MORE_PASS: PassRow[] = [
  ['Our Exterior Hand Wash {price:exterior-hand-wash}.', 'v3 placeholder', 'Our Exterior Hand Wash starts at $32 for members, $38 otherwise.'],
  ['Interior detail {price:interior-detail}.', 'v3 placeholder', 'Interior detail starts at $149.'],
  ['A ceramic coating {price:ceramic-coating}.', 'v3 placeholder: quote-only', 'A ceramic coating is priced by quote - text us a photo.'],
  ['Window tint for a sedan with Carbon film {price:tint:sedan:carbon}.', 'v3 tint row', 'Window tint for a sedan with Carbon film starts at $229 for members, $275 otherwise.'],
  ['Gold {plan:gold} and VIP {plan:vip}, with member prices on everything.', 'v3 plans', 'Gold is $99 a month and VIP is $169 a month, with member prices on everything.'],
  ['There is {fee}.', 'v3 fee', 'There is a $25 booking fee for guests.'],
  ['Your open balance is {balance}.', 'v3 balance after get_balance', 'Your open balance is $12.50.', { balance: 1250 }],
  ['A spot-free rinse comes with every wash.', 'B: "spot-free"'],
  ['We have open times at 2 PM and 4 PM today.', 'B: open times'],
  ['Our website oasisautospanj.com has the hours.', 'D: the shop host as text'],
  ['Email us at support@oasisautospanj.com.', 'D: the shop host'],
  ['We open at 8 a.m. on Saturdays, e.g. this one.', 'D: abbreviations are no host'],
  ['All done. Thanks for waiting!', 'D: a full stop with its space'],
  ['Call us at (201) 598-6304.', "E: the shop's calling number"],
  ['Text us at 862-388-5827 anytime.', "E: the shop's texting number, any format"],
  ['Your 2019 Honda CR-V is on file.', 'a vehicle on file', undefined, { literals: [...literals, ...vehicleLiterals({ year: 2019, make: 'Honda', model: 'CR-V' })] }],
  ['We open at 8 AM tomorrow. See you then!', 'plain'],
  ['Members pay no booking fee.', "the facts' own wording"],
  ['Scan the barcode at the gate.', '"barcode" is no code'],
  ['Cancelling at least 24 hours before is fine.', 'a duration'],
  ['We have 3 openings on 10/12, the 12th at 9:30 or 10 AM.', 'counts, dates and times'],
  ['Which one works for you?', '"one" after a determiner'],
  ['Your visit is on Saturday the 12th at noon.', 'a date in words'],
]

describe('the guard table (v3: server-rendered amounts, numbers rule, skeleton checks)', () => {
  it.each([...RECHECK2_LEAKED, ...RECHECK2_BLOCKED, ...EARLIER_ROUNDS])('MUST BLOCK %j -> %s (%s)', (text, problem) => {
    const v = g(text)
    expect(v.kind, text).toBe('fix')
    if (v.kind === 'fix') expect(v.problems, `${text} -> ${v.problems.join(',')} [${v.words.join('|')}]`).toContain(problem)
  })

  it.each([...REVIEWER_LEGIT, ...ORCHESTRATOR_ROWS, ...MORE_PASS])('MUST PASS %j (%s)', (text, _why, rendered, opts) => {
    const v = g(text, opts ?? {})
    expect(v, v.kind === 'fix' ? `${v.problems.join(',')} [${v.words.join('|')}]` : text).toEqual({ kind: 'ok', text, rendered: rendered ?? text })
  })

  it("covers every string of the recheck2 probe: its 98 adversarial rows (+1 FP row) and its legitimate replies", () => {
    expect(RECHECK2_LEAKED.length + RECHECK2_BLOCKED.length).toBe(100) // 98 probe rows + its FP row + "Gold is $99 a month."
    expect(REVIEWER_LEGIT).toHaveLength(37) // the probe's 37 passing rows; "Gold is $99 a month." in its placeholder form
  })
})

describe('(1) placeholders', () => {
  it('renders the facts wording after the check; an unknown key, {balance} without get_balance, a lone brace are refused', () => {
    expect(renderPlaceholders('Gold {plan:gold}. {link1}', values)).toBe('Gold is $99 a month. {link1}')
    for (const bad of ['Signature {price:signature}.', 'Gold {plan:platinum}.', 'Your balance is {balance}.', 'Pick one: {link2}', 'Gold { plan:gold }.', 'Gold {plan:gold.'])
      expect(g(bad), bad).toMatchObject({ kind: 'fix', problems: expect.arrayContaining(['unknown_placeholder']) })
    // a rendered amount is no amount of the model's: the check reads the raw text only
    expect(g('Signature Hand Wash {price:signature-hand-wash} and Gold {plan:gold}.').kind).toBe('ok')
  })

  it('checks the length after rendering', () => {
    const text = `${'We wash by hand. '.repeat(16)}Signature {price:signature-hand-wash}.`
    expect(text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS)
    expect(g(text)).toMatchObject({ kind: 'fix', problems: ['too_long'] })
  })
})

describe('(2) the numbers rule', () => {
  it('allows clock times, dates, durations, counts before a noun and bare hours about opening; refuses everything else', () => {
    for (const ok of ['at 10:30', '10am', '10:30 AM', 'Oct 12', 'October 12th', '10/12', 'Saturday the 12th', '45 minutes', '2 add-ons', 'we open at 8', 'Saturday at 10 and 11:30', 'two openings'])
      expect(numberProblems(ok), ok).toEqual({ problems: [], words: [] })
    expect(numberProblems('It is 54.').problems).toEqual(['number'])
    expect(numberProblems('Reply 1 to confirm.').problems).toEqual(['number'])
    expect(numberProblems('Reply one to confirm.').problems).toEqual(['number'])
    expect(numberProblems('fifty four').problems).toEqual(['number'])
    expect(numberProblems('10/12/2026').problems).toEqual(['digits'])
    expect(numberProblems('201 555 01 23').problems).toEqual(['digits'])
    expect(numberProblems('2 0 1 5').problems).toEqual(['digits'])
    expect(numberProblems('USD').problems).toEqual(['money'])
    expect(numberProblems('£5').problems).toContain('money')
    expect(numberProblems('starts at 10').problems).toEqual(['number'])
  })
})

describe('(3) the skeleton', () => {
  it('folds accents, look-alikes, invisible characters and spaced-out letters', () => {
    expect(skeleton('P - 1 - N')).toBe('pin')
    expect(skeleton('Fr33 wax')).toBe('free wax')
    expect(skeleton('c o d e')).toBe('code')
    expect(skeleton('rèfund')).toBe('refund')
    expect(skeleton('P​IN')).toBe('pin')
    expect(skeleton('10:30 and 8 a.m. sharp')).not.toMatch(/pin|code|free/)
    expect(hostSkeleton('oasis-pay [.] com, o a s i s . c o m, x dot live, a,com')).toBe('oasis-pay.com, oasis.com, x.live, a.com')
  })

  it('reports the words as found for the rewrite hint', () => {
    expect(secretWords('Send your PlN.')).toEqual(['pln'])
    expect(promiseWords('Your first wash is free, feel free to stop by.')).toEqual(['free'])
    expect(promiseWords('Feel free to stop by for a spot-free rinse.')).toEqual([])
    expect(promiseWords('We can refund or discount it.')).toEqual(['refund', 'discount'])
    expect(urlWords('oasisautospanj.com and OasisAutoSpaNJ.com', website)).toEqual([])
    expect(urlWords('oasisautospanj.com:8080', website).length).toBeGreaterThan(0)
    expect(urlWords('8 a.m. e.g. i.e. $45.50 v2.0', website)).toEqual([])
    expect(g('We can refund that.')).toMatchObject({ kind: 'fix', problems: ['promise_words'], words: ['refund'] })
  })
})

describe('(7) masking for the model and the stored transcript share one pattern set', () => {
  it('masks every phone form the reviewer used, in both', () => {
    for (const n of [
      '(201) 555-0123',
      '201.555.0123',
      '201-555-0123',
      '+1 201 555 0123',
      '2015550123',
      '555-0123',
      '555.0123',
      '201/555-0123',
      '2 0 1 5 5 5 0 1 2 3',
      '201 555 01 23',
      '201-5550-123',
    ]) {
      expect(maskForModel(`Call ${n} please`), n).toBe('Call [number] please')
      expect(redactText(`Call ${n} please`), n).toMatch(/^Call (?:\+1)?\**0123 please$/)
    }
    // not numbers: a date, a time, a price, a ZIP+4, an invoice number, a time range
    for (const t of ['Sat 2026-06-13 at 10:30, $1,299', 'Sat 2026-06-13 10:30', 'Garfield NJ 07026-1234', 'invoice INV-2026-0042', 'from 9:00-17:00']) {
      expect(maskForModel(t), t).toBe(t)
      expect(redactText(t), t).toBe(t)
    }
  })
})

describe('form', () => {
  it('strips markdown and lists into one plain line, GSM-7 only', () => {
    expect(stripMarkdown('**Hours:**\n- Mon 8:00 AM\n- Tue 8:00 AM')).toBe('Hours: Mon 8:00 AM Tue 8:00 AM')
    expect(toGsm7('Great 👍 — see you “soon” 你好')).toBe('Great - see you "soon"')
    expect(g('**Hi!** We’re open _today_.')).toEqual({ kind: 'ok', text: "Hi! We're open today.", rendered: "Hi! We're open today." })
  })

  it('allows one question, at most MAX_REPLY_CHARS characters (or the limit the turn passes)', () => {
    expect(g('What is your name? And what car do you drive?')).toMatchObject({ kind: 'fix', problems: ['questions'] })
    expect(cutAfterFirstQuestion('Hi Maria! What is your name? And your car?')).toBe('Hi Maria! What is your name?')
    const long = `${'We wash cars by hand. '.repeat(20)}`.trim()
    expect(g(long)).toMatchObject({ kind: 'fix', problems: ['too_long'] })
    const cut = cutAtSentence(long)
    expect(cut.length).toBeLessThanOrEqual(MAX_REPLY_CHARS)
    expect(cut.endsWith('hand.')).toBe(true)
    expect(guardReply({ text: 'We wash cars by hand.', website, maxChars: 10 })).toMatchObject({ kind: 'fix', problems: ['too_long'] })
    expect(g('').kind).toBe('fix')
  })
})
