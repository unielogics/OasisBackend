// Problem codes of the Square item library (ADR 0172). Plain, short copy: the dashboard shows it as is.
import { registerProblems } from '../../../platform/errors.js'

registerProblems({
  SQUARE_ITEMS_SYNC_ON: {
    status: 409,
    title: 'Turn the item sync off first',
    detail: 'The Square item sync is on, so it would put the items back on sale. Turn it off, then archive them.',
  },
})
