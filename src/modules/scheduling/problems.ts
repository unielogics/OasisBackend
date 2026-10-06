// Error copy of the Operations guards. For guard failures title and detail are exactly the design's toast strings
// (curly apostrophes included); codes the other designs or reviews did not cover (NOT_TODAY, BAY_UNAVAILABLE, ...) get
// copy in the same voice (review B28). Registered on import and idempotent, so another module that registers the same
// code (the payments module owns ADDON_REMOVE_OVERPAID too) can load first without a conflict.
import { problemDef, registerProblems, type ProblemDef } from '../../platform/errors.js'

const defs: Record<string, ProblemDef> = {
  ALREADY_IN_BAY: { status: 409, title: 'Already in a bay', detail: 'That vehicle is in Bay {n}' },
  BAY_UNAVAILABLE: {
    status: 409,
    title: 'Bay {n} is unavailable',
    detail: 'It is out of service right now. Pick another bay',
  },
  NOT_TODAY: { status: 409, title: 'Not today', detail: 'Only jobs booked for today can go into a bay' },
  CANT_MOVE_JOB: {
    status: 409,
    title: 'Can’t move this job',
    detail: 'It’s already in progress or done',
  },
  INVALID_TRANSITION: { status: 409, title: 'Can’t do that now', detail: 'This job is {status}' },
  NO_NEXT_STEP: {
    status: 409,
    title: 'Nothing to advance',
    detail: 'This job is finished. Collect payment from the invoice',
  },
  SLOT_PAST: { status: 409, title: 'Time has passed', detail: 'Pick a time from now on' },
  SLOT_CLOSED: { status: 409, title: 'Shop is closed', detail: '{reason} · override required' },
  SLOT_OUTSIDE_HOURS: {
    status: 409,
    title: 'Outside opening hours',
    detail: '{detail} · override required',
  },
  SLOT_OUTSIDE_WINDOW: {
    status: 409,
    title: 'Too far ahead',
    detail: 'Online booking opens {days} days ahead',
  },
  OVERRIDE_NOT_ALLOWED: {
    status: 403,
    title: 'Override not allowed',
    detail: 'Ask a manager to override this slot',
  },
  OVERRIDE_REASON_REQUIRED: {
    status: 422,
    title: 'Reason required',
    detail: 'Add a reason for the override',
  },
  TOO_EARLY_FOR_NO_SHOW: {
    status: 409,
    title: 'Too early',
    detail: 'A no-show can be marked {grace} minutes after the start time',
  },
  // Identical to the payments module's definition (the gateway throws it); one copy, so load order cannot matter.
  ADDON_REMOVE_OVERPAID: {
    status: 409,
    title: 'Can’t remove add-on',
    detail: 'Refund or adjust the invoice first — removing it would leave the invoice overpaid',
  },
  NOT_AN_ADDON: { status: 422, title: 'Not an add-on', detail: 'Pick an add-on from the catalog' },
}

export function ensureSchedulingProblems(): void {
  const missing: Record<string, ProblemDef> = {}
  for (const [code, def] of Object.entries(defs)) if (!problemDef(code)) missing[code] = def
  if (Object.keys(missing).length) registerProblems(missing)
}

ensureSchedulingProblems()
