// Problem codes of the memberships billed by Square (ADR 0171 wave Q3b). Plain, short copy: the dashboard shows it as is.
import { registerProblems } from '../../../platform/errors.js'

registerProblems({
  MEMBERSHIP_BILLED_BY_SQUARE: {
    status: 409,
    title: 'Billed by Square',
    detail: 'Square bills this membership, so its status, plan and renewal change through the billing actions (pause, cancel, change plan). Only auto-apply and the note can be edited here.',
  },
  MEMBERSHIP_NOT_BILLED_BY_SQUARE: {
    status: 409,
    title: 'Not billed by Square',
    detail: 'This membership is not billed by Square, so it has no Square billing to change.',
  },
  MEMBERSHIP_BILLING_STATE: {
    status: 409,
    title: 'Can’t do that now',
    detail: 'The membership’s billing is not in a state for that. Reload and try again.',
  },
  TIER_PRICE_NOT_SYNCED: {
    status: 409,
    title: 'Price not at Square yet',
    detail: 'This price is not set up at Square yet. Use Sync to Square, then try again.',
  },
})
