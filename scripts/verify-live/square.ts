// pnpm verify:square  -  walks the Square checklist of docs/integrations/square.md (section 7) against the Square SANDBOX (or the
// simulator with --sim): token, Square-Version and location; the Events API; a customer; a saved card with the ok and the declined
// test nonces; a $1 card-on-file payment and its refund to COMPLETED; a payment link paid through its order with an exact total; a
// subscription plan with a STATIC MONTHLY variation, a subscription whose first invoice is paid, pause, resume, swap and cancel;
// and SearchEvents parsed through our dispatcher. Everything it creates carries a verify- reference and is cleaned up where Square
// allows it (--keep leaves it). Production is refused unless --read-only (then only the reads run).
//
//   pnpm verify:square --secret oasis/sandbox/square --location LCEVRH6NQ775N     the sandbox app's credentials, read at run time
//   pnpm verify:square --sim                                                     the simulator over a loopback socket
//
// The token is never printed or written: it is registered with the report as a secret, requests are reported by method and path
// only, and --capture writes scrubbed copies of the answers (ids replaced, no emails, no URLs beyond their host).
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { DateTime } from 'luxon'
import { applySecretEnvironment, parseSecretDocument } from '../../src/config/secrets-source.js'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { SquareClient } from '../../src/integrations/square/client.js'
import { SQUARE_API_VERSION, SQUARE_BASE_URLS } from '../../src/integrations/square/config.js'
import { SquareApiError, SquareDeclined } from '../../src/integrations/square/errors.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { centsOf, usd } from '../../src/integrations/square/money.js'
import { SQUARE_EVENT_TYPES, classifySquareEvent } from '../../src/integrations/square/webhook.js'
import { wire, wireEvent, type WireCard, type WireCustomer, type WireInvoice, type WireSubscription } from '../../src/integrations/square/wire.js'
import type { SquareApi } from '../../src/integrations/ports/square.js'
import { balanceLines } from '../../src/modules/square/links.js'
import { planRefundLegs } from '../../src/modules/square/refunds.js'
import { parseTaxPercent, salesTaxCents } from '../../src/platform/money.js'
import { sqrItems, sqr20 } from './square-items.js'
import { sqr18 } from './square-tax.js'
import { MissingConfig, Report, UsageError, cli, type ItemDef, type RunContext, type RunResult } from './lib.js'

const DOC = 'docs/integrations/square.md section 7 (Sandbox verification)'
const wireOrderEnvelope = wire.order

export const SQUARE_ITEMS: readonly ItemDef[] = [
  { id: 'SQR-01', title: 'Token, Square-Version and the location (active, USD, card processing)', source: `${DOC}, check 1` },
  { id: 'SQR-02', title: 'Events API enabled; every event type Oasis uses exists for webhooks and events', source: `${DOC}, check 2` },
  { id: 'SQR-03', title: 'A customer is created (verify- reference) and found by its reference id', source: `${DOC}, check 3` },
  { id: 'SQR-04', title: 'A card is saved with the ok nonce; the declined nonces give the mapped codes', source: `${DOC}, check 4` },
  { id: 'SQR-05', title: 'A $1 card-on-file payment completes; its refund reaches COMPLETED', source: `${DOC}, check 5` },
  { id: 'SQR-06', title: 'A payment link has the exact order total, is paid through its order, and is deleted', source: `${DOC}, check 6` },
  { id: 'SQR-07', title: 'Plan and STATIC MONTHLY variation; a subscription with the card; its first invoice is paid', source: `${DOC}, check 7` },
  { id: 'SQR-08', title: 'Pause, resume, swap and cancel; an unpaid subscription invoice paid through its order', source: `${DOC}, check 7` },
  { id: 'SQR-09', title: "SearchEvents returns this run's events and each parses through our dispatcher", source: `${DOC}, check 8` },
  { id: 'SQR-10', title: 'TestWebhookSubscription reaches --webhook-url (optional)', source: `${DOC}, check 9` },
  { id: 'SQR-11', title: 'Cleanup: links deleted, subscriptions canceled, card disabled, customer deleted', source: `${DOC}, check 10` },
  {
    id: 'SQR-12',
    title: "Oasis's own link builder and refund legs: a link with a tax and a tip line totals the balance exactly, paid through its order; a leg refunded with its rf_ key twice is one refund; the leg cap matches Square's",
    source: `${DOC}, check 11 (wave Q2b)`,
  },
  {
    id: 'SQR-13',
    title: "Oasis's own catalog sync: the planner's plan and STATIC MONTHLY variations made by our executor; the same keys answer the same objects; a price edit is a new variation and the old one stays",
    source: `${DOC}, check 12 (wave Q3b)`,
  },
  {
    id: 'SQR-14',
    title: "Oasis's own membership subscription: a deliverable email, CreateSubscription with sb_ from today, the first invoice paid and its period; swap, pause and cancel scheduled at the next billing date and undone; an unpaid invoice canceled",
    source: `${DOC}, check 13 (wave Q3b)`,
  },
  {
    id: 'SQR-18',
    title:
      "Square's sales-tax rounding: CalculateOrder at 6.625% and 7% (half-cent subtotals, baskets, quantities, ORDER / LINE_ITEM / catalog taxes) equals Oasis's tax on every case",
    source: 'docs/integrations/square.md section 15 and ADR 0173 (wave K1e)',
  },
  {
    id: 'SQR-15',
    title: "Oasis's own item library sync: items with a variation per size, categories and the tax made; the same key and body answer the same item and its id_mappings",
    source: 'docs/integrations/square.md section 14 and ADR 0172 (wave K2e)',
  },
  {
    id: 'SQR-16',
    title: 'A price changed in place (same variation, new version); a size renamed and reordered; a size off hidden with its id, on again; archive and back on sale',
    source: 'docs/integrations/square.md section 14 and ADR 0172 (wave K2e)',
  },
  {
    id: 'SQR-17',
    title: 'A variation staff added survives the read-modify-write; a stale version is VERSION_MISMATCH; a BatchUpsert with one bad batch (what happens to the good one)',
    source: 'docs/integrations/square.md section 14 and ADR 0172 (wave K2e)',
  },
  {
    id: 'SQR-19',
    title: 'VARIABLE pricing for a range and a $0 price; CalculateOrder of those catalog lines with the tax auto-applied equals Oasis’s tax',
    source: 'docs/integrations/square.md section 14 and ADR 0172 (wave K2e)',
  },
  {
    id: 'SQR-20',
    title: "(read-only, the production pre-flight) the shop's taxes against Oasis's rate (--rate, default 6.625) and the item count",
    source: 'docs/integrations/square.md section 14 and ADR 0172 (wave K2e)',
  },
]

export const SQUARE_OPTIONS = {
  flags: ['read-only', 'keep', 'tax-only', 'items-only'],
  options: ['secret', 'location', 'capture', 'webhook-url', 'wait', 'rate'],
} as const

/** The facts this run learned about the unknowns of the design ("check in the sandbox"), printed and kept in the report. */
export interface SquareFindings {
  apiVersion: string
  linkHosts: string[]
  cardSourceType?: string
  cardEntryMethod?: string
  declines: Record<string, string>
  refundStatusFirst?: string
  refundCompletedAfterMs?: number
  linkOrderStateBeforePay?: string
  linkOrderStateAfterPay?: string
  linkAfterPay?: string
  firstInvoicePaidAfterMs?: number | null
  firstInvoiceStatusFirst?: string
  subscriptionStatusFirst?: string
  unpaidInvoicePaidByOrderPayment?: string
  swapTiming?: string
  pauseTiming?: string
  resumeResult?: string
  cancelResult?: string
  cancelAgain?: string
  eventsApi?: string
  eventTypesSeen: Record<string, number>
  /** wave Q3b */
  membershipEmail?: string
  membershipFirstInvoice?: string
  membershipPeriod?: string
  membershipSwap?: string
  membershipPause?: string
  membershipCancel?: string
  membershipInvoiceCancel?: string
}

interface Config {
  baseUrl: string
  token: string
  environment: 'sandbox' | 'production' | 'sim'
  locationId?: string
  target: string
  close?: () => Promise<void>
}

