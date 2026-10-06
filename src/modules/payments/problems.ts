// Problem codes of the Payments module. Where the design has a toast or inline guard text it is used verbatim (title,
// detail or both) so the dashboard can show the problem unchanged; {placeholders} are filled by AppError params.
import { registerProblems } from '../../platform/errors.js'

registerProblems({
  PAY_NOTHING_TO_COLLECT: {
    status: 422,
    title: 'Nothing to collect',
    detail: 'This invoice has no balance due',
  },
  PAY_NOTHING_TO_APPLY: {
    status: 422,
    title: 'No credit to apply',
    detail: 'The client has no store credit or this invoice has no balance due',
  },
  PAY_AMOUNT_INVALID: {
    status: 422,
    title: 'Check the amount',
    detail: 'Enter an amount greater than zero',
  },
  REFUND_EXCEEDS_CARD: {
    status: 422,
    title: 'Refund to card not possible',
    detail: 'Only {max} was paid by card — refund the rest to store credit.',
  },
  REFUND_EXCEEDS_REFUNDABLE: {
    status: 422,
    title: 'Refund too large',
    detail: 'More than the refundable amount.',
  },
  ITEM_ALREADY_REFUNDED: {
    status: 422,
    title: 'Item already refunded',
    detail: 'One or more of the selected items was already refunded or has a refund waiting for approval',
  },
  OVER_LIMIT: {
    status: 422,
    title: 'Over your limit',
    detail: 'Over your {limit} as {role}.',
  },
  ADJUST_EXCEEDS_INVOICE: {
    status: 422,
    title: 'Discount too large',
    detail: 'Discount is larger than the invoice.',
  },
  CANT_APPROVE: {
    status: 403,
    title: 'Your role can’t approve {amount}',
    detail: 'Your role can’t approve {amount}',
  },
  SELF_APPROVAL: {
    status: 403,
    title: 'Needs another approver',
    detail: 'You can’t approve a refund you requested. Ask another approver.',
  },
  REFUND_NOT_PENDING: {
    status: 409,
    title: 'Already resolved',
    detail: 'This refund request was already approved or denied',
  },
  INVOICE_CANCELED: {
    status: 409,
    title: 'Invoice canceled',
    detail: 'A canceled invoice can’t be changed this way',
  },
  VOID_NOT_ALLOWED: {
    status: 422,
    title: 'Can’t void this payment',
    detail:
      'Only a cash payment or a card payment still waiting on Squarespace can be voided. Refund confirmed card payments instead',
  },
  PAYMENT_ALREADY_VOIDED: {
    status: 409,
    title: 'Already voided',
    detail: 'This payment was already voided',
  },
  EVENT_NOT_AWAITING: {
    status: 409,
    title: 'Nothing to confirm',
    detail: 'This entry is not waiting on Squarespace',
  },
  ADDON_REMOVE_OVERPAID: {
    status: 409,
    title: 'Can’t remove add-on',
    detail: 'Refund or adjust the invoice first — removing it would leave the invoice overpaid',
  },
  PAYMENT_LINK_REQUIRED: {
    status: 422,
    title: 'Payment link needed',
    detail: 'Paste the Squarespace payment link for this invoice first',
  },
  PAYMENT_LINK_HOST: {
    status: 422,
    title: 'Link not allowed',
    detail: 'Payment links must be HTTPS links on an allowed host ({hosts})',
  },
  EXPORT_TOO_LARGE: {
    status: 422,
    title: 'Export too large',
    detail: 'Narrow the date range or filter. Exports are limited to {max} invoices',
  },
})
