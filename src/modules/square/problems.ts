// Problem codes of the Square integration (RFC 9457 catalog, platform/errors.ts).
import { registerProblems } from '../../platform/errors.js'

registerProblems({
  // the same copy as the Squarespace hook's (payments-sync/db/problems.ts): one code for every signed hook
  WEBHOOK_SIGNATURE_INVALID: {
    status: 401,
    title: 'Signature invalid',
    detail: 'The webhook signature does not match',
  },
})