const NONCE_OK = 'cnon:card-nonce-ok'
const DECLINE_NONCES = {
  'cnon:card-nonce-declined': 'GENERIC_DECLINE',
  'cnon:card-nonce-rejected-cvv': 'CVV_FAILURE',
  'cnon:card-nonce-rejected-postalcode': 'ADDRESS_VERIFICATION_FAILURE',
  'cnon:card-nonce-rejected-expiration': 'INVALID_EXPIRATION',
} as const

export async function runSquare(ctx: RunContext): Promise<RunResult> {
  let cfg: Config
  try {
    cfg = await configure(ctx)
  } catch (e) {
    if (e instanceof MissingConfig) return { missing: e }
    throw e
  }
  try {
    return { report: await verify(ctx, cfg) }
  } finally {
    await cfg.close?.()
  }
}

async function configure(ctx: RunContext): Promise<Config> {
  const { args, env } = ctx
  if (args.flag('sim')) {
    const sim = await import('../../src/integrations/square/sim/index.js')
    const store = new sim.SquareSimStore({ now: () => ctx.now() }, { locationId: 'LSIMVERIFY001' })
    const api = new sim.SquareSimApi(store, { tokens: ['sim-verify-token'] })
    const server = sim.createSquareSimHttpServer(api)
    const base = await sim.listenSim(server, 0)
    return {
      baseUrl: base,
      token: 'sim-verify-token',
      environment: 'sim',
      locationId: args.value('location') ?? 'LSIMVERIFY001',
      target: `simulator ${base}`,
      close: () => sim.closeSim(server),
    }
  }
  let source: Record<string, string | undefined> = env
  const secretId = args.value('secret')
  if (secretId) {
    const sm = new SecretsManagerClient({ region: env.AWS_REGION ?? 'us-east-1' })
    const out = await sm.send(new GetSecretValueCommand({ SecretId: secretId }))
    source = { ...env, ...parseSecretDocument(out.SecretString, secretId) }
  }
  const token = source.SQUARE_ACCESS_TOKEN?.trim()
  if (!token)
    throw new MissingConfig(
      'square',
      [{ name: 'SQUARE_ACCESS_TOKEN', why: 'the sandbox (or production) access token of the Square app' }],
      [
        'Read the sandbox app from Secrets Manager: pnpm verify:square --secret oasis/sandbox/square --location <sandbox location id>',
        'or put SQUARE_ACCESS_TOKEN (and SQUARE_ENVIRONMENT, SQUARE_LOCATION_ID) in the shell, or run against the simulator with --sim.',
      ],
    )
  const environment = source.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox'
  if (environment === 'production' && !args.flag('read-only'))
    throw new UsageError('this is a production token: only --read-only runs against production (no customer, card, payment or plan is created)')
  const baseUrl = (source.SQUARE_API_BASE ?? SQUARE_BASE_URLS[environment]).replace(/\/+$/, '')
  return {
    baseUrl,
    token,
    environment,
    locationId: args.value('location') ?? source.SQUARE_LOCATION_ID,
    target: `${environment} ${baseUrl}`,
  }
}

interface Captured {
  method: string
  path: string
  status: number
  body: unknown
}

