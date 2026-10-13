// Problem codes of kiosk mode (ADR 0180; catalog in src/platform/errors.ts). The strings are what the keypad and the kiosk show.
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
  KIOSK_DEVICE_UNKNOWN: {
    status: 403,
    title: 'Not the shop’s tablet',
    detail: 'Codes work only on the shop’s kiosk tablet.',
  },
  KIOSK_OFF: {
    status: 409,
    title: 'Kiosk mode is off',
    detail: 'Kiosk mode is off. Sign in with your email and password',
  },
  KIOSK_CODE_NOT_SET: {
    status: 409,
    title: 'No shop code yet',
    detail: 'A manager needs to set the shop code first',
  },
  KIOSK_CODE_WRONG: {
    status: 401,
    title: 'Wrong code',
    detail: 'That code didn’t work.',
  },
  KIOSK_THROTTLED: {
    status: 429,
    title: 'Too many tries',
    detail: 'Wait a moment before trying again',
  },
  KIOSK_LOCKED_OUT: {
    status: 423,
    title: 'Kiosk locked',
    detail: 'Too many wrong codes. A manager needs to sign in on this tablet.',
  },
  NOT_A_KIOSK: {
    status: 403,
    title: 'Not a kiosk',
    detail: 'This works only on an unlocked kiosk',
  },
  KIOSK_CODE_REJECTED: {
    status: 422,
    title: 'Choose another code',
    detail: 'That code can’t be used. Choose another',
  },
  KIOSK_DEVICE_EXISTS: {
    status: 409,
    title: 'Already a kiosk',
    detail: 'This browser is already a kiosk',
  },
})
