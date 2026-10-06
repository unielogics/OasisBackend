import { createHash } from 'node:crypto'
import type { SqspContact, SqspOrder, SqspTransaction } from '../../integrations/ports/squarespace.js'
import type {
  ContactRepository,
  OrderRepository,
  SyncErrorRepository,
  SyncStateRepository,
  TransactionRepository,
} from './repositories.js'
import type {
  MatchState,
  StoredContact,
  StoredOrder,
  StoredTransaction,
  SyncItemError,
  SyncResource,
  SyncState,
  TxnState,
  UpsertOutcome,
} from './types.js'

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v instanceof Date) return v.toISOString()
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      )
    }
    return v
  })
}

function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

export class InMemoryOrderRepository implements OrderRepository {
  readonly rows = new Map<string, StoredOrder & { hash: string }>()
  writes = 0

  async upsert(
    order: SqspOrder,
    ctx: { now: Date; initial: { matchState: MatchState; ignoreReason?: string } },
  ): Promise<UpsertOutcome> {
    const h = hash(order)
    const cur = this.rows.get(order.id)
    if (!cur) {
      this.writes++
      this.rows.set(order.id, {
        order,
        hash: h,
        firstSeenAt: ctx.now,
        syncedAt: ctx.now,
        matchState: ctx.initial.matchState,
        ignoreReason: ctx.initial.ignoreReason,
      })
      return 'inserted'
    }
    if (order.modifiedOn.getTime() < cur.order.modifiedOn.getTime()) return 'stale'
    if (cur.hash === h) return 'unchanged'
    this.writes++
    cur.order = order
    cur.hash = h
    cur.syncedAt = ctx.now
    return 'updated'
  }

  async get(id: string): Promise<StoredOrder | undefined> {
    return this.rows.get(id)
  }

  async listByMatchState(state: MatchState, limit: number): Promise<StoredOrder[]> {
    return [...this.rows.values()]
      .filter((r) => r.matchState === state)
      .sort((a, b) => a.order.createdOn.getTime() - b.order.createdOn.getTime())
      .slice(0, limit)
  }

  async listModifiedBetween(from: Date, to: Date): Promise<StoredOrder[]> {
    return [...this.rows.values()].filter(
      (r) => r.order.modifiedOn.getTime() > from.getTime() && r.order.modifiedOn.getTime() < to.getTime(),
    )
  }

  async setMatch(
    id: string,
    patch: { matchState: MatchState; matchedInvoiceId?: string; customerId?: string; ignoreReason?: string },
  ): Promise<void> {
    const cur = this.rows.get(id)
    if (!cur) throw new Error(`order ${id} not stored`)
    cur.matchState = patch.matchState
    cur.matchedInvoiceId = patch.matchedInvoiceId ?? cur.matchedInvoiceId
    cur.customerId = patch.customerId ?? cur.customerId
    cur.ignoreReason = patch.ignoreReason
  }
}

export class InMemoryTransactionRepository implements TransactionRepository {
  readonly rows = new Map<string, StoredTransaction & { hash: string }>()
  writes = 0

  async upsert(
    txn: SqspTransaction,
    ctx: { now: Date; initial: { state: TxnState; ignoreReason?: string } },
  ): Promise<UpsertOutcome> {
    const { raw: _raw, ...fields } = txn
    void _raw
    const h = hash(fields)
    const cur = this.rows.get(txn.id)
    if (!cur) {
      this.writes++
      this.rows.set(txn.id, {
        txn,
        hash: h,
        firstSeenAt: ctx.now,
        syncedAt: ctx.now,
        state: ctx.initial.state,
        ignoreReason: ctx.initial.ignoreReason,
      })
      return 'inserted'
    }
    const incoming = (txn.documentModifiedOn ?? txn.createdOn).getTime()
    const stored = (cur.txn.documentModifiedOn ?? cur.txn.createdOn).getTime()
    if (incoming < stored) return 'stale'
    if (cur.hash === h) return 'unchanged'
    this.writes++
    cur.txn = txn
    cur.hash = h
    cur.syncedAt = ctx.now
    return 'updated'
  }

  async get(id: string): Promise<StoredTransaction | undefined> {
    return this.rows.get(id)
  }

  async listByOrder(orderId: string): Promise<StoredTransaction[]> {
    return [...this.rows.values()]
      .filter((r) => r.txn.orderId === orderId)
      .sort((a, b) => a.txn.createdOn.getTime() - b.txn.createdOn.getTime() || (a.txn.id < b.txn.id ? -1 : 1))
  }

  async listByState(states: TxnState[], limit: number): Promise<StoredTransaction[]> {
    return [...this.rows.values()]
      .filter((r) => states.includes(r.state))
      .sort((a, b) => a.txn.createdOn.getTime() - b.txn.createdOn.getTime() || (a.txn.id < b.txn.id ? -1 : 1))
      .slice(0, limit)
  }

  async setState(
    id: string,
    patch: { state: TxnState; matchedEventId?: string; ignoreReason?: string },
  ): Promise<void> {
    const cur = this.rows.get(id)
    if (!cur) throw new Error(`transaction ${id} not stored`)
    cur.state = patch.state
    cur.matchedEventId = patch.matchedEventId ?? cur.matchedEventId
    cur.ignoreReason = patch.ignoreReason
  }
}

export class InMemoryContactRepository implements ContactRepository {
  readonly rows = new Map<string, StoredContact & { hash: string }>()

  async upsert(contact: SqspContact, ctx: { now: Date }): Promise<UpsertOutcome> {
    const h = hash(contact)
    const cur = this.rows.get(contact.id)
    if (!cur) {
      this.rows.set(contact.id, { contact, hash: h, syncedAt: ctx.now })
      return 'inserted'
    }
    if (cur.hash === h) return 'unchanged'
    cur.contact = contact
    cur.hash = h
    cur.syncedAt = ctx.now
    return 'updated'
  }

  async list(): Promise<StoredContact[]> {
    return [...this.rows.values()]
  }
}

export class InMemorySyncStateRepository implements SyncStateRepository {
  readonly rows = new Map<SyncResource, SyncState>()
  async get(resource: SyncResource): Promise<SyncState | undefined> {
    const s = this.rows.get(resource)
    return s ? structuredClone(s) : undefined
  }
  async save(state: SyncState): Promise<void> {
    this.rows.set(state.resource, structuredClone(state))
  }
}

export class InMemorySyncErrorRepository implements SyncErrorRepository {
  readonly rows = new Map<string, SyncItemError & { attempts: number }>()
  async record(error: SyncItemError): Promise<{ attempts: number }> {
    const key = `${error.resource}:${error.key}`
    const attempts = (this.rows.get(key)?.attempts ?? 0) + 1
    this.rows.set(key, { ...error, attempts })
    return { attempts }
  }
  async clear(resource: SyncResource, key: string): Promise<void> {
    this.rows.delete(`${resource}:${key}`)
  }
  async list(resource?: SyncResource): Promise<(SyncItemError & { attempts: number })[]> {
    return [...this.rows.values()].filter((r) => !resource || r.resource === resource)
  }
}