async function verify(ctx: RunContext, cfg: Config): Promise<Report> {
  const { args } = ctx
  const report = new Report(
    'square',
    'Square verification',
    SQUARE_ITEMS,
    { mode: cfg.environment === 'sim' ? 'sim' : 'live', target: cfg.target },
    ctx.now,
    ctx.log,
  )
  report.secret(cfg.token)
  const captured: Captured[] = []
  const capture = args.value('capture')
  const baseFetch = fetch
  const recordingFetch: typeof fetch = async (input, init) => {
    const res = await baseFetch(input, init)
    if (capture) {
      const text = await res.clone().text()
      let body: unknown = text
      try {
        body = JSON.parse(text)
      } catch {
        // kept as text
      }
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      captured.push({ method: init?.method ?? 'GET', path: decodeURIComponent(url.pathname), status: res.status, body })
    }
    return res
  }
  const client = new SquareClient({
    baseUrl: cfg.baseUrl,
    accessToken: cfg.token,
    apiVersion: SQUARE_API_VERSION,
    fetch: recordingFetch,
    maxAttempts: 3,
    writesEnabled: true,
    timeoutMs: 30_000,
  })
  const api = createSquareApi(client)
  const run = randomUUID()
  const ref = `verify-${run.slice(0, 8)}`
  const startedAt = ctx.now()
  const waitMs = (args.number('wait') ?? 120) * 1000
  const readOnly = args.flag('read-only')
  const keep = args.flag('keep')
  const findings: SquareFindings = { apiVersion: SQUARE_API_VERSION, linkHosts: [], declines: {}, eventTypesSeen: {} }
  const cleanup: Array<{ what: string; run: () => Promise<unknown> }> = []
  const step = async <T>(id: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn()
    } catch (e) {
      report.fail(id, errText(e), fixFor(e))
      return undefined
    }
  }
  const poll = async <T>(read: () => Promise<T>, done: (v: T) => boolean, limitMs = waitMs, everyMs = 2000): Promise<{ value: T; ms: number; done: boolean }> => {
    const t0 = ctx.now().getTime()
    let value = await read()
    while (!done(value) && ctx.now().getTime() - t0 < limitMs) {
      await ctx.sleep(everyMs)
      value = await read()
    }
    return { value, ms: ctx.now().getTime() - t0, done: done(value) }
  }

  // ---- SQR-01 token, version, location --------------------------------------------------------------------------------------
  const location = await step('SQR-01', async () => {
    const locations = await api.locations.list()
    const loc = cfg.locationId ? locations.find((l) => l.id === cfg.locationId) : locations.find((l) => l.status === 'ACTIVE')
    if (!loc) {
      report.fail('SQR-01', `location ${cfg.locationId ?? '(first active)'} not among the ${locations.length} the token sees`, 'pass --location with an id from the Developer Dashboard (Locations)')
      return undefined
    }
    const problems = [
      loc.status !== 'ACTIVE' && `status ${loc.status}`,
      loc.currency !== 'USD' && `currency ${loc.currency}`,
      !(loc.capabilities ?? []).includes('CREDIT_CARD_PROCESSING') && 'no CREDIT_CARD_PROCESSING capability',
    ].filter(Boolean)
    if (problems.length) report.fail('SQR-01', `location ${loc.id}: ${problems.join(', ')}`)
    else
      report.pass('SQR-01', `Square-Version ${SQUARE_API_VERSION} accepted; location ${loc.id} active, USD, card processing (${locations.length} location(s), timezone ${loc.timezone ?? '?'})`)
    return loc
  })
  if (!location) {
    report.note('stopped: nothing else can run without a working token and location')
    writeCapture(capture, captured, ctx)
    return report
  }
  const locationId = location.id
  const tz = location.timezone ?? 'America/New_York'

  // ---- SQR-18 tax rounding (CalculateOrder; the catalog objects it makes are removed by SQR-11) ------------------------------------
  const taxOnly = args.flag('tax-only')
  const itemsOnly = args.flag('items-only')
  if (readOnly) report.skip('SQR-18', '--read-only: the catalog tax cases create objects')
  else if (itemsOnly) report.skip('SQR-18', '--items-only')
  else await step('SQR-18', () => sqr18({ api, client, report, run, ref, locationId, cleanup }, ctx.log))

  // ---- SQR-20 (read-only pre-flight) and SQR-15/16/17/19: the item library (ADR 0172) -------------------------------------------
  const ITEM_CHECKS = ['SQR-15', 'SQR-16', 'SQR-17', 'SQR-19']
  if (taxOnly) for (const id of [...ITEM_CHECKS, 'SQR-20']) report.skip(id, '--tax-only')
  else {
    const rateText = args.value('rate') ?? '6.625'
    const rateDbp = parseTaxPercent(rateText)
    if (rateDbp === null) throw new UsageError(`--rate ${rateText}: a percentage with up to three decimals, such as 6.625`)
    await step('SQR-20', () => sqr20({ api, report, locationId, rateDbp }))
    if (readOnly) for (const id of ITEM_CHECKS) report.skip(id, '--read-only: the item checks create objects')
    else await step('SQR-15', () => sqrItems({ api, report, run, ref, locationId, environment: cfg.environment, cleanup, now: ctx.now }))
  }
  if (taxOnly || itemsOnly) {
    for (const id of ['SQR-02', 'SQR-03', 'SQR-04', 'SQR-05', 'SQR-06', 'SQR-07', 'SQR-08', 'SQR-09', 'SQR-10', 'SQR-12', 'SQR-13', 'SQR-14'])
      report.skip(id, taxOnly ? '--tax-only' : '--items-only')
    await runCleanup(report, cleanup, readOnly, keep, ref)
    writeCapture(capture, captured, ctx)
    return report
  }

  // ---- SQR-02 events API and event types -------------------------------------------------------------------------------------
  await step('SQR-02', async () => {
    if (!readOnly) await api.events.enable()
    const eventTypes = await api.events.listTypes(SQUARE_API_VERSION).catch((e: unknown) => {
      findings.eventsApi = `ListEventTypes failed: ${errText(e)}`
      return null
    })
    const hookTypes = await api.webhooks.listEventTypes(SQUARE_API_VERSION)
    const missingHooks = SQUARE_EVENT_TYPES.filter((t) => !hookTypes.includes(t))
    const missingEvents = eventTypes ? SQUARE_EVENT_TYPES.filter((t) => !eventTypes.includes(t)) : []
    if (missingHooks.length || missingEvents.length)
      report.fail('SQR-02', `unknown event types: webhooks [${missingHooks.join(', ')}] events [${missingEvents.join(', ')}]`, 'fix SQUARE_EVENT_TYPES in src/integrations/square/webhook.ts')
    else
      report.pass('SQR-02', `${readOnly ? 'read-only: events not enabled here; ' : 'EnableEvents ok; '}all ${SQUARE_EVENT_TYPES.length} event types exist (${hookTypes.length} webhook types, ${eventTypes?.length ?? 'no'} event types)`)
  })

  let customer: WireCustomer | undefined
  let card: WireCard | undefined
  if (readOnly) {
    for (const id of ['SQR-03', 'SQR-04', 'SQR-05', 'SQR-06', 'SQR-07', 'SQR-08', 'SQR-11', 'SQR-12', 'SQR-13', 'SQR-14']) report.skip(id, '--read-only: nothing is created')
  } else {
    // ---- SQR-03 customer ------------------------------------------------------------------------------------------------------
    customer = await step('SQR-03', async () => {
      const c = await api.customers.create(sqKey('cu', `${run}:customer`), {
        given_name: 'Verify',
        family_name: 'Run',
        email_address: `${ref}@oasisautospanj.com`,
        reference_id: ref,
        note: 'Created by pnpm verify:square; safe to delete',
      })
      cleanup.push({ what: `customer ${c.id}`, run: () => api.customers.delete(c.id) })
      const again = await api.customers.create(sqKey('cu', `${run}:customer`), {
        given_name: 'Verify',
        family_name: 'Run',
        email_address: `${ref}@oasisautospanj.com`,
        reference_id: ref,
        note: 'Created by pnpm verify:square; safe to delete',
      })
      const found = await poll(() => api.customers.search({ reference_id: ref }), (p) => p.items.some((x) => x.id === c.id), 30_000)
      if (again.id !== c.id) report.fail('SQR-03', 'the same idempotency key created a second customer')
      else if (!found.done) report.fail('SQR-03', `customer ${c.id} created, but SearchCustomers by reference_id did not find it within 30 s`)
      else report.pass('SQR-03', `customer created, the same key answered the same customer, found by reference_id after ${found.ms} ms`)
      return c
    })

    // ---- SQR-04 cards -----------------------------------------------------------------------------------------------------------
    if (customer) {
      const cust = customer
      card = await step('SQR-04', async () => {
        const saved = await api.cards.create(sqKey('cd', `${run}:card`), {
          source_id: NONCE_OK,
          card: { customer_id: cust.id, reference_id: ref, cardholder_name: 'Verify Run', billing_address: { postal_code: '94103' } },
        })
        cleanup.push({ what: `card ${saved.id}`, run: () => api.cards.disable(saved.id) })
        const wrong: string[] = []
        for (const [nonce, expected] of Object.entries(DECLINE_NONCES)) {
          try {
            await api.cards.create(sqKey('cd', `${run}:${nonce}`), { source_id: nonce, card: { customer_id: cust.id, reference_id: ref } })
            findings.declines[`CreateCard ${nonce}`] = 'accepted (no decline on save)'
          } catch (e) {
            findings.declines[`CreateCard ${nonce}`] = codeOf(e)
          }
          try {
            await api.payments.create(sqKey('py', `${run}:${nonce}`), {
              source_id: nonce,
              amount_money: usd(100),
              location_id: locationId,
              autocomplete: true,
              reference_id: ref,
            })
            findings.declines[`CreatePayment ${nonce}`] = 'accepted'
            wrong.push(`${nonce} was accepted by CreatePayment`)
          } catch (e) {
            findings.declines[`CreatePayment ${nonce}`] = codeOf(e)
            if (!(e instanceof SquareDeclined)) wrong.push(`${nonce}: ${errText(e)} is not a PAYMENT_METHOD_ERROR`)
            else if (e.code !== expected) report.note(`${nonce} declined with ${e.code} (expected ${expected}); the friendly text: "${e.friendly}"`)
          }
        }
        if (!saved.enabled || !saved.last_4) report.fail('SQR-04', `card saved but enabled=${saved.enabled} last_4=${saved.last_4 ?? 'none'}`)
        else if (wrong.length) report.fail('SQR-04', wrong.join('; '))
        else
          report.pass('SQR-04', `card ${saved.card_brand} ••${saved.last_4} saved; declines: ${Object.entries(findings.declines).map(([k, v]) => `${k} -> ${v}`).join(', ')}`)
        return saved
      })
    }

    // ---- SQR-05 card-on-file payment and refund -------------------------------------------------------------------------------
    if (customer && card) {
      const cust = customer
      const cd = card
      await step('SQR-05', async () => {
        const p = await api.payments.create(sqKey('py', `${run}:cof`), {
          source_id: cd.id,
          customer_id: cust.id,
          amount_money: usd(100),
          location_id: locationId,
          autocomplete: true,
          reference_id: ref,
          note: `${ref} card on file`,
        })
        findings.cardSourceType = p.source_type ?? undefined
        findings.cardEntryMethod = p.card_details?.entry_method ?? undefined
        if (p.status !== 'COMPLETED') return report.fail('SQR-05', `payment status ${p.status}, expected COMPLETED`)
        const rf = await api.refunds.refund(sqKey('rf', `${run}:refund`), { payment_id: p.id, amount_money: usd(100), reason: `${ref} refund` })
        findings.refundStatusFirst = rf.status
        const done = await poll(() => api.refunds.get(rf.id), (r) => ['COMPLETED', 'FAILED', 'REJECTED'].includes(r.status))
        findings.refundCompletedAfterMs = done.done ? done.ms : undefined
        const after = await api.payments.get(p.id)
        if (done.value.status !== 'COMPLETED') return report.fail('SQR-05', `refund ${done.value.status} after ${done.ms} ms`)
        report.pass(
          'SQR-05',
          `$1.00 paid with the saved card (source_type ${p.source_type}, entry ${p.card_details?.entry_method}); refund ${rf.status} -> COMPLETED after ${done.ms} ms; payment refunded_money ${centsOf(after.refunded_money)}`,
        )
      })
    } else report.skip('SQR-05', 'needs the customer and card of SQR-03/04')

    // ---- SQR-06 payment link paid through its order -----------------------------------------------------------------------------
    await step('SQR-06', async () => {
      const lines = [
        { name: 'Signature Hand Wash · verify', quantity: '1', base_price_money: usd(4000) },
        { name: 'Sales tax', quantity: '1', base_price_money: usd(265) },
      ]
      const expected = 4265
      const { link, order: related } = await api.checkout.createLink(sqKey('pl', `${run}:link`), {
        order: { location_id: locationId, reference_id: ref, line_items: lines },
        checkout_options: { allow_tipping: false, ask_for_shipping_address: false, enable_coupon: false, enable_loyalty: false },
        payment_note: `${ref} INV-00000`,
      })
      cleanup.push({ what: `payment link ${link.id}`, run: () => api.checkout.deleteLink(link.id) })
      const quick = await api.checkout.createLink(sqKey('pl', `${run}:quick`), {
        quick_pay: { name: 'Booking deposit · verify', price_money: usd(2500), location_id: locationId },
        checkout_options: { allow_tipping: false },
      })
      cleanup.push({ what: `quick-pay link ${quick.link.id}`, run: () => api.checkout.deleteLink(quick.link.id) })
      for (const u of [link.url, link.long_url, quick.link.url, quick.link.long_url]) {
        if (!u) continue
        const host = new URL(u).host
        if (!findings.linkHosts.includes(host)) findings.linkHosts.push(host)
      }
      const order = await api.orders.retrieve(link.order_id!)
      const total = centsOf(order.total_money)
      if (total !== expected) return report.fail('SQR-06', `order total ${total}, expected ${expected} (lines plus the tax line)`)
      if (related && centsOf(related.total_money) !== expected) report.note(`CreatePaymentLink's related order total ${centsOf(related.total_money)}`)
      // the hosted checkout opens the link's DRAFT order before it takes the card; a buyer is simulated the same way
      const opened = await client.request({
        method: 'PUT',
        path: `/v2/orders/${encodeURIComponent(order.id)}`,
        body: { idempotency_key: sqKey('py', `${run}:open`), order: { location_id: locationId, state: 'OPEN', version: order.version } },
        idempotencyKey: sqKey('py', `${run}:open`),
        schema: wireOrderEnvelope,
      })
      findings.linkOrderStateBeforePay = `${order.state} (opened to ${opened.order.state} as the hosted checkout does)`
      const paid = await api.payments.create(sqKey('py', `${run}:linkpay`), {
        source_id: NONCE_OK,
        order_id: order.id,
        amount_money: usd(expected),
        location_id: locationId,
        autocomplete: true,
      })
      const orderAfter = await poll(() => api.orders.retrieve(order.id), (o) => o.state === 'COMPLETED', 10_000)
      findings.linkOrderStateAfterPay = orderAfter.value.state ?? undefined
      let linkAfter = 'retrievable'
      try {
        await api.checkout.retrieveLink(link.id)
      } catch (e) {
        linkAfter = `RetrievePaymentLink: ${codeOf(e)}`
      }
      findings.linkAfterPay = linkAfter
      const del = await api.checkout.deleteLink(link.id).catch((e: unknown) => `DeletePaymentLink after paying: ${codeOf(e)}`)
      const delQuick = await api.checkout.deleteLink(quick.link.id)
      if (paid.order_id !== order.id || paid.status !== 'COMPLETED')
        return report.fail('SQR-06', `payment ${paid.status} with order_id ${paid.order_id ?? 'none'}`)
      report.pass(
        'SQR-06',
        `link host(s) ${findings.linkHosts.join(', ')}; order total exactly ${expected}; paid through the order (order ${orderAfter.value.state}); link after paying: ${linkAfter}; delete: ${String(del)}; quick-pay deleted: ${String(delQuick)}`,
      )
    })

    // ---- SQR-12 our link builder and refund legs ------------------------------------------------------------------------------------
    await step('SQR-12', async () => {
      // an invoice nobody paid yet: two lines, 6.625% tax (half to even, ADR 0173) and a tip, as balanceLines builds them for prepareSquareLink
      const items = [
        { name: 'Signature Hand Wash · verify', priceCents: 4000 },
        { name: 'Rain repellent · verify', priceCents: 1500 },
      ]
      const tax = salesTaxCents(5500, { dbp: 6625, rounding: 'half_even' })
      const tip = 300
      const balance = 5500 + tax + tip
      const lines = balanceLines({ invoiceNo: 20640, taxDbp: 6625 }, items, { paid: 0, adj: 0, refunded: 0, pendingAmt: 0, tax, tip, balance, total: balance })
      const { link } = await api.checkout.createLink(sqKey('pl', `${run}:oasis-link`), {
        order: { location_id: locationId, reference_id: ref, line_items: lines.map((l) => ({ name: l.name, quantity: '1', base_price_money: usd(l.cents) })) },
        payment_note: `${ref} INV-20640`,
        checkout_options: { allow_tipping: false, ask_for_shipping_address: false, enable_coupon: false, enable_loyalty: false },
      })
      cleanup.push({ what: `payment link ${link.id}`, run: () => api.checkout.deleteLink(link.id) })
      const order = await api.orders.retrieve(link.order_id!)
      if (centsOf(order.total_money) !== balance) return report.fail('SQR-12', `order total ${centsOf(order.total_money)}, expected exactly ${balance}`)
      await client.request({
        method: 'PUT',
        path: `/v2/orders/${encodeURIComponent(order.id)}`,
        body: { idempotency_key: sqKey('py', `${run}:oasis-open`), order: { location_id: locationId, state: 'OPEN', version: order.version } },
        idempotencyKey: sqKey('py', `${run}:oasis-open`),
        schema: wireOrderEnvelope,
      })
      const paid = await api.payments.create(sqKey('py', `${run}:oasis-pay`), { source_id: NONCE_OK, order_id: order.id, amount_money: usd(balance), location_id: locationId, autocomplete: true })
      if (paid.status !== 'COMPLETED' || paid.order_id !== order.id) return report.fail('SQR-12', `payment ${paid.status} with order_id ${paid.order_id ?? 'none'}`)
      // a refund leg as square.refunds.submit plans and sends it: the same key twice is the same refund
      const ref0 = { paymentId: paid.id, totalCents: centsOf(paid.total_money) || balance, usedCents: 0, occurredAt: new Date(paid.created_at) }
      const legs = planRefundLegs([ref0], 2000)
      if (!legs || legs.length !== 1) return report.fail('SQR-12', `the planner gave ${JSON.stringify(legs)}`)
      const legKey = sqKey('rf', `${run}:leg-1`)
      const first = await api.refunds.refund(legKey, { payment_id: paid.id, amount_money: usd(legs[0]!.amountCents), reason: `${ref} leg` })
      const again = await api.refunds.refund(legKey, { payment_id: paid.id, amount_money: usd(legs[0]!.amountCents), reason: `${ref} leg` })
      if (again.id !== first.id) return report.fail('SQR-12', 'the same leg key answered a second refund')
      // what is left is the cap the planner uses; Square refuses more, as the planner does
      const over = planRefundLegs([{ ...ref0, usedCents: 2000 }], balance - 2000 + 1)
      let squareOver = 'accepted'
      try {
        await api.refunds.refund(sqKey('rf', `${run}:leg-over`), { payment_id: paid.id, amount_money: usd(balance - 2000 + 1), reason: `${ref} over` })
      } catch (e) {
        squareOver = `refused (${codeOf(e)})`
      }
      if (over !== null || squareOver === 'accepted') return report.fail('SQR-12', `over the cap: planner ${JSON.stringify(over)}, Square ${squareOver}`)
      const done = await poll(() => api.refunds.get(first.id), (r) => ['COMPLETED', 'FAILED', 'REJECTED'].includes(r.status))
      report.pass(
        'SQR-12',
        `lines ${lines.map((l) => `${l.name} ${l.cents}`).join(', ')} = ${balance} exactly; paid through the order; leg key twice -> one refund (${done.value.status}); one cent over the cap: planner refuses, Square ${squareOver}`,
      )
    })

    // ---- SQR-13/14 memberships (wave Q3b): our catalog sync and our subscription code, before SQR-07/08 ----------------------------
    if (customer && card) await memberships(api, report, findings, { run, ref, locationId, tz, customer, card, poll, cleanup, ctx })
    else {
      report.skip('SQR-13', 'needs the customer and card of SQR-03/04')
      report.skip('SQR-14', 'needs the customer and card of SQR-03/04')
    }

    // ---- SQR-07/08 subscriptions ----------------------------------------------------------------------------------------------------
    if (customer && card) await subscriptions(api, report, findings, { run, ref, locationId, tz, customer, card, poll, cleanup, ctx })
    else {
      report.skip('SQR-07', 'needs the customer and card of SQR-03/04')
      report.skip('SQR-08', 'needs the customer and card of SQR-03/04')
    }

  }

  // ---- SQR-09 events ---------------------------------------------------------------------------------------------------------
  await step('SQR-09', async () => {
    const since = new Date(startedAt.getTime() - 60_000).toISOString()
    const read = async () => {
      const all = []
      let cursor: string | undefined
      for (let i = 0; i < 20; i++) {
        const page = await api.events.search({ start_at: since, cursor, limit: 100 })
        all.push(...page.items)
        cursor = page.cursor
        if (!cursor) break
      }
      return all
    }
    const res = await poll(read, (evs) => readOnly || evs.some((e) => e.type.startsWith('payment.')), readOnly ? 0 : 60_000, 5000)
    const bad: string[] = []
    for (const e of res.value) {
      const parsed = wireEvent.safeParse(e)
      if (!parsed.success) bad.push(e.event_id)
      const c = classifySquareEvent(e)
      findings.eventTypesSeen[e.type] = (findings.eventTypesSeen[e.type] ?? 0) + 1
      if (c.kind) findings.eventTypesSeen[`-> ${c.kind}`] = (findings.eventTypesSeen[`-> ${c.kind}`] ?? 0) + 1
    }
    findings.eventsApi = `SearchEvents works: ${res.value.length} event(s) since the run started`
    if (bad.length) return report.fail('SQR-09', `${bad.length} event(s) did not parse`)
    if (!readOnly && !res.done) return report.fail('SQR-09', `no payment event within 60 s (${res.value.length} other event(s))`)
    report.pass('SQR-09', `${res.value.length} event(s): ${Object.entries(findings.eventTypesSeen).map(([t, n]) => `${t} x${n}`).join(', ') || 'none'}; all parsed and classified`)
  })

  // ---- SQR-10 webhook test --------------------------------------------------------------------------------------------------------
  const hookUrl = args.value('webhook-url')
  if (!hookUrl) report.skip('SQR-10', 'no --webhook-url (needs a public https URL with a subscription; pnpm square:webhooks --apply)')
  else
    await step('SQR-10', async () => {
      const subs = await api.webhooks.list()
      const sub = subs.items.find((s) => s.notification_url === hookUrl)
      if (!sub) return report.fail('SQR-10', `no webhook subscription for ${hookUrl}`, 'pnpm square:webhooks --apply')
      const r = await api.webhooks.test(sub.id, 'payment.updated')
      if (r.status_code !== 200) return report.fail('SQR-10', `the test delivery answered ${r.status_code ?? 'nothing'}`)
      report.pass('SQR-10', 'the test delivery answered 200 (our hook verified its signature)')
    })

  // ---- SQR-11 cleanup -----------------------------------------------------------------------------------------------------------
  await runCleanup(report, cleanup, readOnly, keep, ref)
  report.note(`findings: ${JSON.stringify(findings)}`)
  writeCapture(capture, captured, ctx)
  return report
}

