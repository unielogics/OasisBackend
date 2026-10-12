// The Events API catch-up (ADR 0171): every 10 minutes, SearchEvents from the watermark minus 10 minutes (ascending, paged), each event
// claimed in the same webhook_log('square', event_id) the hook uses, so an event is processed once whether the webhook or the
// catch-up saw it first. The watermark is the newest event read, and after a complete run with no failure at least the run's time
// minus 10 minutes. Square keeps events 28 days: the search never starts earlier, and a watermark older than 27 days (runs failing or
// never finishing for that long) is an alert (events may be lost). Runs only when SQUARE_PROVIDER=live and the token and location are set.
import { squareLiveConfigured } from '../../integrations/square/config.js'
import { SQUARE_EVENT_TYPES } from '../../integrations/square/webhook.js'
import { getDefaultLocation } from '../../platform/locations.js'
import { maskText } from '../../platform/logging.js'
import { currentSquareState, saveSquareState } from './db/state.js'
import { processLoggedEvent, squareWebhookLog, type SquareEventDeps } from './events.js'

const MIN = 60_000
const DAY = 86_400_000
export const CATCHUP_OVERLAP_MS = 10 * MIN
export const EVENTS_RETENTION_MS = 28 * DAY
export const WATERMARK_ALERT_MS = 27 * DAY
/** Where the first run starts when no watermark exists yet. */
export const FIRST_RUN_LOOKBACK_MS = DAY
export const CATCHUP_MAX_PAGES = 20
/** A row claimed by the hook but not processed after this long had its job lost: the catch-up runs it. */
export const STUCK_MS = 15 * MIN

export interface CatchupReport {
  status: 'skipped' | 'ok' | 'error'
  reason?: string
  read: number
  claimed: number
  processed: number
  ignored: number
  failed: number
  from?: string
  watermark?: string | null
  stale: boolean
  complete: boolean
}

export async function runSquareCatchup(d: SquareEventDeps, o: { force?: boolean } = {}): Promise<CatchupReport> {
  const empty = { read: 0, claimed: 0, processed: 0, ignored: 0, failed: 0, stale: false, complete: true }
  if (!o.force && !squareLiveConfigured(d.env)) return { status: 'skipped', reason: 'SQUARE_PROVIDER is not live or not configured', ...empty }
  const location = await getDefaultLocation(d.db)
  if (!location) return { status: 'skipped', reason: 'no location', ...empty }
  const state = await currentSquareState(d.db, location.id, d.env)
  const now = d.clock.now()
  const floor = now.getTime() - EVENTS_RETENTION_MS
  const wm = state?.watermark ?? null
  const from = new Date(wm ? Math.max(wm.getTime() - CATCHUP_OVERLAP_MS, floor) : now.getTime() - FIRST_RUN_LOOKBACK_MS)
  const stale = !!wm && now.getTime() - wm.getTime() > WATERMARK_ALERT_MS
  const log = squareWebhookLog(d.db, d.newId)
  const r: CatchupReport = { status: 'ok', ...empty, stale, from: from.toISOString() }
  let newest = wm
  let earliestFailed: Date | null = null
  try {
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await d.api.events.search({ start_at: from.toISOString(), event_types: [...SQUARE_EVENT_TYPES], cursor, limit: 100 })
      pages++
      for (const e of page.items) {
        r.read++
        const at = new Date(e.created_at)
        if (!Number.isNaN(at.getTime()) && (!newest || at > newest)) newest = at
        const claimed = await log.claim(e.event_id, d.clock.now(), { headers: { source: 'catchup' }, body: JSON.stringify(e) })
        if (claimed) r.claimed++
        else {
          // already claimed: by the hook (its job runs it) or by an earlier catch-up; a failed row, or one received and never run
          // (a lost job), is run again here
          const row = await log.get(e.event_id)
          const lost = row?.status === 'received' && now.getTime() - row.received_at.getTime() > STUCK_MS
          if (row?.status !== 'failed' && !lost) continue
        }
        try {
          const out = await processLoggedEvent(d, e.event_id)
          if (out === 'processed') r.processed++
          else if (out === 'ignored') r.ignored++
        } catch (err) {
          r.failed++
          if (!Number.isNaN(at.getTime()) && (!earliestFailed || at < earliestFailed)) earliestFailed = at
          d.logger.warn({ square: { event: e.event_id, type: e.type }, err: maskText(String(err)) }, 'square catch-up: event failed (the next run tries it again)')
        }
      }
      cursor = page.cursor
    } while (cursor && pages < CATCHUP_MAX_PAGES)
    r.complete = !cursor
  } catch (e) {
    const msg = maskText(e instanceof Error ? e.message : String(e)).slice(0, 300)
    await saveSquareState(d.db, location.id, d.env, now, { last_catchup_at: now, last_error: `catch-up: ${msg}`, last_error_at: now })
    throw e
  }
  // a failed event holds the watermark back, so the next run reads it again (and the 27-day alert fires if it never succeeds)
  if (earliestFailed && (!newest || earliestFailed < newest)) newest = earliestFailed
  // a complete run with no failure has covered everything up to now: the watermark moves to at least now minus the overlap even when
  // nothing happened (a quiet week is not lost events; only runs that keep failing or never finish let it age past 27 days)
  else if (r.complete && r.failed === 0) {
    const covered = new Date(now.getTime() - CATCHUP_OVERLAP_MS)
    if (!newest || covered > newest) newest = covered
  }
  r.watermark = newest?.toISOString() ?? null
  const alert = stale
    ? `catch-up: the watermark is older than 27 days (${wm!.toISOString()}): no complete run since then, and Square keeps events 28 days, so some may be lost: reconcile now`
    : null
  if (alert) d.logger.error({ square: { watermark: wm!.toISOString() } }, alert)
  await saveSquareState(d.db, location.id, d.env, now, {
    watermark: newest,
    last_catchup_at: now,
    last_catchup_events: r.read,
    ...(r.claimed > 0 ? { last_catchup_claimed_at: now } : {}),
    ...(alert ? { last_error: alert, last_error_at: now } : state?.last_error?.startsWith('catch-up') ? { last_error: null, last_error_at: null } : {}),
  })
  return r
}
