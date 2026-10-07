// Problem codes of the Squarespace sync API (RFC 9457 catalog, platform/errors.ts).
import { registerProblems } from '../../../platform/errors.js'

registerProblems({
  WEBHOOK_SIGNATURE_INVALID: {
    status: 401,
    title: 'Signature invalid',
    detail: 'The webhook signature does not match',
  },
  SQSP_NOT_CONFIGURED: {
    status: 409,
    title: 'Squarespace is not connected',
    detail: 'Add the Squarespace API key in Settings before syncing',
  },
  SQSP_CONNECTION_FAILED: {
    status: 422,
    title: 'Squarespace did not accept the key',
    detail: 'Squarespace rejected the request. Check the API key and its permissions',
  },
  SQSP_ORDER_NOT_FOUND: {
    status: 404,
    title: 'Order not found',
    detail: 'That Squarespace order has not been synced',
  },
  SQSP_ORDER_NOT_MATCHABLE: {
    status: 409,
    title: 'Order not matchable',
    detail: 'This order is ignored or is a membership payment, so there is nothing to match',
  },
  SQSP_NOTHING_TO_MATCH: {
    status: 409,
    title: 'Nothing left to match',
    detail: 'Every payment on this order is already matched',
  },
  SQSP_MATCH_TARGET_REQUIRED: {
    status: 422,
    title: 'Pick what to match',
    detail: 'Choose an invoice, or a card payment waiting on Squarespace',
  },
  SQSP_MATCH_DUPLICATE: {
    status: 409,
    title: 'Possible double count',
    detail:
      'This invoice already shows a payment of the same amount. Confirm that one instead, or match with force',
  },
  SQSP_MATCH_CURRENCY: {
    status: 422,
    title: 'Not a US dollar order',
    detail: 'This order was paid in another currency, so it cannot be recorded against a dollar invoice',
  },
  SQSP_EVENT_NOT_AWAITING: {
    status: 409,
    title: 'Not waiting on Squarespace',
    detail: 'That entry is not waiting on Squarespace',
  },
  SQSP_MATCH_AMBIGUOUS: {
    status: 422,
    title: 'Which payment?',
    detail: 'This order has several payments. Match the payment with the same amount as the entry',
  },
  SQSP_ORDER_ALREADY_MATCHED: {
    status: 409,
    title: 'Order already matched',
    detail: 'Money from this order is already on an invoice, so it cannot be ignored',
  },
})