async function runCleanup(report: Report, cleanup: Array<{ what: string; run: () => Promise<unknown> }>, readOnly: boolean, keep: boolean, ref: string): Promise<void> {
  if (readOnly) return
  if (keep) return report.skip('SQR-11', `--keep: left ${cleanup.length} object(s) in place (reference ${ref})`)
  const left: string[] = []
  for (const c of cleanup.reverse()) {
    try {
      await c.run()
    } catch (e) {
      left.push(`${c.what}: ${codeOf(e)}`)
    }
  }
  if (left.length) report.note(`cleanup left: ${left.join('; ')}`)
  report.pass('SQR-11', `${cleanup.length - left.length} of ${cleanup.length} cleaned${left.length ? `; ${left.length} kept by Square (see notes)` : ''}`)
}

async function subscriptions(
  api: SquareApi,
  report: Report,
  findings: SquareFindings,
  o: {
    run: string
    ref: string
    locationId: string
    tz: string
    customer: WireCustomer
    card: WireCard
    poll: <T>(read: () => Promise<T>, done: (v: T) => boolean, limitMs?: number, everyMs?: number) => Promise<{ value: T; ms: number; done: boolean }>
    cleanup: Array<{ what: string; run: () => Promise<unknown> }>
    ctx: RunContext
  },
): Promise<void> {
  const { run, locationId, customer, card, poll, cleanup } = o
  const today = DateTime.fromJSDate(o.ctx.now()).setZone(o.tz).toFormat('yyyy-MM-dd')
  let subA: WireSubscription | undefined
  let var2: string | undefined
  try {
    const plan = await api.catalog.upsert(sqKey('ct', `${run}:plan`), {
      type: 'SUBSCRIPTION_PLAN',
      id: '#verify-plan',
      subscription_plan_data: { name: `Verify plan ${o.ref}` },
    })
    const variation = (amount: number, n: number) => ({
      type: 'SUBSCRIPTION_PLAN_VARIATION',
      id: `#verify-var-${n}`,
      subscription_plan_variation_data: {
        name: `Verify monthly ${n} ${o.ref}`,
        subscription_plan_id: plan.object.id,
        phases: [{ cadence: 'MONTHLY', ordinal: 0, pricing: { type: 'STATIC', price_money: usd(amount) } }],
      },
    })
    const vars = await api.catalog.batchUpsert(sqKey('ct', `${run}:vars`), [[variation(100, 1), variation(200, 2)]])
    const var1 = vars.objects.find((x) => x.subscription_plan_variation_data?.name?.startsWith('Verify monthly 1'))?.id
    var2 = vars.objects.find((x) => x.subscription_plan_variation_data?.name?.startsWith('Verify monthly 2'))?.id
    if (!var1 || !var2) throw new Error('the batch upsert did not return both variations')
    const catalogIds = [var1, var2, plan.object.id]
    cleanup.push({ what: `catalog plan ${plan.object.id} and variations`, run: () => Promise.all(catalogIds.map((id) => api.catalog.delete(id))) })
    const t0 = o.ctx.now().getTime()
    subA = await api.subscriptions.create(sqKey('sb', `${run}:a`), {
      location_id: locationId,
      plan_variation_id: var1,
      customer_id: customer.id,
      card_id: card.id,
      start_date: today,
      timezone: o.tz,
    })
    findings.subscriptionStatusFirst = subA.status
    const sub = subA
    cleanup.push({ what: `subscription ${sub.id}`, run: () => api.subscriptions.cancel(sub.id) })
    const withInvoice = await poll(
      () => api.subscriptions.retrieve(sub.id),
      (s) => (s.invoice_ids ?? []).length > 0 || ['DEACTIVATED', 'CANCELED'].includes(s.status),
    )
    const invoiceId = withInvoice.value.invoice_ids?.[0]
    if (!invoiceId) {
      report.fail('SQR-07', `subscription ${subA.status} -> ${withInvoice.value.status}: no invoice after ${withInvoice.ms} ms`)
    } else {
      const first = await api.invoices.get(invoiceId)
      findings.firstInvoiceStatusFirst = first.status
      const paid = await poll(() => api.invoices.get(invoiceId), (i) => i.status === 'PAID')
      findings.firstInvoicePaidAfterMs = paid.done ? o.ctx.now().getTime() - t0 : null
      if (!paid.done) report.fail('SQR-07', `first invoice ${paid.value.status} after ${paid.ms} ms (first seen ${first.status})`, 'raise --wait, or note the sandbox does not charge the first invoice')
      else
        report.pass(
          'SQR-07',
          `plan + 2 STATIC MONTHLY variations; subscription ${subA.status} -> ${withInvoice.value.status}; first invoice ${first.status} -> PAID ${findings.firstInvoicePaidAfterMs} ms after CreateSubscription`,
        )
    }
  } catch (e) {
    report.fail('SQR-07', errText(e), fixFor(e))
  }
  if (!subA || !var2) {
    report.skip('SQR-08', 'needs the subscription of SQR-07')
    return
  }
  const id = subA.id
  const notes: string[] = []
  const problems: string[] = []
  try {
    const swap = await api.subscriptions.swapPlan(id, { new_plan_variation_id: var2 })
    const sa = swap.actions.find((a) => a.type === 'SWAP_PLAN')
    findings.swapTiming = sa ? `SWAP_PLAN action effective ${sa.effective_date ?? '?'} (today ${today}); plan_variation_id now ${swap.subscription.plan_variation_id}` : `no SWAP_PLAN action; plan_variation_id now ${swap.subscription.plan_variation_id}`
    notes.push(`swap: ${findings.swapTiming}`)
    if (sa) await api.subscriptions.deleteAction(id, sa.id)
    const pause = await api.subscriptions.pause(id, { pause_cycle_duration: 1 })
    const pa = pause.actions.find((a) => a.type === 'PAUSE')
    findings.pauseTiming = pa ? `PAUSE action effective ${pa.effective_date ?? '?'}; status ${pause.subscription.status}` : `status ${pause.subscription.status}, no PAUSE action`
    notes.push(`pause: ${findings.pauseTiming}`)
    try {
      const resume = await api.subscriptions.resume(id, { resume_change_timing: 'IMMEDIATE' })
      findings.resumeResult = `ok: status ${resume.subscription.status}, actions ${resume.actions.map((a) => `${a.type}@${a.effective_date}`).join(',') || 'none'}`
    } catch (e) {
      findings.resumeResult = `refused: ${codeOf(e)} (a scheduled pause is undone with DeleteSubscriptionAction)`
    }
    notes.push(`resume: ${findings.resumeResult}`)
    const current = await api.subscriptions.retrieve(id, { includeActions: true })
    for (const a of current.actions ?? []) await api.subscriptions.deleteAction(id, a.id).catch(() => undefined)
    const cancel = await api.subscriptions.cancel(id)
    findings.cancelResult = cancel
      ? `status ${cancel.subscription.status}, canceled_date ${cancel.subscription.canceled_date ?? 'none'}, actions ${cancel.actions.map((a) => `${a.type}@${a.effective_date}`).join(',') || 'none'}`
      : 'already canceled'
    notes.push(`cancel: ${findings.cancelResult}`)
    try {
      const again = await api.subscriptions.cancel(id)
      findings.cancelAgain = again ? 'a second cancel was accepted' : 'a second cancel answered an "already" code (treated as done)'
    } catch (e) {
      findings.cancelAgain = `a second cancel: ${codeOf(e)}`
    }
    notes.push(findings.cancelAgain)
  } catch (e) {
    problems.push(`lifecycle: ${errText(e)}`)
  }
  // a subscription without a card: its first invoice waits for the customer; is it paid by CreatePayment on the invoice's order?
  try {
    const subB = await api.subscriptions.create(sqKey('sb', `${run}:b`), {
      location_id: locationId,
      plan_variation_id: var2,
      customer_id: customer.id,
      start_date: today,
      timezone: o.tz,
    })
    cleanup.push({ what: `subscription ${subB.id}`, run: () => api.subscriptions.cancel(subB.id) })
    const withInvoice = await poll(
      () => api.subscriptions.retrieve(subB.id),
      (s) => (s.invoice_ids ?? []).length > 0 || ['DEACTIVATED', 'CANCELED'].includes(s.status),
      60_000,
    )
    const invId = withInvoice.value.invoice_ids?.[0]
    if (!invId) findings.unpaidInvoicePaidByOrderPayment = `no invoice appeared for a subscription without a card (status ${withInvoice.value.status})`
    else {
      const inv: WireInvoice = (await poll(() => api.invoices.get(invId), (i) => !!i.order_id && i.status !== 'DRAFT', 60_000)).value
      const amount = inv.payment_requests?.[0]?.computed_amount_money
      try {
        const p = await api.payments.create(sqKey('py', `${run}:invoice`), {
          source_id: card.id,
          customer_id: customer.id,
          order_id: inv.order_id!,
          amount_money: usd(amount ? centsOf(amount) : 200),
          location_id: locationId,
          autocomplete: true,
        })
        const after = await poll(() => api.invoices.get(invId), (i) => i.status === 'PAID', 30_000)
        findings.unpaidInvoicePaidByOrderPayment = `invoice ${inv.status} -> payment ${p.status} on its order -> invoice ${after.value.status}`
      } catch (e) {
        findings.unpaidInvoicePaidByOrderPayment = `invoice ${inv.status}: CreatePayment on its order refused: ${codeOf(e)}`
      }
    }
    notes.push(`unpaid invoice: ${findings.unpaidInvoicePaidByOrderPayment}`)
  } catch (e) {
    problems.push(`subscription without a card: ${errText(e)}`)
  }
  if (problems.length) report.fail('SQR-08', problems.join('; '), undefined, notes)
  else report.pass('SQR-08', notes.join(' | '))
}

