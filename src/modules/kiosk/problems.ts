// Problem codes of kiosk mode (ADR 0180 and its 2026-10-14 amendment; catalog in src/platform/errors.ts). The strings are what the
// keypad and the kiosk show.
import { registerProblems } from '../../platform/errors.js'

registerProblems({
  KIOSK_FORBIDDEN: {
    status: 403,
    title: 'Not on the kiosk',
    detail: 'A manager needs to sign in to do that',
  },
  KIOSK_EMPLOYEE_REQUIRED: {
    status: 428,
    title: 'Who’s doing this?',
    detail: 'Tap your name first',
  },
  KIOSK_EMPLOYEE_INVALID: {
    status: 422,
    title: 'Tap your name again',
    detail: 'That name can’t be used on the kiosk. Tap your name again',
  },
  KIOSK_NOT_AT_SHOP: {
    status: 403,
    title: 'Not at the shop',
    detail: 'PINs work only at the shop, on the shop’s Wi-Fi.',
  },
  KIOSK_OFF: {
    status: 409,
    title: 'Kiosk mode is off',
    detail: 'Kiosk mode is off. Sign in with your email and password',
  },
  KIOSK_PIN_WRONG: {
    status: 401,
    title: 'Wrong PIN',
    detail: 'That PIN didn’t work.',
  },
  KIOSK_THROTTLED: {
    status: 429,
    title: 'Too many tries',
    detail: 'Wait a moment before trying again',
  },
  KIOSK_LOCKED_OUT: {
    status: 423,
    title: 'Kiosk locked',
    detail: 'Too many wrong PINs. A manager needs to clear it in Settings → Kiosk.',
  },
  NOT_A_KIOSK: {
    status: 403,
    title: 'Not a kiosk',
    detail: 'This works only on an unlocked kiosk',
  },
  KIOSK_PIN_REJECTED: {
    status: 422,
    title: 'Choose another PIN',
    detail: 'That PIN can’t be used. Choose another',
  },
  KIOSK_PIN_INACTIVE: {
    status: 409,
    title: 'Not active',
    detail: 'A deactivated employee can’t have a PIN',
  },
  KIOSK_ADDRESS_CHANGED: {
    status: 409,
    title: 'Your connection changed',
    detail: 'Your internet address changed. Check you’re on the shop’s Wi-Fi, then try again',
  },
  KIOSK_REFUSED_UNKNOWN: {
    status: 404,
    title: 'Not in the list',
    detail: 'That address isn’t in the list of PINs tried from a new network',
  },
})
