// Problem copy of the identity core (ADR 0160, design section 5). Written for the client on the link page (W3 maps these codes
// onto the page's states), never for staff: no internal state, no hint whether a PIN exists before five wrong tries. A wrong PIN and
// a PIN entered where none exists answer the same IDENTITY_PIN_INVALID.
import { registerProblems } from '../../platform/errors.js'

registerProblems({
  IDENTITY_LINK_INVALID: {
    status: 401,
    title: 'This link no longer works',
    detail: 'This link expired or was replaced. Text us and we’ll send you a new one.',
  },
  IDENTITY_LINK_USED: {
    status: 409,
    title: 'This link was already used',
    detail: 'This link was already used. Text us and we’ll send you a new one.',
  },
  IDENTITY_SESSION_INVALID: {
    status: 401,
    title: 'Open your link again',
    detail: 'Your page timed out. Open the link from our text again.',
  },
  // the fifth wrong PIN or code of a page: the session ends (the same answer whether a PIN exists or not)
  IDENTITY_SESSION_LOCKED: {
    status: 429,
    title: 'Too many tries',
    detail: 'Too many tries. Open the link from our text again later.',
  },
  IDENTITY_PIN_INVALID: {
    status: 401,
    title: 'That PIN didn’t match',
    detail: 'That PIN didn’t match. {left} more {tries} on this page.',
  },
  IDENTITY_PIN_LOCKED: {
    status: 429,
    title: 'PIN locked for now',
    detail: 'Too many wrong PINs. Try again in {minutes} min, or reset your PIN with a texted code.',
  },
  IDENTITY_PIN_DISABLED: {
    status: 423,
    title: 'PIN locked',
    detail: 'Your PIN is locked after too many wrong tries. Reset it with a texted code.',
  },
  IDENTITY_TOO_MANY_TRIES: {
    status: 429,
    title: 'Too many tries',
    detail: 'Too many wrong tries from this device. Try again in {minutes} min.',
  },
  IDENTITY_PIN_REJECTED: {
    status: 422,
    title: 'Choose another PIN',
    detail: '{reason}',
  },
  IDENTITY_PIN_EXISTS: {
    status: 409,
    title: 'You already have a PIN',
    detail: 'You already have a PIN. Enter it, or reset it with a texted code.',
  },
  IDENTITY_PIN_NOT_SET: {
    status: 409,
    title: 'No PIN yet',
    detail: 'You don’t have a PIN yet. Confirm with a texted code to create one.',
  },
  // a PIN outranks a texted code once set: the code only resets it
  IDENTITY_PIN_REQUIRED: {
    status: 409,
    title: 'Enter your PIN',
    detail: 'Enter your PIN to continue, or reset it with a texted code.',
  },
  IDENTITY_CODE_REQUIRED: {
    status: 403,
    title: 'Confirm with a code first',
    detail: 'Confirm with the code we text you, then choose your PIN within 10 minutes.',
  },
  IDENTITY_STEP_UP_REQUIRED: {
    status: 403,
    title: 'Confirm it’s you',
    detail: 'Enter your PIN or a texted code to continue.',
  },
  IDENTITY_UNKNOWN_CLIENT: {
    status: 409,
    title: 'We don’t have you on file yet',
    detail: 'Book a visit first, then you can create a PIN.',
  },
  IDENTITY_NO_PHONE: {
    status: 422,
    title: 'No mobile number',
    detail: 'This client has no mobile number on file, so no personal link can be sent.',
  },
  IDENTITY_LINK_LIMIT: {
    status: 429,
    title: 'Too many links',
    detail: 'This number already got {what}. Try again later.',
  },
  IDENTITY_NOT_TRUSTED: {
    status: 403,
    title: 'Verification needed',
    detail: 'This number is not verified. Send a verify link first.',
  },
})
