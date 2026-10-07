import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SqspOrder } from '../../src/integrations/ports/squarespace.js'
import { SquarespaceSimApi } from '../../src/integrations/squarespace/sim/api.js'
import { close, createSimHttpServer, listen } from '../../src/integrations/squarespace/sim/http.js'
import { SquarespaceSimStore } from '../../src/integrations/squarespace/sim/store.js'
import { receiveWebhook, InMemoryNotificationDedupe } from '../../src/integrations/squarespace/webhook.js'
import { ProductMapBody } from '../../src/modules/payments-sync/http/schemas.js'
import { ProductMap } from '../../src/modules/payments-sync/product-map.js'
import { systemClock } from '../../src/platform/clock.js'
import {
  main,
  SQUARESPACE_ITEMS,
  discoverProducts,
  proposeProductMap,
} from '../../scripts/verify-live/squarespace.js'
import { seedSquarespaceSim } from '../../scripts/verify-live/sim-data.js'
import { runVerify, statusOf, type CliRun } from './verify-live-helpers.js'

const runs: CliRun[] = []
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (runs.length) runs.pop()!.cleanup()
  while (cleanups.length) await cleanups.pop()!()
})
const run = async (argv: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> => {
  const r = await runVerify(main, argv, env)
  runs.push(r)
  return r
}

describe('verify:squarespace against the simulator on port 4590', () => {
  it('walks the whole checklist and proposes a product map that the app would accept', async () => {
    const r = await run(['--sim', '--days', '90'])
    const s = statusOf(r, 'squarespace')
    for (const id of [
      'SQ-01',
      'SQ-02',
      'SQ-03',
      'SQ-04',
      'SQ-05',
      'SQ-06',
      'SQ-07',
      'SQ-10',
      'SQ-C1',
      'SQ-M1',
      'SQ-P1',
    ])
      expect([id, s[id]]).toEqual([id, 'PASS'])
    expect(s['SQ-08']).toBe('SKIP')
    expect(s['SQ-09']).toBe('SKIP')
    expect(Object.keys(s)).toHaveLength(SQUARESPACE_ITEMS.length)
    expect(r.code).toBe(0)

    const j = r.json('squarespace')
    expect(j.mode).toBe('sim')
    const proposal = j.notes.find((n) => n.startsWith('product map PROPOSAL'))!
    expect(proposal).toContain('not written anywhere')
    const file = path.join(
      r.outDir,
      `${new Date().toISOString().slice(0, 10)}-squarespace-product-map.proposed.json`,
    )
    const body = JSON.parse(readFileSync(file, 'utf8')) as { entries: Array<Record<string, unknown>> }
    // exactly what PUT /api/v1/integrations/squarespace/product-map accepts
    expect(ProductMapBody.safeParse(body).success).toBe(true)
    const byProduct = Object.fromEntries(body.entries.map((e) => [e.sku, e]))
    expect(byProduct['MEM-PREMIUM']).toMatchObject({
      kind: 'membership',
      plan: 'premium',
      planLabel: 'Premium Care Membership',
      intervalMonths: 1,
    })
    expect(byProduct['MEM-EXECUTIVE']).toMatchObject({ kind: 'membership', plan: 'executive' })
    // a service that merely has a tier word in its name is not turned into a membership
    expect(byProduct['WASH-EXEC']).toMatchObject({ kind: 'service' })
    expect(byProduct['WASH-EXEC']).not.toHaveProperty('plan')
    expect(byProduct['TSHIRT-M']).toMatchObject({ kind: 'service' })
    // the environment-variable form of the same map is accepted by the app's parser too
    const envForm = /SQSP_PRODUCT_MAP='(\[.*\])'/.exec(proposal)![1]!
    expect(() => ProductMap.fromJson(envForm)).not.toThrow()
    expect(r.markdown('squarespace')).toContain('| SQ-05 |')
  })

  it('reports pagination, the payment-state filter across pages and the email/phone coverage with numbers', async () => {
    const r = await run(['--sim', '--days', '90'])
    const items = Object.fromEntries(r.json('squarespace').items.map((i) => [i.id, i.detail]))
    expect(items['SQ-P1']).toMatch(/largest order page 2/)
    expect(items['SQ-03']).toMatch(/cursor page still returns/)
    expect(items['SQ-M1']).toMatch(/email on \d+%, phone on \d+%/)
    expect(items['SQ-02']).toMatch(/modifiedAfter alone: HTTP 400; cursor with dates: HTTP 400/)
    expect(items['SQ-07']).toMatch(/^\d+ request\(s\) for one poll cycle/)
  })

  it('--capture writes payloads with every email, name and phone replaced', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oasis-capture-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const r = await run(['--sim', '--days', '90', '--capture', dir])
    expect(statusOf(r, 'squarespace')['SQ-09']).toBe('PASS')
    expect(readdirSync(dir).sort()).toEqual(['contacts.json', 'orders.json', 'transactions.json'])
    const all = readdirSync(dir)
      .map((f) => readFileSync(path.join(dir, f), 'utf8'))
      .join('\n')
    expect(all).not.toMatch(/maria\.alvarez|liam\.chen|aisha\.rahman|Alvarez|Okafor|555-208-1177|5557120188/)
    expect(all).toContain('@example.invalid')
    expect(JSON.parse(readFileSync(path.join(dir, 'orders.json'), 'utf8'))).toHaveLength(15)
  })

  it('without a key it exits 2 naming SQSP_API_KEY and writes no report', async () => {
    const r = await run([])
    expect(r.code).toBe(2)
    expect(r.out).toContain('SQSP_API_KEY')
    expect(readdirSync(r.outDir)).toEqual([])
  })
})

