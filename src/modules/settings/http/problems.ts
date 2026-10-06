import { registerProblems } from '../../../platform/errors.js'

registerProblems({
  EMERGENCY_NOTHING_TO_CLOSE: {
    status: 422,
    title: 'Already closed',
    detail: 'The shop is already closed for the rest of today. Choose Multiple days to close from tomorrow',
  },
  VIP_CLIENT_AMBIGUOUS: {
    status: 409,
    title: 'Which client?',
    detail: 'More than one client matches that name. Pick the right one',
  },
  VIP_CLIENT_NOT_FOUND: {
    status: 404,
    title: 'No such client',
    detail: 'No client has that name. Add them as a customer first',
  },
})
