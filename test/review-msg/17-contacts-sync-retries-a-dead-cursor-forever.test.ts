// Review finding 17: orders and transactions restart a window when Squarespace answers 400 to the saved cursor (it expired).
// The hourly contacts read does not: it keeps the dead cursor as its resume point, answers 400 on every later run, and after
// five failed runs the resource is dead-lettered. Contacts feed the customer links that membership matching depends on.
import { describe, expect, it } from 'vitest'
import { SquarespaceApiError } from '../../src/integrations/squarespace/errors.js'
import { syncRig } from '../payments-sync/helpers.js'

describe('SyncEngine.syncContacts with a saved cursor that Squarespace no longer accepts', () => {
  it('starts the list again instead of retrying the dead cursor', async () => {
    const r = syncRig()
    const cursorsAsked: Array<string | undefined> = []
    r.source.listContacts = async (p) => {
      cursorsAsked.push(p.cursor)
      if (p.cursor) throw new SquarespaceApiError(400, { type: 'INVALID_REQUEST_ERROR' }, 'GET', '/v1/contacts') // the cursor expired
      return { items: [], nextCursor: 'page-2' }
    }
    expect((await r.engine.syncContacts()).status).toBe('error') // page 2 is refused
    cursorsAsked.length = 0
    await r.engine.syncContacts() // the next run
    expect(cursorsAsked[0], 'the next run must not begin with the cursor that was refused').toBeUndefined()
  })
})
