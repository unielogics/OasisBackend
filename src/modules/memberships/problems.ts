// Problem codes of the Memberships module.
import { registerProblems } from '../../platform/errors.js'

registerProblems({
  MEMBERSHIP_NOT_FOUND: {
    status: 404,
    title: 'Membership not found',
    detail: 'That membership does not exist',
  },
  MEMBERSHIP_NOT_ACTIVE: {
    status: 409,
    title: 'Membership not active',
    detail: 'This client’s membership is not active, so no credit can be applied',
  },
  MEMBERSHIP_NOT_ELIGIBLE: {
    status: 409,
    title: 'No credit for this service',
    detail: 'The member’s plan has no credit that covers this service',
  },
  MEMBERSHIP_NO_CREDIT: {
    status: 409,
    title: 'No credit left',
    detail: 'The member has no unused credit for this service this cycle',
  },
  MEMBERSHIP_CREDIT_APPLIED: {
    status: 409,
    title: 'Credit already applied',
    detail: 'A membership credit was already applied to this appointment',
  },
  MEMBERSHIP_NO_BALANCE: {
    status: 409,
    title: 'Nothing to apply it to',
    detail: 'This appointment has no invoice balance due',
  },
  MEMBERSHIP_NO_INVOICE: {
    status: 409,
    title: 'No invoice',
    detail: 'This appointment has no invoice yet',
  },
  MEMBERSHIP_APPOINTMENT_CLOSED: {
    status: 409,
    title: 'Appointment closed',
    detail: 'A canceled or no-show appointment cannot take a credit',
  },
  // a staff membership on a record the stale-record rule holds (W4c re-review 3, D3): staff confirm the client first
  MEMBERSHIP_CLIENT_UNCONFIRMED: {
    status: 409,
    title: 'Confirm who this client is first',
    detail:
      '{why}: whoever has the number now may be a new holder of it. Confirm who they are before adding a membership or setting one live (then confirm the number on their record); if they are new, create a new client.',
  },
  MEMBERSHIP_EXISTS: {
    status: 409,
    title: 'Already a member',
    detail: 'This client already has a membership',
  },
  MEMBERSHIP_CHECKOUT_NOT_FOUND: {
    status: 404,
    title: 'Checkout not found',
    detail: 'That membership checkout does not exist',
  },
  MEMBERSHIP_CHECKOUT_NOT_WAITING: {
    status: 409,
    title: 'Not waiting for staff',
    detail: 'This checkout is {state}, not waiting for a match: reload and try again',
  },
  // ADR 0170: a membership is sold at a size the tier has a price for
  TIER_CLASS_UNPRICED: {
    status: 422,
    title: 'Not sold for that size yet',
    detail: 'This plan has no price for that vehicle size yet. Pick another size or ask us.',
  },
  // ADR 0170 households
  MEMBERSHIP_HOUSEHOLD_TAKEN: {
    status: 409,
    title: 'Already covered',
    detail: 'This client already has a membership or shares another one. Remove them from it first',
  },
  MEMBERSHIP_CHECKOUT_UNAVAILABLE: {
    status: 409,
    title: 'No checkout for this plan',
    detail: 'This plan has no Squarespace checkout link yet. Add it in Settings → Catalog → Memberships',
  },
})