/**
 * SQR-13 and SQR-14 (wave Q3b): Oasis's own membership code against Square, without a database: the catalog planner and executor
 * (memberships/square/catalog-plan.ts, catalog-sync.ts), the subscription request and key (enroll.ts), the paid period and the
 * scheduled actions (policy.ts), the swap replacement (actions.ts) and CancelInvoice.
 */
async function memberships(
  api: SquareApi,
  report: Report,
  findings: SquareFindings,
  o: {
    run: string
    ref: string
    locationId: string
    tz: string
    customer: WireCustomer
    card: WireCard
    poll: <T>(read: () => Promise<T>, done: (v: T) => boolean, limitMs?: number, everyMs?: number) => Promise<{ value: T; ms: number; done: boolean }>
    cleanup: Array<{ what: string; run: () => Promise<unknown> }>
    ctx: RunContext
  },
): Promise<void> {
  const { planCatalogChanges } = await import('../../src/modules/memberships/square/catalog-plan.js')
  const { executeCatalogActions } = await import('../../src/modules/memberships/square/catalog-sync.js')
  const { createMembershipSubscription, subscriptionInput } = await import('../../src/modules/memberships/square/enroll.js')
  const { deliverableEmail, paidPeriod, scheduledAtSquare, shopDate } = await import('../../src/modules/memberships/square/policy.js')
  const { busyAtSquare, replaceSwap } = await import('../../src/modules/memberships/square/actions.js')
  const { run, locationId, poll, cleanup, tz } = o
  // ---- SQR-13 the catalog sync ----------------------------------------------------------------------------------------------------
  const tier = { planId: `verify-tier-${run}`, key: 'verify', name: `Verify tier ${o.ref}`, active: true, squarePlanId: null as string | null }
  const row = (id: string, cents: number, extra: Record<string, unknown> = {}) => ({
    id: `${id}-${run}`,
    planId: tier.planId,
    classKey: id,
    classLabel: id === 'compact' ? 'Compact car' : 'Truck',
    monthlyCents: cents,
    current: true,
    squareVariationId: null as string | null,
    squareState: 'pending' as const,
    inUse: false,
    squareError: null,
    ...extra,
  })
  let oldVariation: string | undefined
  let newVariation: string | undefined
  try {
    const first = planCatalogChanges([tier], [row('compact', 100), row('truck', 200)])
    if (first.map((a) => a.kind).join(',') !== 'create_plan,create_variation,create_variation') throw new Error(`the planner gave ${first.map((a) => a.kind).join(',')}`)
    const done = await executeCatalogActions(api, first)
    const bad = done.filter((x) => !x.ok)
    if (bad.length) throw new Error(`the executor failed: ${bad.map((x) => x.error).join('; ')}`)
    const planId = done.find((x) => x.action.kind === 'create_plan')!.squareId!
    const varIds = done.filter((x) => x.action.kind === 'create_variation').map((x) => x.squareId!)
    cleanup.push({ what: `membership catalog ${planId}`, run: () => Promise.all([...varIds, planId].map((id) => api.catalog.delete(id).catch(() => [] as string[]))) })
    const checks: string[] = []
    for (const [i, id] of varIds.entries()) {
      const v = await api.catalog.retrieve(id)
      const phases = v.subscription_plan_variation_data?.phases ?? []
      const price = phases[0]?.pricing?.price_money?.amount
      if (v.type !== 'SUBSCRIPTION_PLAN_VARIATION' || phases.length !== 1 || phases[0]!.cadence !== 'MONTHLY' || phases[0]!.pricing?.type !== 'STATIC' || price !== [100, 200][i])
        throw new Error(`variation ${i + 1}: ${JSON.stringify({ type: v.type, phases })}`)
      if (v.subscription_plan_variation_data?.subscription_plan_id !== planId) throw new Error(`variation ${i + 1} names another plan`)
      checks.push(`${v.subscription_plan_variation_data?.name} ${price}`)
    }
    // the same actions again (a run that stopped after Square answered): the same objects
    const again = await executeCatalogActions(api, first)
    if (again.find((x) => x.action.kind === 'create_plan')?.squareId !== planId || again.filter((x) => x.action.kind === 'create_variation').map((x) => x.squareId).join() !== varIds.join())
      throw new Error('the same keys answered other objects')
    // a price edit: the old row superseded (a subscription will use it), a new row; one new variation, the old one untouched
    oldVariation = varIds[0]
    const edit = planCatalogChanges(
      [{ ...tier, squarePlanId: planId }],
      [row('compact', 100, { current: false, squareVariationId: oldVariation, squareState: 'synced', inUse: true }), row('compact-2', 150)],
    )
    if (edit.map((a) => a.kind).join() !== 'create_variation') throw new Error(`a price edit planned ${edit.map((a) => a.kind).join()}`)
    const made = await executeCatalogActions(api, edit)
    newVariation = made[0]?.squareId
    if (!made[0]?.ok || !newVariation || newVariation === oldVariation) throw new Error(`the new price: ${made[0]?.error ?? 'no variation'}`)
    varIds.push(newVariation)
    const old = await api.catalog.retrieve(varIds[0]!)
    if (old.subscription_plan_variation_data?.phases?.[0]?.pricing?.price_money?.amount !== 100) throw new Error('the old variation changed')
    report.pass('SQR-13', `plan + ${checks.join(', ')}; the same keys answered the same objects; a price edit made a new variation (150), the old one kept its price`)
  } catch (e) {
    report.fail('SQR-13', errText(e), fixFor(e))
  }
  if (!oldVariation || !newVariation) {
    report.skip('SQR-14', 'needs the variations of SQR-13')
    return
  }
  // ---- SQR-14 the subscription ------------------------------------------------------------------------------------------------------
  const notes: string[] = []
  const problems: string[] = []
  try {
    // a customer and card of its own (SQR-07/08 leave theirs with a pending cancel and an unpaid invoice), as an enrollment makes them
    const member = await api.customers.create(sqKey('cu', `${run}:member`), {
      given_name: 'Verify',
      family_name: 'Member',
      email_address: `${o.ref}-member@oasisautospanj.com`,
      reference_id: `${o.ref}-member`,
      note: 'Created by pnpm verify:square; safe to delete',
    })
    cleanup.push({ what: `customer ${member.id}`, run: () => api.customers.delete(member.id) })
    const memberCard = await api.cards.create(sqKey('cd', `${run}:member`), { source_id: NONCE_OK, card: { customer_id: member.id, reference_id: `${o.ref}-member` } })
    cleanup.push({ what: `card ${memberCard.id}`, run: () => api.cards.disable(memberCard.id) })
    const email = member.email_address ?? ''
    const ok = deliverableEmail(email)
    findings.membershipEmail = ok.ok ? `the customer's email passes our check (domain ${email.slice(email.indexOf('@') + 1)})` : `refused: ${ok.message}`
    if (!ok.ok) problems.push(findings.membershipEmail)
    for (const reserved of ['someone@example.com', 'someone@shop.test']) if (deliverableEmail(reserved).ok) problems.push(`${reserved} passed our check`)
    const today = shopDate(o.ctx.now(), tz)
    const enrollment = randomUUID()
    const sub = await createMembershipSubscription(
      api,
      enrollment,
      subscriptionInput({ squareLocationId: locationId, variationId: oldVariation, squareCustomerId: member.id, squareCardId: memberCard.id, startDate: today, tz }),
    )
    cleanup.push({ what: `membership subscription ${sub.id}`, run: () => api.subscriptions.cancel(sub.id) })
    const again = await createMembershipSubscription(
      api,
      enrollment,
      subscriptionInput({ squareLocationId: locationId, variationId: oldVariation, squareCustomerId: member.id, squareCardId: memberCard.id, startDate: today, tz }),
    )
    if (again.id !== sub.id) problems.push('the same sb_ key made a second subscription')
    const paid = await poll(
      async () => {
        const s = await api.subscriptions.retrieve(sub.id)
        const inv = s.invoice_ids?.[0] ? await api.invoices.get(s.invoice_ids[0]) : undefined
        return { s, inv }
      },
      (v) => v.inv?.status === 'PAID' || ['DEACTIVATED', 'CANCELED'].includes(v.s.status),
    )
    findings.membershipFirstInvoice = `subscription ${sub.status} -> ${paid.value.s.status}; first invoice ${paid.value.inv?.status ?? 'none'} after ${paid.ms} ms`
    notes.push(findings.membershipFirstInvoice)
    if (paid.value.inv?.status !== 'PAID') problems.push(`the first invoice was not paid: ${findings.membershipFirstInvoice}`)
    else {
      const s = await api.subscriptions.retrieve(sub.id)
      const period = paidPeriod({ dueDate: paid.value.inv.payment_requests?.[0]?.due_date ?? null, startDate: s.start_date ?? null, chargedThrough: s.charged_through_date ?? null }, tz)
      findings.membershipPeriod = `due ${paid.value.inv.payment_requests?.[0]?.due_date}, charged through ${s.charged_through_date}: ${period.start.toISOString()} -> ${period.end.toISOString()}`
      notes.push(findings.membershipPeriod)
      if (shopDate(period.start, tz) !== today || !s.charged_through_date || shopDate(period.end, tz) !== s.charged_through_date) problems.push(`the period: ${findings.membershipPeriod}`)
      const next = s.charged_through_date
      // Square answers 500 "Subscription ... is locked and is not billable. Please retry" for a while after an invoice was paid
      // (sandbox 2026-10-12): the actions are tried again, 5 s apart, for up to 2 minutes, and how long it took is a finding
      const t0 = o.ctx.now().getTime()
      let lockedTries = 0
      const unlocked = async <T>(fn: () => Promise<T>): Promise<T> => {
        for (;;) {
          try {
            return await fn()
          } catch (e) {
            if (!busyAtSquare(e) || o.ctx.now().getTime() - t0 > 120_000) throw e
            lockedTries++
            await o.ctx.sleep(5000)
          }
        }
      }
      // swap at the next billing date, replaced, then undone
      const swap = await unlocked(() => replaceSwap(api, sub.id, newVariation!))
      if (lockedTries) notes.push(`Square was busy with the subscription: ${lockedTries} retr${lockedTries === 1 ? 'y' : 'ies'}`)
      const swapped = scheduledAtSquare(await api.subscriptions.retrieve(sub.id, { includeActions: true }))
      findings.membershipSwap = `SWAP_PLAN effective ${swap.action?.effective_date ?? '?'} (next billing ${next}); seen as ${JSON.stringify(swapped.swap)}`
      if (swap.action?.effective_date !== next || swapped.swap?.variationId !== newVariation) problems.push(`swap: ${findings.membershipSwap}`)
      await replaceSwap(api, sub.id, newVariation!) // the same swap again: kept as it is, still one
      const one = await api.subscriptions.retrieve(sub.id, { includeActions: true })
      if ((one.actions ?? []).filter((a) => a.type === 'SWAP_PLAN').length !== 1) problems.push('a second swap left two scheduled swaps')
      for (const a of one.actions ?? []) if (a.type === 'SWAP_PLAN') await unlocked(() => api.subscriptions.deleteAction(sub.id, a.id))
      notes.push(findings.membershipSwap)
      // NOT sent here: the same SwapPlan after its undo answered 500 "locked and is not billable" and left the subscription refusing
      // every later DeleteSubscriptionAction (409 Unable to lock) in the sandbox on 2026-10-12; Oasis never sends it (actions.ts)
      // pause at the next billing date, undone
      const pause = await unlocked(() => api.subscriptions.pause(sub.id, {}))
      const paused = scheduledAtSquare(await api.subscriptions.retrieve(sub.id, { includeActions: true }))
      findings.membershipPause = `PAUSE effective ${pause.actions.find((a) => a.type === 'PAUSE')?.effective_date ?? '?'}; status ${pause.subscription.status}; seen as pauseAt ${paused.pauseAt}`
      if (paused.pauseAt !== next) problems.push(`pause: ${findings.membershipPause}`)
      const withPause = await api.subscriptions.retrieve(sub.id, { includeActions: true })
      for (const a of withPause.actions ?? []) if (a.type === 'PAUSE' || a.type === 'RESUME') await unlocked(() => api.subscriptions.deleteAction(sub.id, a.id))
      notes.push(findings.membershipPause)
      // cancel at the period end, undone, canceled again (cleanup)
      const cancel = await unlocked(() => api.subscriptions.cancel(sub.id))
      const canceled = scheduledAtSquare(await api.subscriptions.retrieve(sub.id, { includeActions: true }))
      findings.membershipCancel = `canceled_date ${cancel?.subscription.canceled_date ?? '?'}, status ${cancel?.subscription.status ?? '?'}; seen as cancelAt ${canceled.cancelAt}`
      if (canceled.cancelAt !== next) problems.push(`cancel: ${findings.membershipCancel}`)
      const withCancel = await api.subscriptions.retrieve(sub.id, { includeActions: true })
      const c = (withCancel.actions ?? []).find((a) => a.type === 'CANCEL')
      if (c) await unlocked(() => api.subscriptions.deleteAction(sub.id, c.id))
      const undone = scheduledAtSquare(await api.subscriptions.retrieve(sub.id, { includeActions: true }))
      if (undone.cancelAt) problems.push(`the cancel could not be undone (cancelAt ${undone.cancelAt})`)
      notes.push(`${findings.membershipCancel}; undone: cancelAt ${undone.cancelAt}`)
    }
    // CancelInvoice: an unpaid invoice of a subscription without a card (the day-21 cleanup)
    const subB = await createMembershipSubscription(
      api,
      randomUUID(),
      subscriptionInput({ squareLocationId: locationId, variationId: newVariation, squareCustomerId: member.id, squareCardId: null, startDate: today, tz }),
    )
    cleanup.push({ what: `membership subscription ${subB.id}`, run: () => api.subscriptions.cancel(subB.id) })
    const unpaid = await poll(
      async () => {
        const s = await api.subscriptions.retrieve(subB.id)
        return s.invoice_ids?.[0] ? await api.invoices.get(s.invoice_ids[0]) : undefined
      },
      (i) => !!i && i.status !== 'DRAFT',
      60_000,
    )
    if (!unpaid.value) findings.membershipInvoiceCancel = 'no invoice appeared for a subscription without a card'
    else {
      try {
        const canceledInv = await api.invoices.cancel(unpaid.value.id, unpaid.value.version ?? 0)
        let repeat: string
        try {
          repeat = `accepted (${(await api.invoices.cancel(unpaid.value.id, canceledInv.version ?? 0)).status})`
        } catch (e) {
          repeat = `refused: ${codeOf(e)} (callers read the invoice first and cancel only an open one)`
        }
        findings.membershipInvoiceCancel = `invoice ${unpaid.value.status} -> CancelInvoice -> ${canceledInv.status}; a repeat: ${repeat}`
        if (canceledInv.status !== 'CANCELED') problems.push(`CancelInvoice: ${findings.membershipInvoiceCancel}`)
      } catch (e) {
        findings.membershipInvoiceCancel = `CancelInvoice refused: ${codeOf(e)}`
        problems.push(findings.membershipInvoiceCancel)
      }
    }
    notes.push(findings.membershipInvoiceCancel ?? '')
  } catch (e) {
    problems.push(errText(e))
  }
  if (problems.length) report.fail('SQR-14', problems.join('; '), undefined, notes)
  else report.pass('SQR-14', notes.join(' | '))
}