describe('verify:squarespace against a live-style endpoint', () => {
  async function serve(
    configure?: (api: SquarespaceSimApi) => void,
  ): Promise<{ url: string; api: SquarespaceSimApi }> {
    const store = new SquarespaceSimStore(systemClock, { pageSize: 50, order: 'desc', currency: 'USD' })
    seedSquarespaceSim(store, systemClock)
    const api = new SquarespaceSimApi(store, systemClock, { apiKeys: ['right-key-123456'] })
    configure?.(api)
    const server = createSimHttpServer(api)
    const url = await listen(server, 4596)
    cleanups.push(() => close(server))
    return { url, api }
  }

  it('a rejected key is a FAIL with the fix, the key never reaches the output, and dependent items are SKIP', async () => {
    const { url } = await serve()
    const r = await run(['--days', '90'], { SQSP_API_KEY: 'wrong-key-abcdef', SQSP_API_BASE: url })
    expect(r.code).toBe(1)
    const s = statusOf(r, 'squarespace')
    expect(s['SQ-01']).toBe('FAIL')
    expect(s['SQ-02']).toBe('SKIP')
    expect(r.out).toMatch(/fix: Create a new key/)
    expect(r.out + r.markdown('squarespace')).not.toContain('wrong-key-abcdef')
  })

  it('a key without the Transactions permission fails that item with the permission to add, and the rest still run', async () => {
    const { url } = await serve((api) => api.injectFailure({ status: 403, times: 50, path: '/transactions' }))
    const r = await run(['--days', '90'], { SQSP_API_KEY: 'right-key-123456', SQSP_API_BASE: url })
    const s = statusOf(r, 'squarespace')
    expect(s['SQ-04']).toBe('FAIL')
    expect(s['SQ-01']).toBe('PASS')
    expect(s['SQ-05']).toBe('PASS')
    expect(r.json('squarespace').items.find((i) => i.id === 'SQ-04')!.detail).toMatch(
      /cannot read Transactions/,
    )
    expect(r.code).toBe(1)
  })

  it('--days defaults to 30: a 30-day window finds no renewal cadence and marks memberships unconfirmed', async () => {
    const { url } = await serve()
    const r = await run([], { SQSP_API_KEY: 'right-key-123456', SQSP_API_BASE: url })
    expect(r.json('squarespace').notes.join('\n')).toMatch(/UNCONFIRMED: no renewal seen/)
  })

  it('SQ-10 posts a signed ignored-topic notification to --post-webhook and judges the answer', async () => {
    const { url } = await serve()
    const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
    let seen: string | undefined
    const make = (verify: boolean): Promise<{ server: Server; url: string }> =>
      new Promise((resolve) => {
        const server = createServer((req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', () => {
            void (async () => {
              const out = await receiveWebhook(
                {
                  clock: systemClock,
                  dedupe: new InMemoryNotificationDedupe(),
                  secrets: () => (verify ? [secret] : ['00']),
                },
                { rawBody: Buffer.concat(chunks), headers: req.headers },
              )
              seen = out.status
              res.writeHead(out.status === 'invalid_signature' ? 401 : 200).end()
            })()
          })
        })
        server.listen(0, '127.0.0.1', () =>
          resolve({
            server,
            url: `http://127.0.0.1:${(server.address() as { port: number }).port}/hooks/squarespace`,
          }),
        )
      })
    const good = await make(true)
    cleanups.push(() => void good.server.close())
    const ok = await run(['--post-webhook', good.url], {
      SQSP_API_KEY: 'right-key-123456',
      SQSP_API_BASE: url,
      SQSP_WEBHOOK_SECRET: secret,
    })
    expect(statusOf(ok, 'squarespace')['SQ-10']).toBe('PASS')
    expect(seen).toBe('ignored')

    const wrong = await make(false)
    cleanups.push(() => void wrong.server.close())
    const bad = await run(['--post-webhook', wrong.url], {
      SQSP_API_KEY: 'right-key-123456',
      SQSP_API_BASE: url,
      SQSP_WEBHOOK_SECRET: secret,
    })
    expect(statusOf(bad, 'squarespace')['SQ-10']).toBe('FAIL')
    expect(bad.json('squarespace').items.find((i) => i.id === 'SQ-10')!.detail).toMatch(/HTTP 401/)
  })

  it('a webhook secret that is not hex is a FAIL', async () => {
    const { url } = await serve()
    const r = await run([], {
      SQSP_API_KEY: 'right-key-123456',
      SQSP_API_BASE: url,
      SQSP_WEBHOOK_SECRET: 'not-hex!',
    })
    expect(statusOf(r, 'squarespace')['SQ-10']).toBe('FAIL')
  })
})

