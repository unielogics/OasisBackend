// The 'square' row of GET /system/integrations (and GET /integrations/square): provider, what is missing before Square works live,
// warnings, the last success and error, and non-secret details. The token and the webhook keys appear only as "set" / "not set".
import type { Env } from '../../config/env.js'
import { SQUARE_API_VERSION, squareItemsOn, squareLocationId } from '../../integrations/square/config.js'
import type { Executor } from '../../platform/db.js'
import { getDefaultLocation } from '../../platform/locations.js'
import { maskText } from '../../platform/logging.js'
import type { IntegrationStatus } from '../system/integrations.js'
import { squareCounts } from './db/alerts.js'
import { currentSquareState, squareEnvironment } from './db/state.js'
import '../catalog/square/schema.js'

const H = 3600_000

/** Membership enrollments under way (a page submitted, the first payment not taken yet), wave Q3b. */
async function pendingEnrollments(db: Executor, locationId: string): Promise<number> {
  const r = await db
    .selectFrom('square_enrollments')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('location_id', '=', locationId)
    .where('state', 'in', ['started', 'customer_ready', 'card_saved', 'subscribed'])
    .executeTakeFirst()
  return Number(r?.n ?? 0)
}
/** The item library sync's health (ADR 0172): the tax check's block, and the links that failed. */
async function itemsHealth(db: Executor, locationId: string, environment: 'sim' | 'sandbox' | 'production'): Promise<{ blocked: string | null; failed: number }> {
  const [state, failed] = await Promise.all([
    db.selectFrom('square_items_state').select('tax_check').where('location_id', '=', locationId).where('environment', '=', environment).executeTakeFirst(),
    db
      .selectFrom('square_catalog_links')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('location_id', '=', locationId)
      .where('environment', '=', environment)
      .where('kind', '=', 'item')
      .where('state', '=', 'failed')
      .executeTakeFirst(),
  ])
  const check = state?.tax_check as { status?: string; detail?: string } | null | undefined
  return { blocked: check && (check.status === 'blocked' || check.status === 'error') ? (check.detail ?? 'the tax check failed') : null, failed: Number(failed?.n ?? 0) }
}
const at = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)
const latest = (...ds: Array<Date | null | undefined>): Date | null => ds.reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null)