function codeOf(e: unknown): string {
  if (e instanceof SquareApiError) return `${e.status} ${e.errors.map((x) => `${x.category ?? ''}/${x.code ?? ''}`).join(',')}`
  return errText(e)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function fixFor(e: unknown): string | undefined {
  if (e instanceof SquareApiError && e.status === 401) return 'the token is wrong or revoked: check the secret'
  return undefined
}

// ---- capture -----------------------------------------------------------------------------------------------------------------------

const ID_KEY = /(^id$|_id$|^uid$|^event_id$|version_token|fingerprint|^bin$|receipt_number|^invoice_number$|^reference_id$|^order_ids?$)/
const URL_KEY = /(url$|^url$)/

/** Replaces every id (and every occurrence of it anywhere), emails, and the path of every URL; keeps shapes, states and amounts. */
export function scrubCapture(items: unknown[]): unknown[] {
  const ids = new Map<string, string>()
  const idFor = (v: string): string => {
    let x = ids.get(v)
    if (!x) {
      x = `ID${String(ids.size + 1).padStart(4, '0')}`
      ids.set(v, x)
    }
    return x
  }
  const collect = (v: unknown, key = ''): void => {
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string' && /_ids$/.test(key)) idFor(x)
        else collect(x, key)
      }
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) collect(x, k)
    else if (typeof v === 'string' && ID_KEY.test(key) && v.length >= 4) idFor(v)
  }
  for (const it of items) collect(it)
  const sorted = [...ids.keys()].sort((a, b) => b.length - a.length)
  const rewrite = (v: unknown, key = ''): unknown => {
    if (Array.isArray(v)) return v.map((x) => rewrite(x, key))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x, k)]))
    if (typeof v !== 'string') return v
    if (/email/.test(key) && v.includes('@')) return 'verify@example.com'
    if (/phone/.test(key)) return '+15555550100'
    if (URL_KEY.test(key) && /^https?:\/\//.test(v)) {
      const u = new URL(v)
      return `${u.protocol}//${u.host}/scrubbed`
    }
    let out = v
    for (const s of sorted) if (out.includes(s)) out = out.split(s).join(ids.get(s)!)
    return out
      .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'verify@example.com')
      .replace(/(sandbox-)?sq0id[a-z]-[\w-]+/g, 'APPLICATION_ID')
  }
  return items.map((x) => rewrite(x))
}

