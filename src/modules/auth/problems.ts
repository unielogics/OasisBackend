// Problem codes of the auth and people modules (catalog in src/platform/errors.ts; strings are what the dashboard shows).
import { registerProblems } from '../../platform/errors.js'

registerProblems({
  INVALID_CREDENTIALS: {
    status: 401,
    title: 'Sign-in failed',
    detail: 'Email or password is incorrect',
  },
  LOGIN_THROTTLED: {
    status: 429,
    title: 'Too many attempts',
    detail: 'Wait a moment before trying again',
  },
  ACCOUNT_DISABLED: {
    status: 403,
    title: 'Account deactivated',
    detail: 'This account has been deactivated. Ask a manager for help',
  },
  CSRF_INVALID: {
    status: 403,
    title: 'Request blocked',
    detail: 'Your session security token is missing or out of date. Reload the page and try again',
  },
  INVITE_INVALID: {
    status: 410,
    title: 'Invite expired',
    detail: 'This invite link is no longer valid. Ask a manager to send a new one',
  },
  RESET_INVALID: {
    status: 410,
    title: 'Link expired',
    detail: 'This reset link is no longer valid. Request a new one',
  },
  EMAIL_TAKEN: { status: 409, title: 'Email in use', detail: 'That email address is already in use' },
  CURRENT_PASSWORD_INVALID: {
    status: 422,
    title: 'Check the form',
    detail: 'Current password is incorrect',
  },
  VIEW_AS_FORBIDDEN: {
    status: 403,
    title: 'Not allowed',
    detail: 'Only a Super Admin can view the app as another role',
  },
  VIEW_AS_ROLE_NOT_FOUND: { status: 404, title: 'Not found', detail: 'That role does not exist' },

  LAST_SUPER_ADMIN: {
    status: 409,
    title: 'Super Admin required',
    detail: 'At least one active Super Admin must remain',
  },
  ROLE_LOCKED: {
    status: 409,
    title: 'Super Admin always has every permission',
    detail: 'Super Admin always has every permission',
  },
  ROLE_NOT_REMOVABLE: { status: 409, title: 'Built-in role', detail: 'Only custom roles can be removed' },
  ROLE_NAME_TAKEN: { status: 409, title: 'Name in use', detail: 'A role with that name already exists' },
  SUPER_ONLY: {
    status: 403,
    title: 'Super Admin only',
    detail: 'Only a Super Admin can do that',
  },
  SELF_DENY_ROLES: {
    status: 422,
    title: 'Not allowed',
    detail: "You can't deny your own access to roles and permissions",
  },
  PRECONDITION_REQUIRED: {
    status: 428,
    title: 'Reload first',
    detail: 'Send the version you are editing in an If-Match header',
  },
  INVITE_NOT_PENDING: {
    status: 409,
    title: 'Nothing to resend',
    detail: 'This person has already accepted their invite or is inactive',
  },
  NO_LOGIN_YET: {
    status: 409,
    title: 'No login yet',
    detail: 'This person has not accepted their invite yet. Resend the invite instead',
  },
})