export async function squareStatus(db: Executor, env: Env, now: Date): Promise<IntegrationStatus> {
  const location = await getDefaultLocation(db)
  const state = location ? await currentSquareState(db, location.id, env) : undefined
  const live = env.SQUARE_PROVIDER === 'live'
  const missing: string[] = []
  const warnings: string[] = []
  if (!live) missing.push('SQUARE_PROVIDER=live')
  for (const k of ['SQUARE_ACCESS_TOKEN', 'SQUARE_LOCATION_ID', 'SQUARE_APPLICATION_ID', 'SQUARE_WEBHOOK_SIGNATURE_KEY', 'SQUARE_WEBHOOK_URL'] as const)
    if (!env[k]) missing.push(k)
  if (!state?.events_enabled_at) missing.push('Events API not enabled (Settings, Square, Test connection: POST /api/v1/integrations/square/test)')
  if (live && !state?.webhook_subscription_id)
    warnings.push('no webhook subscription verified for SQUARE_WEBHOOK_URL (pnpm square:webhooks --apply, then Test connection); the 10-minute catch-up still reads every event')
  if (env.SQUARE_ENVIRONMENT === 'sandbox') warnings.push('SQUARE_ENVIRONMENT=sandbox: test money only')
  if (!env.SQUARE_WRITES_ENABLED) warnings.push('SQUARE_WRITES_ENABLED=false: observe-only, nothing is created or changed at Square')
  if (env.PAYMENT_PROCESSOR !== 'square') warnings.push('PAYMENT_PROCESSOR=squarespace: links, saved cards, memberships and refunds still use Squarespace')
  if (!live) warnings.push('SQUARE_PROVIDER=sim: an in-process simulator answers; nothing reaches Square')
  if (env.SQUARE_API_BASE) warnings.push('SQUARE_API_BASE overrides the Square host (simulator use only)')
  if (env.SQUARE_POS_API_ENABLED && env.SQUARE_ENVIRONMENT !== 'production') warnings.push('SQUARE_POS_API_ENABLED outside production')
  if (live && (!state?.last_catchup_at || now.getTime() - state.last_catchup_at.getTime() > 30 * 60_000))
    warnings.push('the Events API catch-up has not run in the last 30 minutes (job square.events.catchup)')
  if (state?.watermark && now.getTime() - state.watermark.getTime() > 27 * 24 * H)
    warnings.push('the catch-up watermark is older than 27 days (no complete catch-up since): Square keeps events 28 days, some may be lost')
  if (
    state?.last_catchup_claimed_at &&
    now.getTime() - state.last_catchup_claimed_at.getTime() < 24 * H &&
    (!state.last_webhook_at || now.getTime() - state.last_webhook_at.getTime() > 24 * H)
  )
    warnings.push('no webhook in 24 hours while the catch-up found events: check the subscription and /hooks/square')
  const test = state?.last_test ?? null
  const counts = location ? await squareCounts(db, location.id, now) : { unmatched: 0, failedRefunds: 0 }
  if (counts.unmatched > 0) warnings.push(`${counts.unmatched} Square payment(s) to match (Payments, Square payments to match)`)
  if (counts.failedRefunds > 0) warnings.push(`${counts.failedRefunds} card refund(s) Square refused in the last 14 days: give the money back another way`)
  // the Square item library (ADR 0172): a sync the tax check pauses, and services Square did not take
  const items = location && squareItemsOn(env) ? await itemsHealth(db, location.id, squareEnvironment(env)) : null
  if (items?.blocked) warnings.push(`Square item sync paused: ${items.blocked}`)
  if (items && items.failed > 0) warnings.push(`${items.failed} service(s) not synced to Square’s item library (Settings, Billing & integrations)`)
  return {
    key: 'square',
    label: 'Square (payments, links, memberships, counter)',
    provider: env.SQUARE_PROVIDER,
    live,
    configured: live && missing.length === 0,
    missing,
    warnings,
    lastSuccessAt: at(latest(state?.last_webhook_at, state?.last_catchup_at, test?.ok ? state?.last_test_at : null, state?.last_reconcile_at)),
    lastErrorAt: at(state?.last_error_at),
    lastError: state?.last_error ? maskText(state.last_error).slice(0, 300) : null,
    details: {
      environment: env.SQUARE_ENVIRONMENT,
      location: squareLocationId(env) ?? null,
      merchant: state?.merchant_id ?? null,
      apiVersion: env.SQUARE_API_VERSION,
      apiVersionPinned: env.SQUARE_API_VERSION === SQUARE_API_VERSION,
      writesEnabled: env.SQUARE_WRITES_ENABLED,
      processor: env.PAYMENT_PROCESSOR,
      posApiEnabled: env.SQUARE_POS_API_ENABLED,
      token: env.SQUARE_ACCESS_TOKEN ? 'set' : 'not set',
      webhookKey: env.SQUARE_WEBHOOK_SIGNATURE_KEY ? (env.SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS ? 'set, previous key too (rotation)' : 'set') : 'not set',
      eventsEnabledAt: at(state?.events_enabled_at),
      webhookSubscription: state?.webhook_subscription_id ? 'verified' : null,
      lastWebhookAt: at(state?.last_webhook_at),
      catchupWatermark: at(state?.watermark),
      lastCatchupAt: at(state?.last_catchup_at),
      lastReconcileAt: at(state?.last_reconcile_at),
      lastTestOk: test ? test.ok : null,
      // the payments to match and the card refunds Square refused (wave Q2b); membership enrollments under way (wave Q3b)
      unmatched: counts.unmatched,
      failedRefunds: counts.failedRefunds,
      pendingEnrollments: location ? await pendingEnrollments(db, location.id) : 0,
      itemsSync: squareItemsOn(env),
    },
  }
}
