// Problem copy of the personal-link API (ADR 0160, design section 5, wave W3c). Written for the client on the link page, in the
// website's voice: plain, short, never staff detail. The identity core's own codes (IDENTITY_*, src/modules/identity/problems.ts)
// and the website's slot codes (PUBLIC_SLOT_*, src/modules/public/problems.ts) are reused as they are.
import { registerProblems } from '../../../platform/errors.js'

registerProblems({
  // a session of one kind of link asking for another kind's action (a payment page booking, a calendar page paying): the same 401
  // as a dead link, so the page shows "this link no longer works" rather than a half-working form
  LINK_WRONG_PURPOSE: {
    status: 401,
    title: 'This link can’t do that',
    detail: 'This link is for something else. Text us and we’ll send you the right one.',
  },
  LINK_PRIVILEGES_HELD: {
    status: 403,
    title: 'Please wait a little',
    detail: 'Your PIN was just reset, so memberships and payments here open again {until}. Text us if you need help sooner.',
  },
  LINK_ALREADY_MEMBER: {
    status: 409,
    title: 'You’re already a member',
    detail: 'You already have a membership. Text us to change your plan.',
  },
  LINK_CHECKOUT_UNAVAILABLE: {
    status: 409,
    title: 'Joining online isn’t open yet',
    detail: 'Joining online isn’t open right now. Text us and we’ll help you join.',
  },
  LINK_APPOINTMENT_NOT_FOUND: {
    status: 404,
    title: 'Visit not found',
    detail: 'We can’t find that visit. Text us and we’ll help.',
  },
  LINK_CANT_RESCHEDULE: {
    status: 409,
    title: 'This visit can’t be moved here',
    detail: 'This visit can’t be moved online. Text us and we’ll help.',
  },
})
