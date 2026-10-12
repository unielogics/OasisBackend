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
  SQUARE_POS_INTENT_UNKNOWN: {
    status: 404,
    title: 'Unknown Square POS request',
    detail: 'That Square POS answer does not match a payment started from Oasis.',
  },
})
