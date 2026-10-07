// pnpm verify:squarespace  -  walks the first-live-run checklist of docs/integrations/squarespace.md (section 7) against the
// real Commerce APIs with a READ-ONLY key, discovers the subscription products and PROPOSES the product map (never writes it),
// and reports whether orders carry the email and phone the matcher needs.
//
// Everything is GET. The one request that is not is --post-webhook <url>, an explicit opt-in that posts a signed notification of an
// ignored topic to your own endpoint to prove the signature path.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { SqspOrder, SqspTransaction } from '../../src/integrations/ports/squarespace.js'
import { SquarespaceClient, DEFAULT_USER_AGENT } from '../../src/integrations/squarespace/client.js'
import {
  SquarespaceApiError,
  SquarespaceAuthError,
  SquarespacePermissionError,
} from '../../src/integrations/squarespace/errors.js'
import { systemSleeper } from '../../src/integrations/squarespace/sleeper.js'
import {
  InMemoryNotificationDedupe,
  buildSignedNotification,
  receiveWebhook,
} from '../../src/integrations/squarespace/webhook.js'
import { SquarespaceSimApi } from '../../src/integrations/squarespace/sim/api.js'
import { close, createSimHttpServer, listen } from '../../src/integrations/squarespace/sim/http.js'
import { SquarespaceSimStore } from '../../src/integrations/squarespace/sim/store.js'
import {
  ProductMap,
  normalizeTier,
  type ProductMapEntry,
} from '../../src/modules/payments-sync/product-map.js'
import { ProductMapBody } from '../../src/modules/payments-sync/http/schemas.js'
import { systemClock } from '../../src/platform/clock.js'
import {
  MissingConfig,
  Report,
  UsageError,
  cli,
  isoDate,
  type ItemDef,
  type RunContext,
  type RunResult,
} from './lib.js'
import { seedSquarespaceSim } from './sim-data.js'

const DOC = 'docs/integrations/squarespace.md section 7 (First live run)'

export const SQUARESPACE_ITEMS: readonly ItemDef[] = [
  {
    id: 'SQ-01',
    title: 'The key works and the orders list has the documented shape (200)',
    source: `${DOC}, step 1`,
  },
  {
    id: 'SQ-02',
    title:
      'modifiedAfter alone and cursor plus dates are rejected (400); order direction and bound inclusivity noted',
    source: `${DOC}, step 2`,
  },
  {
    id: 'SQ-03',
    title:
      'Paging with cursor only keeps the payment-state filter (a PARTIALLY_PAID or PENDING order stays visible)',
    source: `${DOC}, step 3`,
  },
  {
    id: 'SQ-04',
    title:
      'Transactions: shape, creditCardType, no last4 or wallet, externalTransactionProperties, where refunds sit',
    source: `${DOC}, step 4`,
  },
  {
    id: 'SQ-05',
    title: 'Subscription products found; product map proposed (tier suggestions), not written',
    source: `${DOC}, step 5`,
  },
  {
    id: 'SQ-06',
    title: 'How the collection flows staff use appear (channel, payment state, email and phone present)',
    source: `${DOC}, step 6`,
  },
  {
    id: 'SQ-07',
    title: 'Requests per sync cycle stay small (expected under 10); rate-limit behaviour is not provoked',
    source: `${DOC}, step 7`,
  },
  {
    id: 'SQ-08',
    title: 'One poll cycle against an empty store, then the matcher in report-only mode',
    source: `${DOC}, step 8`,
  },
  {
    id: 'SQ-09',
    title: 'Real payloads captured (emails redacted) for the fixtures',
    source: `${DOC}, step 9`,
  },
  {
    id: 'SQ-10',
    title: 'Webhook signature path (optional: only with SQSP_WEBHOOK_SECRET)',
    source: `${DOC}, step 10`,
  },
  {
    id: 'SQ-C1',
    title: 'Contacts are readable and carry email and phone',
    source: 'docs/integrations/squarespace.md section 1 (Contacts)',
  },
  {
    id: 'SQ-M1',
    title: 'Orders carry a customer email or phone, which the matcher needs',
    source: 'docs/integrations/squarespace.md section 4 (Matching)',
  },
  {
    id: 'SQ-P1',
    title: 'Pagination is cursor based, pages hold at most 50 orders, and any rate-limit headers are noted',
    source: 'docs/integrations/squarespace.md section 1 (Transport)',
  },
]

export const SQUARESPACE_OPTIONS = {
  flags: [] as string[],
  options: ['days', 'max-pages', 'capture', 'post-webhook', 'sim-port', 'sim-page-size'],
} as const

interface RawCall {
  path: string
  status: number
  headers: Record<string, string>
  json?: unknown
}

