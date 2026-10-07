// Error copy of the messaging routes. Registered on import and idempotent.
import { problemDef, registerProblems, type ProblemDef } from '../../../platform/errors.js'
import type { SkipReason } from '../queue.js'

const defs: Record<string, ProblemDef> = {
  SMS_OPTED_OUT: {
    status: 422,
    title: 'Customer opted out',
    detail: '{name} texted STOP, so texts to this number are turned off',
  },
  SMS_NOT_OPTED_IN: {
    status: 422,
    title: 'Not opted in to texts',
    detail: '{name} has not agreed to receive texts yet. Record their consent first',
  },
  SMS_NO_PHONE: {
    status: 422,
    title: 'No mobile number',
    detail: 'Add a valid mobile number to text {name}',
  },
  SMS_BLOCKED: {
    status: 422,
    title: 'Text not allowed here',
    detail: '{reason}',
  },
  SMS_TOO_LONG: {
    status: 422,
    title: 'Message too long',
    detail: 'That message would be {segments} text segments. Shorten it to {max} or fewer',
  },
  SMS_EMPTY: { status: 422, title: 'Message is empty', detail: 'Type a message first' },
  SMS_TEMPLATE_INVALID: { status: 422, title: 'Template not available', detail: '{detail}' },
  SMS_STOP_ACTIVE: {
    status: 422,
    title: 'Customer opted out',
    detail: 'They texted STOP. Only they can turn texts back on, by replying START',
  },
  MESSAGE_NOT_RETRYABLE: {
    status: 409,
    title: 'Can’t send again',
    detail: 'Only a failed or expired text can be retried',
  },
  MESSAGE_NOT_CANCELABLE: {
    status: 409,
    title: 'Can’t cancel',
    detail: 'That text has already been handed to the device',
  },
  SMS_NO_DEVICE: {
    status: 409,
    title: 'No SMS device',
    detail: 'Add and enable an SMS device before sending',
  },
}

for (const [code, def] of Object.entries(defs)) {
  const existing = problemDef(code)
  if (!existing) registerProblems({ [code]: def })
}

/** The problem code a refused enqueue maps to. */
export function problemForSkip(skip: SkipReason): { code: string; params: Record<string, unknown> } {
  switch (skip) {
    case 'opted_out':
      return { code: 'SMS_OPTED_OUT', params: {} }
    case 'not_opted_in':
    case 'consent_source_insufficient':
      return { code: 'SMS_NOT_OPTED_IN', params: {} }
    case 'no_valid_phone':
    case 'no_customer':
      return { code: 'SMS_NO_PHONE', params: {} }
    case 'synthetic_number':
      return { code: 'SMS_BLOCKED', params: { reason: 'This is a seeded demo number and is never texted' } }
    case 'not_allowlisted':
      return {
        code: 'SMS_BLOCKED',
        params: { reason: 'Texting is restricted to approved numbers in this environment' },
      }
    case 'empty':
      return { code: 'SMS_EMPTY', params: {} }
    case 'too_long':
      return { code: 'SMS_TOO_LONG', params: {} }
    default:
      return { code: 'SMS_BLOCKED', params: { reason: 'This text could not be sent' } }
  }
}
