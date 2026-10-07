import { registerProblems } from '../../platform/errors.js'

registerProblems({
  FEATURE_DISABLED: {
    status: 409,
    title: 'Not turned on',
    detail: 'Standing appointments and the waitlist are not turned on for this shop',
  },
  STANDING_OFF: {
    status: 409,
    title: 'Standing appointments are off',
    detail: 'Turn on standing appointments in the VIP settings first',
  },
  STANDING_VIP_ONLY: {
    status: 422,
    title: 'VIP clients only',
    detail: 'Standing appointments are for VIP clients',
  },
  STANDING_CADENCE_NOT_OFFERED: {
    status: 422,
    title: 'Cadence not offered',
    detail: 'That repeat is not one of the cadences offered in the VIP settings',
  },
  STANDING_NOT_FOUND: { status: 404, title: 'Not found', detail: 'That standing appointment does not exist' },
  WAITLIST_NOT_FOUND: { status: 404, title: 'Not found', detail: 'That waitlist entry does not exist' },
  WAITLIST_NO_OFFER: {
    status: 409,
    title: 'No open offer',
    detail: 'There is no open offer for this entry, or it has expired',
  },
  WAITLIST_NOT_WAITING: {
    status: 409,
    title: 'Not waiting',
    detail: 'This entry is no longer waiting for a slot',
  },
})
