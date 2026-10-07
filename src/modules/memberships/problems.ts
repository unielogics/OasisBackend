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
  MEMBERSHIP_EXISTS: {
    status: 409,
    title: 'Already a member',
    detail: 'This client already has a membership',
  },
})