const RATE_HEADER = /^(x-)?(ratelimit|rate-limit|retry-after)/i

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${Math.round((n / d) * 100)}%`)

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1]! + s[m]!) / 2
}

export interface ProductFinding {
  key: string
  productId?: string
  sku?: string
  name: string
  lineItemType?: string
  unitCents: number
  orders: number
  customers: number
  repeatCustomers: number
  medianDaysBetween?: number
  tier?: string
}

/** Groups line items by product and measures how often the same person buys it again. Test-mode orders are ignored. */
export function discoverProducts(orders: SqspOrder[]): ProductFinding[] {
  const by = new Map<string, { f: ProductFinding; byCustomer: Map<string, number[]> }>()
  for (const o of orders) {
    if (o.testMode) continue
    const who = o.customerId ?? o.customerEmail?.toLowerCase() ?? o.customerPhone ?? `order:${o.id}`
    for (const li of o.lineItems) {
      const key = li.productId ?? li.sku ?? li.name
      let e = by.get(key)
      if (!e) {
        e = {
          f: {
            key,
            productId: li.productId,
            sku: li.sku,
            name: li.name,
            lineItemType: li.lineItemType,
            unitCents: li.unitCents,
            orders: 0,
            customers: 0,
            repeatCustomers: 0,
            tier: normalizeTier(li.name) ?? normalizeTier(li.sku),
          },
          byCustomer: new Map(),
        }
        by.set(key, e)
      }
      e.f.orders++
      const times = e.byCustomer.get(who) ?? []
      times.push(o.createdOn.getTime())
      e.byCustomer.set(who, times)
    }
  }
  const out: ProductFinding[] = []
  for (const { f, byCustomer } of by.values()) {
    f.customers = byCustomer.size
    const gaps: number[] = []
    for (const times of byCustomer.values()) {
      if (times.length < 2) continue
      f.repeatCustomers++
      const sorted = [...times].sort((a, b) => a - b)
      for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i]! - sorted[i - 1]!) / 86_400_000)
    }
    const m = median(gaps)
    if (m !== undefined) f.medianDaysBetween = Math.round(m * 10) / 10
    out.push(f)
  }
  return out.sort((a, b) => b.orders - a.orders)
}

const intervalFor = (days: number | undefined): number =>
  days === undefined ? 1 : days <= 45 ? 1 : days <= 100 ? 3 : days <= 200 ? 6 : 12

/** The rows PUT /api/v1/integrations/squarespace/product-map takes (the primary way to hold the map), from the SQSP_PRODUCT_MAP-style entries. */
export function toApiEntries(entries: ProductMapEntry[]): Array<Record<string, unknown>> {
  return entries.map((e) => ({
    ...(e.productId ? { productId: e.productId } : {}),
    ...(e.sku ? { sku: e.sku } : {}),
    ...(e.label ? { name: e.label.slice(0, 200) } : {}),
    kind: e.kind,
    ...(e.kind === 'membership'
      ? {
          plan: e.tier,
          planLabel: (e.tierLabel ?? e.label ?? e.tier ?? '').slice(0, 40),
          intervalMonths: e.intervalMonths ?? 1,
        }
      : {}),
  }))
}

export function proposeProductMap(findings: ProductFinding[]): {
  entries: ProductMapEntry[]
  notes: string[]
} {
  const entries: ProductMapEntry[] = []
  const notes: string[] = []
  for (const f of findings) {
    const recurring =
      f.medianDaysBetween !== undefined &&
      ((f.medianDaysBetween >= 20 && f.medianDaysBetween <= 45) ||
        (f.medianDaysBetween >= 80 && f.medianDaysBetween <= 100) ||
        (f.medianDaysBetween >= 340 && f.medianDaysBetween <= 400))
    const named =
      f.tier !== undefined || /subscription|recurring|member/i.test(`${f.lineItemType ?? ''} ${f.name}`)
    if (!f.productId && !f.sku) continue
    const memberish =
      /member|subscription|recurring|monthly|\bplan\b|club/i.test(`${f.name} ${f.lineItemType ?? ''}`) ||
      /^mem/i.test(f.sku ?? '')
    if (f.tier && (recurring || memberish)) {
      const entry: ProductMapEntry = {
        ...(f.productId ? { productId: f.productId } : {}),
        ...(f.sku ? { sku: f.sku } : {}),
        kind: 'membership',
        tierLabel: f.name,
        tier: f.tier as ProductMapEntry['tier'],
        intervalMonths: intervalFor(f.medianDaysBetween),
        label: f.name,
      }
      entries.push(entry)
      notes.push(
        `${f.name}: membership tier ${f.tier}, every ${entry.intervalMonths} month(s)${recurring ? ` (same customers re-buy every ~${f.medianDaysBetween} days)` : ' (UNCONFIRMED: no renewal seen in this window)'}`,
      )
    } else if (named && !f.tier) {
      notes.push(
        `${f.name}: looks like a membership but names no tier (essential, premium, executive, exotic); map it by hand`,
      )
    } else {
      entries.push({
        ...(f.productId ? { productId: f.productId } : {}),
        ...(f.sku ? { sku: f.sku } : {}),
        kind: 'service',
        label: f.name,
      })
    }
  }
  // The proposal must be something SQSP_PRODUCT_MAP / PUT /product-map would accept.
  const valid: ProductMapEntry[] = []
  for (const e of entries) {
    try {
      new ProductMap([e])
      valid.push(e)
    } catch (err) {
      notes.push(`dropped an entry the parser refuses: ${(err as Error).message.slice(0, 120)}`)
    }
  }
  return { entries: valid, notes }
}

function anonymise(value: unknown, emails: Map<string, string>, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => anonymise(v, emails, key))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, anonymise(v, emails, k)]))
  if (typeof value !== 'string') return value
  if (/email/i.test(key) || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
    if (!emails.has(value)) emails.set(value, `customer${emails.size + 1}@example.invalid`)
    return emails.get(value)
  }
  if (/phone/i.test(key)) return '555-0100'
  if (/^(first|last)Name$/.test(key) || key === 'name') return 'REDACTED'
  if (/^(address1|address2|addressLine|city|postalCode|zip|street)/i.test(key)) return 'REDACTED'
  return value
}

export async function runSquarespace(ctx: RunContext): Promise<RunResult> {
  try {
    return await runInner(ctx)
  } catch (e) {
    if (e instanceof MissingConfig) return { missing: e }
    throw e
  }
}

async function runInner(ctx: RunContext): Promise<RunResult> {
  const { args, env } = ctx
  const sim = args.flag('sim')
  const days = args.number('days') ?? 30
  const maxPages = args.number('max-pages') ?? 10
  if (days < 1 || days > 365) throw new UsageError('--days must be between 1 and 365')
  const captureDir = args.value('capture')
  const postWebhook = args.value('post-webhook')

  let simClose: (() => Promise<void>) | undefined
  let baseUrl: string
  let apiKey: string
  let simApi: SquarespaceSimApi | undefined
  if (sim) {
    // One hour back and a millisecond apart per read, so no two rows share a modifiedOn and keyset paging is exact.
    let tick = 0
    const seedClock = { now: () => new Date(systemClock.now().getTime() - 3_600_000 + tick++) }
    const store = new SquarespaceSimStore(seedClock, {
      pageSize: args.number('sim-page-size') ?? 2,
      order: 'asc',
      currency: 'USD',
    })
    seedSquarespaceSim(store, seedClock)
    simApi = new SquarespaceSimApi(store, systemClock, { apiKeys: ['sim-api-key'] })
    const server = createSimHttpServer(simApi)
    baseUrl = await listen(server, args.number('sim-port') ?? 4590)
    simClose = () => close(server)
    apiKey = 'sim-api-key'
  } else {
    const key = env.SQSP_API_KEY?.trim()
    if (!key)
      throw new MissingConfig(
        'squarespace',
        [
          {
            name: 'SQSP_API_KEY',
            why: 'a Squarespace Commerce API key with Orders, Transactions and Contacts set to Read Only (Settings, Advanced, Developer API Keys; needs Commerce Advanced)',
          },
        ],
        [
          'Put it in the shell for this run (export SQSP_API_KEY=...) or run against the simulator with --sim.',
          'Account steps: docs/live-verification.md, "Squarespace".',
        ],
      )
    apiKey = key
    baseUrl = (env.SQSP_API_BASE ?? 'https://api.squarespace.com').replace(/\/+$/, '')
  }
  const userAgent = env.SQSP_USER_AGENT?.trim() || DEFAULT_USER_AGENT

  const report = new Report(
    'squarespace',
    'Squarespace live verification',
    SQUARESPACE_ITEMS,
    { mode: sim ? 'sim' : 'live', target: baseUrl },
    ctx.now,
    ctx.log,
  )
  report.secret(apiKey)
  const r = report
  const calls: RawCall[] = []
  const wrappedFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init)
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      if (
        RATE_HEADER.test(k) ||
        k === 'link' ||
        k === 'content-type' ||
        k === 'x-request-id' ||
        k === 'x-sqsp-request-id'
      )
        headers[k] = v
    })
    let json: unknown
    try {
      json = await res.clone().json()
    } catch {
      json = undefined
    }
    calls.push({ path: url.pathname + url.search, status: res.status, headers, json })
    return res
  }
  const client = new SquarespaceClient({
    auth: { kind: 'api_key', apiKey },
    clock: systemClock,
    sleeper: systemSleeper,
    baseUrl,
    userAgent,
    fetch: wrappedFetch,
    maxAttempts: 2,
    max429Retries: 1,
  })
  const raw = (
    path: string,
    query: Record<string, string>,
  ): Promise<{ status: number; json: unknown; headers: Headers }> =>
    fetch(`${baseUrl}${path}?${new URLSearchParams(query).toString()}`, {
      headers: { authorization: `Bearer ${apiKey}`, 'user-agent': userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    }).then(async (res) => ({
      status: res.status,
      json: await res.json().catch(() => undefined),
      headers: res.headers,
    }))

  const now = ctx.now()
  const after = new Date(now.getTime() - days * 86_400_000)
  const orders: SqspOrder[] = []
  const transactions: SqspTransaction[] = []
  let orderPages = 0
  let ordersOk = false
  let firstOrderCursor: string | undefined

  try {
    // ---- SQ-01 orders ---------------------------------------------------------------------------------------------
    try {
      let cursor: string | undefined
      do {
        const page = await client.listOrders({ modifiedAfter: after, modifiedBefore: now, cursor })
        orderPages++
        if (orderPages === 1) firstOrderCursor = page.nextCursor
        orders.push(...page.items)
        if (page.rejected?.length)
          r.note(
            `${page.rejected.length} order(s) could not be mapped: ${page.rejected
              .slice(0, 3)
              .map((x) => x.reason)
              .join(' | ')
              .slice(0, 300)}`,
          )
        cursor = page.nextCursor
      } while (cursor && orderPages < maxPages)
      ordersOk = true
      r.pass(
        'SQ-01',
        `HTTP 200; ${orders.length} order(s) in the last ${days} days over ${orderPages} page(s)${cursor ? ` (stopped at --max-pages ${maxPages})` : ''}`,
      )
    } catch (e) {
      if (e instanceof SquarespaceAuthError)
        r.fail(
          'SQ-01',
          'HTTP 401: the key was rejected',
          'Create a new key in Settings, Advanced, Developer API Keys and set SQSP_API_KEY. Keys are shown once.',
        )
      else if (e instanceof SquarespacePermissionError)
        r.fail(
          'SQ-01',
          `HTTP ${e.status}: ${e.status === 402 ? 'the site that owns the key is expired' : 'the key lacks the Orders permission'}`,
          'Give the key Orders: Read Only, Transactions: Read Only and Contacts: Read Only; the plan must include Commerce Advanced.',
        )
      else r.fail('SQ-01', (e as Error).message.slice(0, 300))
    }

    // ---- SQ-02 parameter rules, direction, inclusivity -------------------------------------------------------------
    if (ordersOk) {
      const notes: string[] = []
      const iso = (d: Date): string => d.toISOString()
      const alone = await raw('/1.0/commerce/orders', { modifiedAfter: iso(after) })
      const mixed = firstOrderCursor
        ? await raw('/1.0/commerce/orders', {
            cursor: firstOrderCursor,
            modifiedAfter: iso(after),
            modifiedBefore: iso(now),
          })
        : undefined
      const sorted = [...orders].sort((a, b) => a.modifiedOn.getTime() - b.modifiedOn.getTime())
      const dir =
        orders.length >= 2
          ? orders[0]!.modifiedOn.getTime() <= orders[orders.length - 1]!.modifiedOn.getTime()
            ? 'oldest first'
            : 'newest first'
          : 'unknown (fewer than 2 orders)'
      notes.push(`order direction: ${dir}`)
      let inclusive = 'unknown'
      const probe = sorted[Math.floor(sorted.length / 2)]
      if (probe) {
        const t = probe.modifiedOn.getTime()
        const lo = await raw('/1.0/commerce/orders', {
          modifiedAfter: iso(new Date(t)),
          modifiedBefore: iso(new Date(t + 1000)),
        })
        const hi = await raw('/1.0/commerce/orders', {
          modifiedAfter: iso(new Date(t - 1000)),
          modifiedBefore: iso(new Date(t)),
        })
        const has = (x: { json: unknown }): boolean =>
          ((x.json as { result?: Array<{ id: string }> } | undefined)?.result ?? []).some(
            (o) => o.id === probe.id,
          )
        inclusive = `modifiedAfter ${has(lo) ? 'inclusive' : 'exclusive'}, modifiedBefore ${has(hi) ? 'inclusive' : 'exclusive'}`
        notes.push(`bounds: ${inclusive}`)
      }
      notes.push(`modifiedAfter alone: HTTP ${alone.status}`)
      if (mixed) notes.push(`cursor with dates: HTTP ${mixed.status}`)
      const aloneOk = alone.status === 400
      const mixedOk = !mixed || mixed.status === 400
      const detail = notes.join('; ')
      if (aloneOk && mixedOk)
        r.pass('SQ-02', detail + (mixed ? '' : '; cursor-with-dates untested (the window fits one page)'))
      else
        r.fail(
          'SQ-02',
          detail,
          'The client assumes the dates come as a pair and a cursor travels alone (client.listOrders). Adjust it to the observed rules before enabling polling.',
        )
    } else {
      r.skip('SQ-02', 'orders could not be read')
    }

    // ---- SQ-03 cursor keeps the payment-state filter ----------------------------------------------------------------
    if (ordersOk) {
      const rare = 'PARTIALLY_PAID,PENDING,FAILED,REFUND_PENDING,REFUND_FAILED'
      const first = await raw('/1.0/commerce/orders', {
        modifiedAfter: after.toISOString(),
        modifiedBefore: now.toISOString(),
        paymentStates: rare,
      })
      const body = first.json as
        | {
            result?: Array<{ paymentState?: string }>
            pagination?: { nextPageCursor?: string; hasNextPage?: boolean }
          }
        | undefined
      const cursor = body?.pagination?.hasNextPage ? body.pagination.nextPageCursor : undefined
      if (first.status !== 200) r.skip('SQ-03', `the paymentStates probe answered HTTP ${first.status}`)
      else if (!body?.result?.length)
        r.skip(
          'SQ-03',
          `no PARTIALLY_PAID, PENDING, FAILED or refund-in-flight orders in the last ${days} days to follow (widen with --days)`,
        )
      else if (!cursor)
        r.skip(
          'SQ-03',
          `${body.result.length} such order(s) fit on one page, so no cursor to follow; the filter is only proven on page 1`,
        )
      else {
        const next = await raw('/1.0/commerce/orders', { cursor })
        const states = (
          (next.json as { result?: Array<{ paymentState?: string }> } | undefined)?.result ?? []
        ).map((o) => o.paymentState ?? '?')
        const hidden =
          states.length > 0 &&
          states.every((s) => ['NOT_CHARGED', 'AUTHORIZED', 'PAID', 'REFUNDED'].includes(s))
        if (next.status === 200 && !hidden)
          r.pass('SQ-03', `the cursor page still returns ${[...new Set(states)].join(', ') || 'rare states'}`)
        else
          r.fail(
            'SQ-03',
            next.status === 200
              ? 'the cursor page lost the paymentStates filter (only the default four states came back)'
              : `the cursor page answered HTTP ${next.status}`,
            'Re-send paymentStates with the cursor if the API allows, or accept that payment-plan orders are only seen on page 1 and shorten the window.',
          )
      }
    } else {
      r.skip('SQ-03', 'orders could not be read')
    }

    // ---- SQ-04 transactions ----------------------------------------------------------------------------------------
    const txStart = calls.length
    try {
      let cursor: string | undefined
      let pages = 0
      do {
        const page = await client.listTransactions({ modifiedAfter: after, modifiedBefore: now, cursor })
        pages++
        transactions.push(...page.items)
        cursor = page.nextCursor
      } while (cursor && pages < maxPages)
      const docs = calls
        .slice(txStart)
        .flatMap(
          (c) => (c.json as { documents?: Array<Record<string, unknown>> } | undefined)?.documents ?? [],
        )
      const payments = docs.flatMap((d) => (d.payments as Array<Record<string, unknown>> | undefined) ?? [])
      const brands = [...new Set(payments.map((p) => String(p.creditCardType ?? 'null')))]
      const propKeys = [
        ...new Set(
          payments.flatMap((p) =>
            ((p.externalTransactionProperties as Array<{ key?: string }> | undefined) ?? []).map((x) =>
              String(x.key ?? '?'),
            ),
          ),
        ),
      ]
      const hasLast4 = JSON.stringify(docs).match(/"last4|"lastFour|"cardLast|"wallet|"applePay/i) !== null
      const nestedRefunds = payments.filter(
        (p) => Array.isArray(p.refunds) && (p.refunds as unknown[]).length > 0,
      ).length
      const docRefunds = docs.filter(
        (d) => Array.isArray(d.refunds) && (d.refunds as unknown[]).length > 0,
      ).length
      const providers = [...new Set(transactions.map((t) => t.provider ?? 'null'))]
      const detail = `${docs.length} document(s), ${payments.length} payment(s); brands ${brands.join('/') || 'none'}; providers ${providers.join('/') || 'none'}; externalTransactionProperties keys ${propKeys.join(',') || 'none'}; refunds nested ${nestedRefunds}, document-level ${docRefunds}; last4/wallet fields ${hasLast4 ? 'PRESENT' : 'absent'}`
      if (docs.length === 0)
        r.skip('SQ-04', `no transactions in the last ${days} days to inspect (widen with --days)`)
      else if (hasLast4)
        r.fail(
          'SQ-04',
          detail,
          'The documentation says last4 and wallet are not exposed; if they are, the card hint can use them (src/modules/payments-sync) and docs/integrations/squarespace.md should change.',
        )
      else r.pass('SQ-04', detail)
    } catch (e) {
      if (e instanceof SquarespacePermissionError || e instanceof SquarespaceAuthError)
        r.fail(
          'SQ-04',
          `HTTP ${(e as SquarespaceApiError).status}: the key cannot read Transactions`,
          'Give the key Transactions: Read Only.',
        )
      else r.fail('SQ-04', (e as Error).message.slice(0, 300))
    }

    // ---- contacts -----------------------------------------------------------------------------------------------------
    try {
      const page = await client.listContacts({})
      const withEmail = page.items.filter((c) => c.email).length
      const withPhone = page.items.filter((c) => c.phone).length
      if (page.items.length === 0) r.skip('SQ-C1', 'the site has no contacts yet')
      else
        r.pass(
          'SQ-C1',
          `first page: ${page.items.length} contact(s), email on ${pct(withEmail, page.items.length)}, phone on ${pct(withPhone, page.items.length)}`,
        )
    } catch (e) {
      if (e instanceof SquarespacePermissionError || e instanceof SquarespaceAuthError)
        r.fail(
          'SQ-C1',
          `HTTP ${(e as SquarespaceApiError).status}: the key cannot read Contacts`,
          'Give the key Contacts: Read Only (API keys can read Contacts since 2026-06-17).',
        )
      else r.fail('SQ-C1', (e as Error).message.slice(0, 300))
    }

    // ---- SQ-05 product discovery ----------------------------------------------------------------------------------
    if (ordersOk) {
      const findings = discoverProducts(orders)
      if (findings.length === 0) {
        r.skip('SQ-05', `no products on the orders of the last ${days} days (widen with --days)`)
      } else {
        const { entries, notes } = proposeProductMap(findings)
        const memberships = entries.filter((e) => e.kind === 'membership')
        const table = findings
          .slice(0, 15)
          .map(
            (f) =>
              `${f.name} | id ${f.productId ?? '-'} | sku ${f.sku ?? '-'} | type ${f.lineItemType ?? '-'} | ${(f.unitCents / 100).toFixed(2)} | ${f.orders} order(s), ${f.customers} customer(s), ${f.repeatCustomers} repeat | median gap ${f.medianDaysBetween ?? '-'} d | tier ${f.tier ?? '-'}`,
          )
        const api = ProductMapBody.parse({ entries: toApiEntries(entries) })
        const proposal = JSON.stringify(api, null, 2)
        const envForm = JSON.stringify(entries)
        const proposalFile = path.join(
          ctx.outDir,
          `${isoDate(r.startedAt)}-squarespace-product-map.proposed.json`,
        )
        if (!args.flag('no-report')) {
          mkdirSync(ctx.outDir, { recursive: true })
          writeFileSync(proposalFile, `${proposal}\n`, { mode: 0o600 })
        }
        r.note(
          `product map PROPOSAL (not written anywhere${args.flag('no-report') ? '' : `; saved to ${proposalFile}`}). Review it, then: deploy/scripts/oasis-admin.sh sqsp-product-map --file <that file>. The same map as an environment value would be SQSP_PRODUCT_MAP='${envForm}'. The body:\n${proposal}`,
        )
        for (const n of notes) r.note(n)
        if (memberships.length > 0)
          r.pass(
            'SQ-05',
            `${findings.length} product(s) seen; ${memberships.length} proposed as membership tiers, ${entries.length - memberships.length} as services`,
            table,
          )
        else
          r.fail(
            'SQ-05',
            `${findings.length} product(s) seen but none looks like a membership tier (names with essential, premium, executive or exotic that renew)`,
            'Check the product names and the window (--days 90): a tier is recognised from the product or SKU name, and a renewal is the same customer buying it again.',
            table,
          )
      }
    } else {
      r.skip('SQ-05', 'orders could not be read')
    }

    // ---- SQ-06 / SQ-M1 collection flows and matcher inputs ------------------------------------------------------
    if (ordersOk && orders.length > 0) {
      const real = orders.filter((o) => !o.testMode)
      const count = (f: (o: SqspOrder) => string): string => {
        const m = new Map<string, number>()
        for (const o of real) m.set(f(o), (m.get(f(o)) ?? 0) + 1)
        return [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')
      }
      const withEmail = real.filter((o) => o.customerEmail).length
      const withPhone = real.filter((o) => o.customerPhone).length
      const withEither = real.filter((o) => o.customerEmail || o.customerPhone).length
      r.pass(
        'SQ-06',
        `channels: ${count((o) => o.channel ?? 'unknown')}; payment states: ${count((o) => o.paymentState ?? 'UNKNOWN')}; ${orders.length - real.length} test-mode order(s) ignored. Make one payment the way staff will (checkout link, invoice, POS) and confirm it shows here with the right channel`,
      )
      const detail = `email on ${pct(withEmail, real.length)}, phone on ${pct(withPhone, real.length)}, at least one on ${pct(withEither, real.length)} of ${real.length} order(s)`
      if (real.length === 0) r.skip('SQ-M1', 'only test-mode orders in the window')
      else if (withEither / real.length < 0.9)
        r.fail(
          'SQ-M1',
          detail,
          'Orders without email or phone can only be matched by hand (manual queue). Make the checkout collect an email, or accept a larger manual queue.',
        )
      else r.pass('SQ-M1', detail)
    } else {
      r.skip(
        'SQ-06',
        ordersOk
          ? `no orders in the last ${days} days to look at (widen with --days)`
          : 'orders could not be read',
      )
      r.skip('SQ-M1', ordersOk ? `no orders in the last ${days} days to look at` : 'orders could not be read')
    }

    // ---- SQ-P1 pagination, headers, SQ-07 request count ----------------------------------------------------------
    {
      const sizes = calls
        .filter((c) => c.path.startsWith('/1.0/commerce/orders'))
        .map((c) => ((c.json as { result?: unknown[] } | undefined)?.result ?? []).length)
      const maxSize = Math.max(0, ...sizes)
      const pag = calls
        .map((c) => (c.json as { pagination?: unknown } | undefined)?.pagination)
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      const badShape = pag.filter(
        (p) =>
          typeof p.hasNextPage !== 'boolean' ||
          (p.hasNextPage === true && typeof p.nextPageCursor !== 'string'),
      )
      const rateHeaders = [
        ...new Set(calls.flatMap((c) => Object.keys(c.headers).filter((h) => RATE_HEADER.test(h)))),
      ]
      const detail = `${pag.length} paginated response(s), largest order page ${maxSize}; rate-limit headers: ${rateHeaders.length ? rateHeaders.join(', ') : 'none sent (the client relies on 429 plus Retry-After)'}`
      if (pag.length === 0) r.skip('SQ-P1', 'no paginated response was read')
      else if (badShape.length > 0)
        r.fail(
          'SQ-P1',
          `${badShape.length} response(s) have a pagination object that is not {hasNextPage, nextPageCursor}`,
          'Update wirePagination (src/integrations/squarespace/wire.ts) to the observed shape.',
        )
      else if (maxSize > 50)
        r.fail(
          'SQ-P1',
          `${detail}; a page held more than 50 orders`,
          'The documented page size is 50; the client does not depend on it, but the request budget (SQSP_MAX_REQUESTS_PER_RUN) was sized with it.',
        )
      else r.pass('SQ-P1', detail)
      const poll = Number(env.SQSP_POLL_INTERVAL_SECONDS ?? 120)
      const overlap = Number(env.SQSP_OVERLAP_SECONDS ?? 300)
      const cycleFrom = new Date(now.getTime() - (poll + overlap) * 1000)
      const cycle = new SquarespaceClient({
        auth: { kind: 'api_key', apiKey },
        clock: systemClock,
        sleeper: systemSleeper,
        baseUrl,
        userAgent,
        maxAttempts: 2,
        max429Retries: 0,
      })
      try {
        for (const list of [cycle.listOrders.bind(cycle), cycle.listTransactions.bind(cycle)]) {
          let cursor: string | undefined
          let pages = 0
          do {
            const page = await list({ modifiedAfter: cycleFrom, modifiedBefore: now, cursor })
            cursor = page.nextCursor
          } while (cursor && ++pages < maxPages)
        }
        const total = cycle.requestCount
        const detail = `${total} request(s) for one poll cycle (orders and transactions modified in the last ${Math.round((poll + overlap) / 60)} min); the app's budget is SQSP_MAX_REQUESTS_PER_RUN and the limit is 300/minute; 429 behaviour is not provoked on purpose`
        if (total < 10) r.pass('SQ-07', detail)
        else
          r.fail(
            'SQ-07',
            detail,
            'A cycle that large eats the 300/minute budget: look at the window (SQSP_OVERLAP_SECONDS) and keep SQSP_REQUESTS_PER_MINUTE below 300.',
          )
      } catch (e) {
        r.fail('SQ-07', `the cycle-sized read failed: ${(e as Error).message.slice(0, 200)}`)
      }
    }
    r.skip(
      'SQ-08',
      'runs inside the app, not here: set the key (PUT /api/v1/integrations/squarespace/connection), POST /sync-now, read GET /orders?state=unmatched, and run reconcile on a quiet site',
    )

    // ---- SQ-09 capture --------------------------------------------------------------------------------------------------
    if (captureDir) {
      const emails = new Map<string, string>()
      mkdirSync(captureDir, { recursive: true })
      const wanted = calls.filter((c) => c.status === 200 && c.json !== undefined)
      const parts: Record<string, unknown[]> = { orders: [], transactions: [], contacts: [] }
      for (const c of wanted) {
        const j = c.json as Record<string, unknown>
        if (c.path.startsWith('/1.0/commerce/orders') && Array.isArray(j.result))
          parts.orders!.push(...j.result)
        else if (c.path.startsWith('/1.0/commerce/transactions') && Array.isArray(j.documents))
          parts.transactions!.push(...j.documents)
        else if (c.path.startsWith('/v1/contacts') && Array.isArray(j.contacts))
          parts.contacts!.push(...j.contacts)
      }
      const written: string[] = []
      for (const [name, rows] of Object.entries(parts)) {
        if (!rows.length) continue
        const file = path.join(captureDir, `${name}.json`)
        writeFileSync(file, `${JSON.stringify(anonymise(dedupe(rows), emails), null, 2)}\n`, { mode: 0o600 })
        written.push(`${name}.json (${rows.length})`)
      }
      r.pass(
        'SQ-09',
        `wrote ${written.join(', ')} to ${captureDir} with emails, phones, names and addresses replaced; copy them over test/fixtures/squarespace/ and run pnpm test`,
      )
    } else {
      r.skip('SQ-09', 'pass --capture <dir> to save redacted copies of what was read')
    }

    // ---- SQ-10 webhook signature path ----------------------------------------------------------------------------------
    const secret = env.SQSP_WEBHOOK_SECRET?.trim() || (sim ? 'a1b2c3d4e5f60718293a4b5c6d7e8f90' : undefined)
    if (!secret) {
      r.skip('SQ-10', 'SQSP_WEBHOOK_SECRET is not set (webhooks are optional; polling is the baseline)')
    } else if (!/^([0-9a-fA-F]{2})+$/.test(secret)) {
      r.fail(
        'SQ-10',
        'SQSP_WEBHOOK_SECRET is not a hex string',
        'Use the hex secret Squarespace returned when the subscription was created.',
      )
    } else {
      r.secret(secret)
      const signed = buildSignedNotification({
        secretHex: secret,
        id: `verify-${now.getTime()}`,
        websiteId: 'verify',
        subscriptionId: 'verify',
        topic: 'extension.uninstall',
        createdOn: now,
        data: {},
      })
      const local = await receiveWebhook(
        { clock: systemClock, dedupe: new InMemoryNotificationDedupe(), secrets: () => [secret] },
        { rawBody: signed.rawBody, headers: signed.headers },
      )
      const tampered = await receiveWebhook(
        { clock: systemClock, dedupe: new InMemoryNotificationDedupe(), secrets: () => [secret] },
        { rawBody: signed.rawBody.replace('verify', 'vexify'), headers: signed.headers },
      )
      if (local.status !== 'ignored' || tampered.status !== 'invalid_signature') {
        r.fail('SQ-10', `local verification answered ${local.status} / ${tampered.status}`)
      } else if (postWebhook) {
        const res = await fetch(postWebhook, {
          method: 'POST',
          headers: signed.headers,
          body: signed.rawBody,
          signal: AbortSignal.timeout(15_000),
        }).catch((e: Error) => e)
        if (res instanceof Error)
          r.fail(
            'SQ-10',
            `the local check passed; POST to ${postWebhook} failed: ${res.message}`,
            'Is the public HTTPS endpoint (nginx /hooks/squarespace) up?',
          )
        else if (res.status === 200 || res.status === 202)
          r.pass(
            'SQ-10',
            `local check passed; ${postWebhook} accepted a signed ignored-topic notification (HTTP ${res.status})`,
          )
        else
          r.fail(
            'SQ-10',
            `local check passed; ${postWebhook} answered HTTP ${res.status}`,
            res.status === 401
              ? 'The endpoint holds a different secret than SQSP_WEBHOOK_SECRET.'
              : 'Check the nginx location for /hooks/squarespace and the API log.',
          )
      } else {
        r.pass(
          'SQ-10',
          'the verifier accepts a correctly signed notification and rejects a tampered one; add --post-webhook https://<domain>/hooks/squarespace to test the public endpoint end to end',
        )
      }
    }
  } finally {
    await simClose?.()
  }
  return { report }
}