describe('product discovery', () => {
  const day = 86_400_000
  const base = Date.parse('2026-01-01T00:00:00Z')
  const order = (
    id: string,
    customer: string,
    days: number,
    li: Partial<SqspOrder['lineItems'][number]> & { name: string },
    testMode = false,
  ): SqspOrder =>
    ({
      id,
      orderNumber: id,
      createdOn: new Date(base + days * day),
      modifiedOn: new Date(base + days * day),
      customerId: customer,
      isSubscription: false,
      grandTotalCents: 100,
      refundedTotalCents: 0,
      currency: 'USD',
      testMode,
      lineItems: [{ unitCents: 9900, qty: 1, ...li }],
      raw: {},
    }) as SqspOrder

  it('reads an annual cadence as 12 months and a quarterly one as 3', () => {
    const orders = [
      order('1', 'a', 0, { productId: 'p-year', name: 'Exotic Club Membership' }),
      order('2', 'a', 365, { productId: 'p-year', name: 'Exotic Club Membership' }),
      order('3', 'b', 0, { productId: 'p-q', name: 'Essential Plan' }),
      order('4', 'b', 91, { productId: 'p-q', name: 'Essential Plan' }),
    ]
    const { entries } = proposeProductMap(discoverProducts(orders))
    expect(entries.find((e) => e.productId === 'p-year')).toMatchObject({
      kind: 'membership',
      tier: 'exotic',
      intervalMonths: 12,
    })
    expect(entries.find((e) => e.productId === 'p-q')).toMatchObject({
      kind: 'membership',
      tier: 'essential',
      intervalMonths: 3,
    })
  })

  it('ignores test-mode orders, skips products with no id or sku, and flags a membership that names no tier', () => {
    const orders = [
      order('1', 'a', 0, { productId: 'p-test', name: 'Premium Care Membership' }, true),
      order('2', 'a', 1, { name: 'Gift Card' }),
      order('3', 'b', 0, { productId: 'p-club', name: 'Oasis Club Membership' }),
    ]
    const found = discoverProducts(orders)
    expect(found.map((f) => f.key)).not.toContain('p-test')
    const { entries, notes } = proposeProductMap(found)
    expect(entries.some((e) => e.productId === 'p-club')).toBe(false)
    expect(notes.join('\n')).toMatch(/Oasis Club Membership: looks like a membership but names no tier/)
  })
})