function writeCapture(dir: string | undefined, captured: Captured[], ctx: RunContext): void {
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  const scrubbed = scrubCapture(captured) as Captured[]
  scrubbed.forEach((c, i) => {
    const name = `${String(i + 1).padStart(3, '0')}-${c.method}-${c.path.replace(/^\/v2\//, '').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60)}-${c.status}.json`
    writeFileSync(path.join(dir, name), `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 })
  })
  ctx.log(`capture: ${scrubbed.length} scrubbed answer(s) in ${dir}`)
}

export const HELP = `pnpm verify:square [options]

Runs the Square checklist of docs/integrations/square.md section 7 against the SANDBOX (or --sim) and writes
docs/live-verification/<date>-square.md and .json. It creates a customer, a card, a $1 payment and refund, a payment link, a plan
with two variations and two subscriptions, all with a verify- reference, and cleans up what Square allows (--keep leaves it).
Exit code 0 = no FAIL, 1 = at least one FAIL, 2 = configuration missing or bad command line.

  --secret ID           read SQUARE_ACCESS_TOKEN / SQUARE_ENVIRONMENT / SQUARE_APPLICATION_ID from that Secrets Manager secret
                        (AWS_PROFILE / AWS_REGION as usual). Otherwise from the environment.
  --location ID         the Square location (default SQUARE_LOCATION_ID, else the first active location)
  --sim                 run against the built-in simulator over a loopback socket
  --read-only           only the reads (the only mode a production token may use)
  --keep                leave what the run created
  --tax-only            only SQR-01 and SQR-18 (Square's tax rounding against Oasis's, ADR 0173) and the cleanup
  --items-only          only SQR-01, the item library checks SQR-15, 16, 17, 19 and 20 (ADR 0172) and the cleanup
  --rate PERCENT        Oasis's tax rate SQR-20 compares the shop's taxes with (default 6.625)
  --wait SECONDS        how long to wait for a refund, an invoice or an event (default 120)
  --capture DIR         save scrubbed copies of every answer (ids replaced, no emails, URL paths dropped)
  --webhook-url URL     also send TestWebhookSubscription to the subscription for that URL
  --out-dir DIR         where reports go (default docs/live-verification)
  --json                also print the JSON summary
`

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  log: (l: string) => void = console.log,
): Promise<number> {
  return cli('verify:square', HELP, argv, runSquare, SQUARE_OPTIONS, env, log)
}

if (process.argv[1] && process.argv[1].endsWith(path.join('verify-live', 'square.ts'))) {
  applySecretEnvironment().then(
    () => main(process.argv.slice(2)).then((c) => process.exit(c)),
    (e: unknown) => {
      console.error((e as Error).message)
      process.exit(2)
    },
  )
}
