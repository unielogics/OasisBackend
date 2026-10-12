// One Square event from the webhook log to its handler: the square.event.process job, the inline path of the hook (no queue) and the
// catch-up all call processLoggedEvent(), so a row is closed the same way whoever got it first.
import type { Env } from '../../config/env.js'
import type { SquareApi } from '../../integrations/ports/square.js'
import { parseSquareEvent } from '../../integrations/square/webhook.js'
import type { Clock } from '../../platform/clock.js'
import type { Db } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { getDefaultLocation } from '../../platform/locations.js'
import { maskText } from '../../platform/logging.js'
import { DbWebhookLog } from '../../platform/webhook-log.js'
import { getSquareState } from './db/state.js'
import { processSquareEvent, type SquareIngest, type SquareLogger } from './ingest.js'

export interface SquareEventDeps {
  db: Db
  clock: Clock
  logger: SquareLogger
  env: Env
  api: SquareApi
  ingest: SquareIngest
  newId: NewId
}

export type LoggedEventResult = 'processed' | 'ignored' | 'missing' | 'done'

export const squareWebhookLog = (db: Db, newId: NewId): DbWebhookLog => new DbWebhookLog(db, newId, 'square')

/** Processes the logged event once; a row already processed or ignored is left alone. Throws (after marking the row failed) to retry. */
export async function processLoggedEvent(d: SquareEventDeps, eventId: string): Promise<LoggedEventResult> {
  const log = squareWebhookLog(d.db, d.newId)
  const row = await log.get(eventId)
  if (!row) return 'missing'
  if (row.status === 'processed' || row.status === 'ignored') return 'done'
  const parsed = parseSquareEvent(row.body ?? '')
  if (!parsed.ok) {
    await log.finish(eventId, 'ignored', d.clock.now(), parsed.reason)
    return 'ignored'
  }
  const location = await getDefaultLocation(d.db)
  if (!location) throw new Error('no location: run the seed first')
  const state = await getSquareState(d.db, location.id)
  try {
    const r = await processSquareEvent(
      { ...d, locationId: location.id, merchantId: state?.merchant_id ?? null },
      parsed.event,
    )
    await log.finish(eventId, r.status, d.clock.now(), r.status === 'ignored' ? r.note : undefined)
    return r.status
  } catch (e) {
    await log.finish(eventId, 'failed', d.clock.now(), maskText(e instanceof Error ? e.message : String(e)))
    throw e
  }
}
