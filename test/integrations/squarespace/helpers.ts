import { FixedClock } from '../../../src/platform/clock.js'
import {
  SquarespaceClient,
  type SquarespaceClientOptions,
} from '../../../src/integrations/squarespace/client.js'
import { FakeSleeper } from '../../../src/integrations/squarespace/sleeper.js'
import { SquarespaceSimApi } from '../../../src/integrations/squarespace/sim/api.js'
import { SquarespaceSimStore } from '../../../src/integrations/squarespace/sim/store.js'
import { fixture, NOW } from '../../fixtures/squarespace/load.js'

export const API_KEY = 'sim-api-key'

export interface Rig {
  clock: FixedClock
  sleeper: FakeSleeper
  store: SquarespaceSimStore
  api: SquarespaceSimApi
}

export function rig(opts: { pageSize?: number; order?: 'asc' | 'desc'; at?: string } = {}): Rig {
  const clock = new FixedClock(opts.at ?? NOW)
  const store = new SquarespaceSimStore(clock, {
    pageSize: opts.pageSize ?? 2,
    order: opts.order ?? 'asc',
    currency: 'USD',
  })
  return {
    clock,
    sleeper: new FakeSleeper(clock),
    store,
    api: new SquarespaceSimApi(store, clock, { apiKeys: [API_KEY] }),
  }
}

export function loadFixtures(store: SquarespaceSimStore): void {
  store.loadWire({
    orders: fixture<unknown[]>('orders.json'),
    documents: fixture<unknown[]>('transactions.json'),
    contacts: fixture<unknown[]>('contacts.json'),
  })
}

/** A fetch that routes straight into the sim API (no sockets): the client's real HTTP code path, deterministic. */
export function simFetch(api: SquarespaceSimApi): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
    const out = await api.handle({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify(out.body), {
      status: out.status,
      headers: { 'content-type': 'application/json', ...out.headers },
    })
  }) as typeof fetch
}

export function clientFor(r: Rig, over: Partial<SquarespaceClientOptions> = {}): SquarespaceClient {
  return new SquarespaceClient({
    auth: { kind: 'api_key', apiKey: API_KEY },
    clock: r.clock,
    sleeper: r.sleeper,
    fetch: simFetch(r.api),
    userAgent: 'OasisTest/1.0',
    ...over,
  })
}

export const WINDOW = {
  modifiedAfter: new Date('2026-01-01T00:00:00.000Z'),
  modifiedBefore: new Date('2026-10-06T13:59:00.000Z'),
}

export async function drain<T>(
  fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<{ items: T[]; pages: number }> {
  const items: T[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const p = await fetchPage(cursor)
    items.push(...p.items)
    cursor = p.nextCursor
    pages++
  } while (cursor)
  return { items, pages }
}
