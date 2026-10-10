// Problem copy of the public website routes (ADR 0150). The wording is the website design's where it has one (the booking
// sheet's toasts and lock notes in "Oasis Site v2"); the rest is written in the same voice, for a customer, never for staff:
// no override hints, no bay numbers, no internal state.
import { registerProblems } from '../../platform/errors.js'

registerProblems({
  // the design's pickSlot() toast for a booked row, and the owner's wording for the race at confirm time
  PUBLIC_SLOT_BOOKED: {
    status: 409,
    title: 'That time is booked',
    detail: 'That time is booked. Try another.',
  },
  PUBLIC_SLOT_TAKEN: {
    status: 409,
    title: 'That time was just taken',
    detail: 'That time was just taken. Pick another.',
  },
  // the design's lock note on a VIP-held slot (the time is filled in)
  PUBLIC_SLOT_VIP: {
    status: 409,
    title: 'Held for VIP members',
    detail: '{time} is held for VIP members. Join to book it with no fee.',
  },
  PUBLIC_SLOT_PAST: {
    status: 409,
    title: 'That time has passed',
    detail: 'That time has passed. Pick another.',
  },
  PUBLIC_SLOT_CLOSED: {
    status: 409,
    title: 'We’re closed then',
    detail: 'We’re closed at that time. Pick another.',
  },
  PUBLIC_SLOT_TOO_FAR: {
    status: 409,
    title: 'Too far ahead',
    detail: 'Online booking opens {days} days ahead. Pick a sooner time.',
  },
  PUBLIC_OTP_INVALID: {
    status: 401,
    title: 'That code didn’t match',
    detail: 'That code didn’t match. {left} more {tries} before you need a new one.',
  },
  PUBLIC_OTP_EXPIRED: {
    status: 410,
    title: 'That code expired',
    detail: 'That code expired. Request a new one.',
  },
  PUBLIC_OTP_LOCKED: {
    status: 429,
    title: 'Too many tries',
    detail: 'Too many tries. Request a new code.',
  },
  PUBLIC_TOKEN_INVALID: {
    status: 401,
    title: 'Verify your number again',
    detail: 'Your verification expired. Enter your number again and we’ll text a new code.',
  },
  PUBLIC_TOKEN_PHONE_MISMATCH: {
    status: 422,
    title: 'Use the number you verified',
    detail: 'Book with the mobile number you verified, or request a new code for this one.',
  },
  PUBLIC_ALREADY_MEMBER: {
    status: 409,
    title: 'You’re already a member',
    detail: 'This number already has a membership. Text us to change your plan.',
  },
  PUBLIC_RATE_LIMITED: {
    status: 429,
    title: 'Slow down',
    detail: 'Too many requests from this number or device. Try again in {minutes} min.',
  },
})