function dedupe(rows: unknown[]): unknown[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const id = (row as { id?: string }).id ?? JSON.stringify(row)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export const HELP = `pnpm verify:squarespace [options]

Reads orders, transactions and contacts with a read-only key, walks docs/integrations/squarespace.md section 7, proposes the product map
(never writes it) and writes docs/live-verification/<date>-squarespace.md and .json. Every request is a GET.
Exit code 0 = no FAIL, 1 = at least one FAIL, 2 = configuration missing or bad command line.

Environment (or --sim): SQSP_API_KEY    Optional: SQSP_API_BASE SQSP_USER_AGENT SQSP_WEBHOOK_SECRET

  --sim                   run against the built-in simulator (port 4590, --sim-port; --sim-page-size forces several pages)
  --days N                look back N days (default 30, widen it to find a renewal or a rare payment state)
  --max-pages N           stop reading a list after N pages (default 10)
  --capture DIR           save redacted copies of the payloads read (emails, phones, names, addresses replaced)
  --post-webhook URL      also POST a signed notification of an ignored topic to your public webhook URL (the only non-GET request)
  --out-dir DIR           where reports go (default docs/live-verification)
  --json                  also print the JSON summary
`

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  log: (l: string) => void = console.log,
): Promise<number> {
  return cli('verify:squarespace', HELP, argv, runSquarespace, SQUARESPACE_OPTIONS, env, log)
}

if (process.argv[1] && process.argv[1].endsWith('squarespace.ts')) {
  main(process.argv.slice(2)).then((c) => process.exit(c))
}
