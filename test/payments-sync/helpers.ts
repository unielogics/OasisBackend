import { FixedClock } from '../../src/platform/clock.js'
import type {
  Page,
  SqspContact,
  SqspOrder,
  SqspTransaction,
  SquarespaceSource,
} from '../../src/integrations/ports/squarespace.js'
import { InProcessSquarespace } from '../../src/integrations/squarespace/sim/fake.js'
import { SquarespaceSimStore } from '../../src/integrations/squarespace/sim/store.js'
import {
  InMemoryContactRepository,
  InMemoryOrderRepository,
  InMemorySyncErrorRepository,
  InMemorySyncStateRepository,
  InMemoryTransactionRepository,
} from '../../src/modules/payments-sync/memory.js'
import { SyncEngine, type SyncConfig } from '../../src/modules/payments-sync/sync.js'
import { fixture, NOW } from '../fixtures/squarespace/load.js'

export interface Call {
  fn: 'listOrders' | 'listTransactions' | 'listContacts' | 'getOrder'
  after?: Date
  before?: Date
  cursor?: string
}

/** Wraps a source, records calls, and lets a test inject failures or rejected rows. */
export class SpySource implements SquarespaceSource {
  calls: Call[] = []
  failNext: { fn: Call['fn']; error: Error; times: number }[] = []
  rejectIds: string[] = []
  constructor(private readonly inner: SquarespaceSource) {}

  private maybeFail(fn: Call['fn']): void {
    const f = this.failNext.find((x) => x.fn === fn && x.times > 0)
    if (f) {
      f.times--
      throw f.error
    }
  }

  async listOrders(p: {
    modifiedAfter: Date
    modifiedBefore: Date
    cursor?: string
  }): Promise<Page<SqspOrder>> {
    this.calls.push({ fn: 'listOrders', after: p.modifiedAfter, before: p.modifiedBefore, cursor: p.cursor })
    this.maybeFail('listOrders')
    const page = await this.inner.listOrders(p)
    if (!this.rejectIds.length) return page
    const rejected = page.items.filter((o) => this.rejectIds.includes(o.id))
    return {
      ...page,
      items: page.items.filter((o) => !this.rejectIds.includes(o.id)),
      rejected: rejected.map((o) => ({ id: o.id, reason: 'injected mapping failure', raw: o.raw })),
    }
  }
  async getOrder(id: string): Promise<SqspOrder> {
    this.calls.push({ fn: 'getOrder' })
    return this.inner.getOrder(id)
  }
  async listTransactions(p: {
    modifiedAfter: Date
    modifiedBefore: Date
    cursor?: string
  }): Promise<Page<SqspTransaction>> {
    this.calls.push({
      fn: 'listTransactions',
      after: p.modifiedAfter,
      before: p.modifiedBefore,
      cursor: p.cursor,
    })
    this.maybeFail('listTransactions')
    return this.inner.listTransactions(p)
  }
  async listContacts(p: { cursor?: string }): Promise<Page<SqspContact>> {
    this.calls.push({ fn: 'listContacts', cursor: p.cursor })
    this.maybeFail('listContacts')
    return this.inner.listContacts(p)
  }
  count(fn: Call['fn']): number {
    return this.calls.filter((c) => c.fn === fn).length
  }
}

export function syncRig(
  opts: { pageSize?: number; order?: 'asc' | 'desc'; cfg?: Partial<SyncConfig>; at?: string } = {},
) {
  const clock = new FixedClock(opts.at ?? NOW)
  const store = new SquarespaceSimStore(clock, {
    pageSize: opts.pageSize ?? 3,
    order: opts.order ?? 'asc',
    currency: 'USD',
  })
  const source = new SpySource(new InProcessSquarespace(store))
  const repos = {
    orders: new InMemoryOrderRepository(),
    transactions: new InMemoryTransactionRepository(),
    contacts: new InMemoryContactRepository(),
    state: new InMemorySyncStateRepository(),
    errors: new InMemorySyncErrorRepository(),
  }
  const engine = new SyncEngine({ source, clock, ...repos }, opts.cfg)
  return { clock, store, source, repos, engine }
}

export function loadFixtureStore(store: SquarespaceSimStore): void {
  store.loadWire({
    orders: fixture<unknown[]>('orders.json'),
    documents: fixture<unknown[]>('transactions.json'),
    contacts: fixture<unknown[]>('contacts.json'),
  })
}
