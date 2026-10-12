// pnpm square:webhooks  -  shows (and with --apply creates or updates) the Square webhook subscription for SQUARE_WEBHOOK_URL with
// every event type Oasis handles (src/integrations/square/webhook.ts) at the pinned API version. When it CREATES the subscription it
// prints the new signature key ONCE: put it in the secret right away (pnpm secrets:push SQUARE_WEBHOOK_SIGNATURE_KEY), then run
// Test connection. --rotate-key asks Square for a new key (printed once); keep the old one as SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS
// until the new one is live (docs/integrations/square.md section 6). Square needs a public https URL: there is nothing to register
// for a sandbox stack without one.
//
//   pnpm square:webhooks                 what exists for SQUARE_WEBHOOK_URL, and what --apply would change
//   pnpm square:webhooks --apply         create it, or update its event types / API version / enabled flag
//   pnpm square:webhooks --rotate-key    a new signature key for the existing subscription
import { applySecretEnvironment } from '../src/config/secrets-source.js'
import { loadEnv } from '../src/config/env.js'
import { SQUARE_API_VERSION } from '../src/integrations/square/config.js'
import { squareApiFor } from '../src/integrations/square/factory.js'
import { sqKey } from '../src/integrations/square/keys.js'
import { SQUARE_EVENT_TYPES } from '../src/integrations/square/webhook.js'
import type { SquareApi } from '../src/integrations/ports/square.js'

export interface WebhookPlan {
  action: 'none' | 'create' | 'update'
  subscriptionId?: string
  missingTypes: string[]
  reasons: string[]
}

/** Decides what --apply would do for the URL (pure, tested). */
export function planWebhookSubscription(
  subs: Array<{ id: string; notification_url?: string | null; event_types?: string[] | null; api_version?: string | null; enabled?: boolean | null }>,
  url: string,
  apiVersion = SQUARE_API_VERSION,
): WebhookPlan {
  const sub = subs.find((s) => s.notification_url === url)
  if (!sub) return { action: 'create', missingTypes: [...SQUARE_EVENT_TYPES], reasons: [`no subscription for ${url}`] }
  const missingTypes = SQUARE_EVENT_TYPES.filter((t) => !(sub.event_types ?? []).includes(t))
  const reasons = [
    ...(missingTypes.length ? [`lacks ${missingTypes.join(', ')}`] : []),
    ...(sub.api_version !== apiVersion ? [`API version ${sub.api_version ?? 'none'} instead of ${apiVersion}`] : []),
    ...(sub.enabled === false ? ['disabled'] : []),
  ]
  return { action: reasons.length ? 'update' : 'none', subscriptionId: sub.id, missingTypes, reasons }
}

export async function runSquareWebhooks(
  api: SquareApi,
  o: { url: string; apply: boolean; rotate: boolean; log: (l: string) => void },
): Promise<number> {
  const subs = await api.webhooks.list({ include_disabled: true })
  const plan = planWebhookSubscription(subs.items, o.url)
  o.log(`webhook subscription for ${o.url}: ${plan.action === 'none' ? 'up to date' : plan.reasons.join('; ')}`)
  if (o.rotate) {
    if (!plan.subscriptionId) {
      o.log('nothing to rotate: create the subscription first (--apply)')
      return 1
    }
    const key = await api.webhooks.rotateSignatureKey(sqKey('wh', `rotate:${plan.subscriptionId}:${new Date().toISOString().slice(0, 16)}`), plan.subscriptionId)
    o.log('NEW signature key (shown once; move the current key to SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS, then push this one as SQUARE_WEBHOOK_SIGNATURE_KEY):')
    o.log(key)
    return 0
  }
  if (!o.apply || plan.action === 'none') {
    if (plan.action !== 'none') o.log('run again with --apply to fix it')
    return 0
  }
  const input = { name: 'Oasis Auto Spa', event_types: [...SQUARE_EVENT_TYPES], notification_url: o.url, api_version: SQUARE_API_VERSION, enabled: true }
  if (plan.action === 'create') {
    const sub = await api.webhooks.create(sqKey('wh', `create:${o.url}`), input)
    o.log(`created subscription ${sub.id}. Its signature key (shown once; pnpm secrets:push it as SQUARE_WEBHOOK_SIGNATURE_KEY now):`)
    o.log(sub.signature_key ?? '(Square returned no key: rotate it with --rotate-key)')
  } else {
    await api.webhooks.update(plan.subscriptionId!, input)
    o.log(`updated subscription ${plan.subscriptionId}; its signature key is unchanged`)
  }
  return 0
}

if (process.argv[1]?.endsWith('square-webhooks.ts')) {
  const argv = process.argv.slice(2)
  applySecretEnvironment()
    .then(async () => {
      const env = loadEnv()
      if (env.SQUARE_PROVIDER !== 'live' || !env.SQUARE_WEBHOOK_URL) {
        console.log('square:webhooks needs SQUARE_PROVIDER=live with SQUARE_ACCESS_TOKEN and SQUARE_WEBHOOK_URL (the public https URL of /hooks/square)')
        process.exit(2)
      }
      const api = squareApiFor(env, { writesEnabled: false })
      process.exit(await runSquareWebhooks(api, { url: env.SQUARE_WEBHOOK_URL, apply: argv.includes('--apply'), rotate: argv.includes('--rotate-key'), log: console.log }))
    })
    .catch((e: unknown) => {
      console.error((e as Error).message)
      process.exit(1)
    })
}
