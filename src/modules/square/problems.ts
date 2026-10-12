// Problem codes of the Square integration (RFC 9457 catalog, platform/errors.ts). Plain, short copy: the dashboard shows it as is.
import { registerProblems } from '../../platform/errors.js'

registerProblems({
  // the same copy as the Squarespace hook's (payments-sync/db/problems.ts): one code for every signed hook
  WEBHOOK_SIGNATURE_INVALID: {
    status: 401,
    title: 'Signature invalid',
    detail: 'The webhook signature does not match',
  },
  SQUARE_PAYMENT_NOT_FOUND: {
    status: 404,
    title: 'Square payment not found',
    detail: 'That Square payment is not in Oasis yet. Try again in a minute.',
  },
  SQUARE_PAYMENT_DECIDED: {
    status: 409,
    title: 'Already handled',
    detail: 'This Square payment was already matched or set aside.',
  },
  SQUARE_PAYMENT_NOT_MATCHED: {
    status: 409,
    title: 'Not matched yet',
    detail: 'Only a matched Square payment can be moved to another invoice.',
  },
  SQUARE_REASSIGN_REFUNDED: {
    status: 409,
    title: 'Can’t move this payment',
    detail: 'Money was already refunded from this payment. Refund or adjust the invoice instead.',
  },
  SQUARE_CONFIRM_MISMATCH: {
    status: 422,
    title: 'Pick another entry',
    detail: 'That entry is not a card payment of this amount waiting on Square on this invoice.',
  },
  SQUARE_UNAVAILABLE: {
    status: 503,
    title: 'Square is not answering',
    detail: 'Square did not answer. Try again in a minute.',
  },
  SQUARE_WRITES_OFF: {
    status: 409,
    title: 'Square is in watch-only mode',
    detail: 'Oasis only watches Square for now, so it can’t create links or refunds there yet.',
  },
  SQUARE_POS_DISABLED: {
    status: 404,
    title: 'Square POS switch is off',
    detail: 'Opening the Square POS app from Oasis is not turned on.',
  },
  // cards on file (ADR 0171 D7, wave Q3): the client reads these on the card and membership pages
  CARD_CONSENT_INVALID: {
    status: 422,
    title: 'Pick what the card is for',
    detail: 'Tick what we may charge this card for.',
  },
  CARD_CONSENT_OUTDATED: {
    status: 409,
    title: 'The wording changed',
    detail: 'The card terms were updated. Reload the page, read them and try again.',
  },
  CARD_DECLINED: {
    status: 422,
    title: 'Card not saved',
    detail: 'Square could not save this card. Check the details or try another card.',
  },
  SQUARE_CUSTOMER_TAKEN: {
    status: 409,
    title: 'Square customer already linked',
    detail: 'This client’s Square customer is linked to another client. Ask the shop to sort it out.',
  },
  CARD_NOT_FOUND: {
    status: 404,
    title: 'Card not found',
    detail: 'That card is not on file.',
  },
  // wave Q3a: saving cards on the card page, charging them after a staff member confirms
  CARD_SAVE_LOCKED: {
    status: 429,
    title: 'Try again tomorrow',
    detail: 'Too many cards were declined on this number today. Try again tomorrow, or pay at the shop.',
  },
  CARD_PAYMENTS_OFF: {
    status: 409,
    title: 'Saved cards are off',
    detail: 'Saved cards are not turned on yet. Take the payment another way.',
  },
  CARD_LINK_UNAVAILABLE: {
    status: 409,
    title: 'Card links are off',
    detail: 'Personal links are not turned on yet, so a card link can’t be texted.',
  },
  CARD_NOT_USABLE: {
    status: 422,
    title: 'Card can’t be used for this',
    detail: 'This card is removed or expired, or the client did not agree to this kind of charge.',
  },
  CARD_CHARGE_IN_PROGRESS: {
    status: 409,
    title: 'A charge is still going',
    detail: 'A charge on a saved card for this invoice is still waiting for Square. Wait a minute and check again.',
  },
  CARD_CHARGE_DECIDED: {
    status: 409,
    title: 'Already handled',
    detail: 'This fee was already charged or waived.',
  },
  CARD_CHARGE_NOT_FOUND: {
    status: 404,
    title: 'Charge not found',
    detail: 'That charge does not exist.',
  },
  SQUARE_POS_INTENT_UNKNOWN: {
    status: 404,
    title: 'Unknown Square POS request',
    detail: 'That Square POS answer does not match a payment started from Oasis.',
  },
})
