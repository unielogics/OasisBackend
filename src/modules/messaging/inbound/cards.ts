// Card numbers texted in (ADR 0160 W4b fix X6): a client sometimes texts a payment card number. Like a reply code it is never kept
// readable: before an inbound text is filed (sms_inbox, the thread's messages row, the event stream, staff alerts), before its
// webhook delivery is stored final (webhook_log) and before an assistant transcript is stored, every run of 13 to 19 digits (single
// spaces or dashes between them allowed) that passes the Luhn check becomes "[card ending 1234]": the last four digits only, so
// staff can still tell which card the client meant. Pure.

/** 13 to 19 digits in a row, single spaces or dashes between them allowed (never after a "+": an international phone number). */
const CARD_RUN = /(?<![\d+])(?<![\d+][ -])\d(?:[ -]?\d){12,18}(?![\d])/g

/** What a masked card number reads as (the assistant's card line keys on it too). */
export const CARD_MASK_RE = /\[card ending \d{4}\]/

export const cardMask = (last4: string): string => `[card ending ${last4}]`

/** The Luhn check of a digit string. */
export function luhnValid(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2
    sum += d
  }
  return digits.length >= 13 && sum % 10 === 0
}

/** Every Luhn-valid card number of the text masked to its last four digits; anything else is left as it is. */
export function maskCardNumbers(text: string): string {
  return text.replace(CARD_RUN, (m) => {
    const digits = m.replace(/\D/g, '')
    return luhnValid(digits) ? cardMask(digits.slice(-4)) : m
  })
}

/** True when the text holds a card number, readable or already masked. */
export function holdsCardNumber(text: string): boolean {
  if (CARD_MASK_RE.test(text)) return true
  for (const m of text.matchAll(CARD_RUN)) if (luhnValid(m[0].replace(/\D/g, ''))) return true
  return false
}
