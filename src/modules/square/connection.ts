// Test connection (POST /integrations/square/test, ADR 0171): ListLocations (the token works; our location is active, USD, takes
// cards), EnableEvents (the catch-up needs it), and our webhook subscription for SQUARE_WEBHOOK_URL carries every event type Oasis
// handles. The merchant id learned here is what the hook checks deliveries against.
import type { Env } from '../../config/env.js'
import type { SquareApi } from '../../integrations/ports/square.js'
import { squareLocationId } from '../../integrations/square/config.js'
import { SquareApiError, SquareAuthError } from '../../integrations/square/errors.js'
import { SQUARE_EVENT_TYPES } from '../../integrations/square/webhook.js'
import { maskText } from '../../platform/logging.js'

export interface ConnectionCheck {
  key: 'token' | 'location' | 'events' | 'webhook'
  ok: boolean
  detail: string
}

export interface ConnectionResult {
  ok: boolean
  checks: ConnectionCheck[]
  merchantId: string | null
  locationId: string | null
  webhookSubscriptionId: string | null
  eventsEnabled: boolean
}

const why = (e: unknown): string =>
  e instanceof SquareAuthError
    ? 'Square refused the access token (401): check SQUARE_ACCESS_TOKEN and SQUARE_ENVIRONMENT'
    : e instanceof SquareApiError
      ? maskText(e.message).slice(0, 200)
      : maskText(e instanceof Error ? e.message : String(e)).slice(0, 200)

export async function testSquareConnection(api: SquareApi, env: Env): Promise<ConnectionResult> {
  const checks: ConnectionCheck[] = []
  const out: ConnectionResult = { ok: false, checks, merchantId: null, locationId: squareLocationId(env) ?? null, webhookSubscriptionId: null, eventsEnabled: false }
  let locations
  try {
    locations = await api.locations.list()
    checks.push({ key: 'token', ok: true, detail: `the token works (Square-Version ${env.SQUARE_API_VERSION}, ${locations.length} location(s))` })
  } catch (e) {
    checks.push({ key: 'token', ok: false, detail: why(e) })
    return out
  }
  const loc = locations.find((l) => l.id === out.locationId)
  if (!loc) checks.push({ key: 'location', ok: false, detail: `location ${out.locationId ?? '(SQUARE_LOCATION_ID not set)'} is not among the token's locations` })
  else {
    out.merchantId = loc.merchant_id ?? null
    const problems = [
      loc.status !== 'ACTIVE' && `status ${loc.status ?? 'unknown'}`,
      loc.currency !== 'USD' && `currency ${loc.currency ?? 'unknown'}`,
      !(loc.capabilities ?? []).includes('CREDIT_CARD_PROCESSING') && 'card processing is not enabled',
    ].filter((x): x is string => !!x)
    checks.push(
      problems.length
        ? { key: 'location', ok: false, detail: `location ${loc.id}: ${problems.join(', ')}` }
        : { key: 'location', ok: true, detail: `location ${loc.id} (${loc.name ?? ''}) is active, in USD and takes cards` },
    )
  }
  try {
    await api.events.enable()
    out.eventsEnabled = true
    checks.push({ key: 'events', ok: true, detail: 'the Events API is enabled (the 10-minute catch-up can read)' })
  } catch (e) {
    checks.push({ key: 'events', ok: false, detail: `EnableEvents: ${why(e)}` })
  }
  if (!env.SQUARE_WEBHOOK_URL) checks.push({ key: 'webhook', ok: false, detail: 'SQUARE_WEBHOOK_URL is not set' })
  else
    try {
      const subs = await api.webhooks.list({ include_disabled: true })
      const sub = subs.items.find((s) => s.notification_url === env.SQUARE_WEBHOOK_URL)
      if (!sub) checks.push({ key: 'webhook', ok: false, detail: `no webhook subscription for ${env.SQUARE_WEBHOOK_URL}: run pnpm square:webhooks --apply` })
      else {
        const lacking = SQUARE_EVENT_TYPES.filter((t) => !(sub.event_types ?? []).includes(t))
        if (sub.enabled === false) checks.push({ key: 'webhook', ok: false, detail: 'our webhook subscription is disabled: pnpm square:webhooks --apply' })
        else if (lacking.length)
          checks.push({ key: 'webhook', ok: false, detail: `our webhook subscription lacks ${lacking.join(', ')}: pnpm square:webhooks --apply` })
        else {
          out.webhookSubscriptionId = sub.id
          checks.push({
            key: 'webhook',
            ok: true,
            detail: `our webhook subscription carries all ${SQUARE_EVENT_TYPES.length} event types${sub.api_version && sub.api_version !== env.SQUARE_API_VERSION ? ` (its API version ${sub.api_version} differs from ${env.SQUARE_API_VERSION})` : ''}`,
          })
        }
      }
    } catch (e) {
      checks.push({ key: 'webhook', ok: false, detail: `ListWebhookSubscriptions: ${why(e)}` })
    }
  out.ok = checks.every((c) => c.ok)
  return out
}
