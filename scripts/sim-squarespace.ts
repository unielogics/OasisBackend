/**
 * Squarespace Commerce API simulator over HTTP: `pnpm sim:squarespace`.
 *
 * Serves the read endpoints Oasis uses (/1.0/commerce/orders, /1.0/commerce/transactions, /v1/contacts) from memory,
 * with a control surface under /__sim for scenarios: orders, subscription renewals, payments, partial refunds, test-mode
 * orders, injected failures/429s, a request-rate limit, and signed webhook delivery.
 *
 *   pnpm sim:squarespace [--port 4590] [--api-key sim-api-key] [--page-size 50] [--order asc|desc]
 *                        [--seed demo|fixtures|none] [--rate-limit 300] [--no-retry-after]
 *                        [--webhook-url https://host/hooks/squarespace --webhook-secret <hex>]
 *
 * Point the app at it with SQSP_PROVIDER=live SQSP_API_BASE=http://127.0.0.1:4590 SQSP_API_KEY=sim-api-key.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { systemClock } from '../src/platform/clock.js'
import { SquarespaceSimApi } from '../src/integrations/squarespace/sim/api.js'
import { close, createSimHttpServer, listen } from '../src/integrations/squarespace/sim/http.js'
import { SquarespaceSimStore } from '../src/integrations/squarespace/sim/store.js'

function args(): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
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

const port = Number(opt.port ?? 4590)
const apiKey = String(opt['api-key'] ?? 'sim-api-key')
const clock = systemClock
const store = new SquarespaceSimStore(clock, {
  pageSize: Number(opt['page-size'] ?? 50),
  order: opt.order === 'desc' ? 'desc' : 'asc',
  currency: 'USD',
})
const api = new SquarespaceSimApi(store, clock, {
  apiKeys: [apiKey],
  sendRetryAfter: opt['no-retry-after'] !== true,
  rateLimit: opt['rate-limit']
    ? { maxPerWindow: Number(opt['rate-limit']), windowMs: 60_000, cooldownMs: 60_000 }
    : null,
  webhook:
    typeof opt['webhook-url'] === 'string' && typeof opt['webhook-secret'] === 'string'
      ? {
          url: opt['webhook-url'],
          secret: opt['webhook-secret'],
          subscriptionId: 'sim_subscription',
          websiteId: 'sim_website',
          autoDeliver: true,
        }
      : null,
})

function seedDemo(): void {
  const DAY = 86_400_000
  const now = clock.now().getTime()
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY)
  const premium = {
    productId: 'sim-prod-premium',
    sku: 'MEM-PREMIUM',
    name: 'Premium Care Membership',
    unitCents: 14900,
  }
  const maria = store.createOrder({
    email: 'maria.alvarez@example.com',
    name: 'Maria Alvarez',
    phone: '5557120188',
    lineItems: [premium],
    taxCents: 1043,
    createdOn: at(62),
  })
  const renewal = store.renewSubscription(maria.orderId, { createdOn: at(32) })
  store.renewSubscription(renewal.orderId, { createdOn: at(2) })
  store.createOrder({
    email: 'liam.chen@example.com',
    name: 'Liam Chen',
    phone: '(555) 301-4420',
    lineItems: [
      { productId: 'sim-prod-detail', sku: 'DET-SEDAN', name: 'Full Detail - Sedan', unitCents: 18900 },
    ],
    taxCents: 1323,
    createdOn: at(1),
    pay: { brand: 'MASTERCARD' },
  })
  const wash = store.createOrder({
    email: 'aisha.rahman@example.com',
    name: 'Aisha Rahman',
    phone: '555-208-1177',
    lineItems: [{ productId: 'sim-prod-wash', sku: 'WASH-EXEC', name: 'Executive Wash', unitCents: 5900 }],
    taxCents: 413,
    createdOn: at(4),
  })
  store.refund(wash.orderId, { amountCents: 2000, refundedOn: at(3) })
  store.createOrder({
    email: 'qa.tester@example.com',
    name: 'QA Tester',
    lineItems: [{ sku: 'WASH-EXEC', name: 'Executive Wash', unitCents: 5900 }],
    testMode: true,
    createdOn: at(1),
  })
  store.createOrder({
    email: 'gift.buyer@example.com',
    name: 'Gift Buyer',
    lineItems: [
      { sku: 'TSHIRT-M', name: 'Oasis T-Shirt (M)', unitCents: 2800, lineItemType: 'PHYSICAL_PRODUCT' },
    ],
    createdOn: at(5),
  })
}

function seedFixtures(): void {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'squarespace')
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as unknown[]
  store.loadWire({
    orders: read('orders.json'),
    documents: read('transactions.json'),
    contacts: read('contacts.json'),
  })
}

const seed = String(opt.seed ?? 'demo')
if (seed === 'demo') seedDemo()
else if (seed === 'fixtures') seedFixtures()

const server = createSimHttpServer(api)
const base = await listen(server, port)
console.log(`Squarespace simulator listening on ${base}  (seed=${seed}, api key "${apiKey}")`)
console.log(
  `  GET  ${base}/1.0/commerce/orders?modifiedAfter=...&modifiedBefore=...   (Authorization: Bearer ${apiKey}, User-Agent required)`,
)
console.log(`  GET  ${base}/1.0/commerce/transactions   GET ${base}/v1/contacts`)
console.log(
  `  POST ${base}/__sim/orders | /__sim/orders/:id/{renew,payments,refunds,state} | /__sim/failures | /__sim/rate-limit | /__sim/webhooks/deliver | /__sim/reset`,
)
console.log(`  GET  ${base}/__sim/state | /__sim/requests`)

const stop = async () => {
  await close(server)
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
