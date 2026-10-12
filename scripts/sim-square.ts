/**
 * Square API simulator over HTTP: `pnpm sim:square`.
 *
 * Serves every /v2 call Oasis makes (locations, payments, refunds, payment links, orders, customers, cards, catalog, subscriptions,
 * invoices, events, webhook subscriptions) from memory, the way the sandbox answered on 2026-10-12 (docs/integrations/square.md
 * section 8), with real idempotency, test nonces (cnon:card-nonce-ok, -declined, -rejected-cvv ...), clock-driven refunds and
 * subscription billing, an event log for SearchEvents, signed webhook delivery, and controls under /__sim:
 *   POST /__sim/links/:id/pay {tipCents?}                 the buyer pays a payment link
 *   POST /__sim/pos/payment {amountCents, tipCents?, note?, sourceType CARD|CASH, customerId?}   a counter (POS app) payment
 *   POST /__sim/pos/refund {paymentId, amountCents}       a refund made in the Square app
 *   POST /__sim/subscriptions/:id/bill {outcome paid|failed}
 *   POST /__sim/cards/:id/auto-update {last4?, expYear?} | /__sim/cards/:id/forget
 *   POST /__sim/refunds/:id/fail {status FAILED|REJECTED}
 *   POST /__sim/faults {status 429|500, hang?, times, path?, method?}
 *   POST /__sim/webhooks {url, signatureKey} | {mode normal|duplicate|out_of_order, deliver true|false}   POST /__sim/webhooks/flush
 *   POST /__sim/clock {advanceMs}                          GET /__sim/state | /__sim/requests | /__sim/deliveries
 *
 *   pnpm sim:square [--port 4593] [--token sim-square-access-token] [--location LSIMOASIS0001] [--seed demo|none]
 *                   [--webhook-url http://127.0.0.1:4000/hooks/square --webhook-key <key>]
 *
 * Point the app at it with SQUARE_PROVIDER=live SQUARE_API_BASE=http://127.0.0.1:4593 SQUARE_ACCESS_TOKEN=sim-square-access-token
 * SQUARE_LOCATION_ID=LSIMOASIS0001 (plus the webhook URL and key it signs with). SQUARE_PROVIDER=sim needs none of this: it runs the
 * same simulator inside the process.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SIM_ACCESS_TOKEN, SIM_LOCATION_ID } from '../src/integrations/square/config.js'
import { SquareSimApi, SquareSimStore, closeSim, createSquareSimHttpServer, listenSim, seedSquareDemo } from '../src/integrations/square/sim/index.js'
import { systemClock } from '../src/platform/clock.js'

function args(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true
    else {
      out[a.slice(2)] = next
      i++
    }
  }
  return out
}

const opt = args()
if (opt.help) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('*/')[0]!
      .replace(/^\/\*\*\n|^ \* ?/gm, ''),
  )
  process.exit(0)
}

const token = String(opt.token ?? SIM_ACCESS_TOKEN)
const store = new SquareSimStore(systemClock, { locationId: String(opt.location ?? SIM_LOCATION_ID) })
const api = new SquareSimApi(store, { tokens: [token] })
if (typeof opt['webhook-url'] === 'string' && typeof opt['webhook-key'] === 'string')
  api.addWebhookSubscription({ url: opt['webhook-url'], signatureKey: opt['webhook-key'] })
const seed = String(opt.seed ?? 'demo')
if (seed === 'demo') seedSquareDemo(store)

const server = createSquareSimHttpServer(api)
const base = await listenSim(server, Number(opt.port ?? 4593))
console.log(`Square simulator listening on ${base}  (location ${store.locationId}, merchant ${store.merchantId}, seed=${seed})`)
console.log(`  Authorization: Bearer ${token === SIM_ACCESS_TOKEN ? token : '<the --token value>'}   Square-Version: 2026-09-16`)
console.log(`  GET ${base}/v2/locations   POST ${base}/v2/payments   POST ${base}/v2/events   ... (pnpm sim:square --help)`)
console.log(`  controls: ${base}/__sim/state | /__sim/requests | /__sim/deliveries | POST /__sim/pos/payment | /__sim/links/:id/pay ...`)

const stop = async () => {
  await closeSim(server)
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
