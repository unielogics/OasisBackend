// The Events API catch-up (ADR 0171): every 10 minutes, SearchEvents from the watermark minus 10 minutes (ascending, paged), each event
// claimed in the same webhook_log('square', event_id) the hook uses, so an event is processed once whether the webhook or the
// catch-up saw it first. The watermark is the newest event read, and after a complete run with no failure at least the run's time
// minus 10 minutes. Square keeps events 28 days: the search never starts earlier, and a watermark older than 27 days (runs failing or
// never finishing for that long) is an alert (events may be lost). Each run also takes up, from the log itself, the rows the window
// no longer reads: a row the hook claimed whose job was lost, and failed rows (review Q4 SQ-SEM-5), each kind with its own budget, a
// failed row only once its back-off has passed (10 minutes after its first failure, doubling, at most a day: SQ-SEM-5-R1). Runs only
// when SQUARE_PROVIDER=live and the token and location are set.
import { sql } from 'kysely'
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
/** Rows a run takes up outside its search window, of each kind (lost jobs oldest first; failed rows least recently tried first). */
export const STUCK_BATCH = 50
const FAILED_RETRY_FIRST_MS = 10 * MIN
const FAILED_RETRY_MAX_MS = DAY

/** How long a failed row waits after its last try (webhook_log.attempts failures so far): 10 minutes, doubling, at most a day. */
export function failedRetryDelayMs(attempts: number): number {
  const n = Math.max(1, attempts)
  return n > 20 ? FAILED_RETRY_MAX_MS : Math.min(FAILED_RETRY_MAX_MS, FAILED_RETRY_FIRST_MS * 2 ** (n - 1))
}

/** A failed row whose back-off has passed (one never tried has no processed_at: due). */
const failedDue = (row: { processed_at: Date | null; attempts: number }, now: Date): boolean =>
  !row.processed_at || now.getTime() - row.processed_at.getTime() >= failedRetryDelayMs(row.attempts)

export interface CatchupReport {
  status: 'skipped' | 'ok' | 'error'
  reason?: string
  read: number
  claimed: number
  processed: number
  ignored: number
  failed: number
  /** Rows outside the search window run again: claimed by the hook but never run (a lost job), or failed (review Q4 SQ-SEM-5). */
  rescued: number
  from?: string
  watermark?: string | null
  stale: boolean
  complete: boolean
}

/**
 * The rows the search window no longer reads (review Q4 SQ-SEM-5): with steady traffic the watermark follows the run time, so a row
 * the hook claimed whose job was lost (still `received` after 15 minutes) or a `failed` row falls out of the window. They are taken
 * from the log itself (Square keeps events 28 days) and run again; a failure here never holds the watermark back. Each kind has its
 * own budget, so rows that keep failing never starve a lost one, and a failed row waits its back-off (SQ-SEM-5-R1).
 */
async function rescueStuck(d: SquareEventDeps, now: Date, seen: ReadonlySet<string>, r: CatchupReport): Promise<void> {
  const since = new Date(now.getTime() - EVENTS_RETENTION_MS)
  const lost = await d.db
    .selectFrom('webhook_log')
    .select(['external_id'])
    .where('provider', '=', 'square')
    .where('status', '=', 'received')
    .where('received_at', '<', new Date(now.getTime() - STUCK_MS))
    .where('received_at', '>', since)
    .orderBy('received_at')
    .limit(STUCK_BATCH + seen.size)
    .execute()
  // the due ones are picked in SQL: the delay of failedRetryDelayMs, least recently tried first
  const failed = await d.db
    .selectFrom('webhook_log')
    .select(['external_id'])
    .where('provider', '=', 'square')
    .where('status', '=', 'failed')
    .where('received_at', '>', since)
    .where((eb) =>
      eb.or([
        eb('processed_at', 'is', null),
        eb(
          'processed_at',
          '<=',
          sql<Date>`${now}::timestamptz - least(${FAILED_RETRY_MAX_MS}::bigint, ${FAILED_RETRY_FIRST_MS}::bigint * power(2, least(greatest(attempts, 1), 21) - 1)::bigint) * interval '1 millisecond'`,
        ),
      ]),
    )
    .orderBy('processed_at')
    .orderBy('received_at')
    .limit(STUCK_BATCH + seen.size)
    .execute()
  for (const batch of [lost, failed]) {
    let n = 0
    for (const row of batch) {
      if (seen.has(row.external_id)) continue
      if (n++ >= STUCK_BATCH) break
      try {
        const out = await processLoggedEvent(d, row.external_id)
        if (out === 'processed' || out === 'ignored') r.rescued++
        if (out === 'processed') r.processed++
        else if (out === 'ignored') r.ignored++
      } catch (err) {
        d.logger.warn({ square: { event: row.external_id }, err: maskText(String(err)) }, 'square catch-up: a stuck event failed again (tried again after its back-off)')
      }
    }
  }
}

export async function runSquareCatchup(d: SquareEventDeps, o: { force?: boolean } = {}): Promise<CatchupReport> {
  const empty = { read: 0, claimed: 0, processed: 0, ignored: 0, failed: 0, rescued: 0, stale: false, complete: true }
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
  const seen = new Set<string>()
  try {
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await d.api.events.search({ start_at: from.toISOString(), event_types: [...SQUARE_EVENT_TYPES], cursor, limit: 100 })
      pages++
      for (const e of page.items) {
        r.read++
        seen.add(e.event_id)
        const at = new Date(e.created_at)
        if (!Number.isNaN(at.getTime()) && (!newest || at > newest)) newest = at
        const claimed = await log.claim(e.event_id, d.clock.now(), { headers: { source: 'catchup' }, body: JSON.stringify(e) })
        if (claimed) r.claimed++
        else {
          // already claimed: by the hook (its job runs it) or by an earlier catch-up; a failed row, or one received and never run
          // (a lost job), is run again here
          const row = await log.get(e.event_id)
          const lost = row?.status === 'received' && now.getTime() - row.received_at.getTime() > STUCK_MS
          // a failed row waits its back-off (SQ-SEM-5-R1); the rescue takes it up once due, wherever the window is then
          const due = row?.status === 'failed' && failedDue(row, now)
          if (!due && !lost) continue
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
    await rescueStuck(d, now, seen, r)
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
