import type { SqspContact, SqspOrder, SqspTransaction } from '../../integrations/ports/squarespace.js'
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

/**
 * Persistence interfaces only. The integrator implements them over Postgres (sqsp_orders, sqsp_transactions,
 * sqsp_profiles, sqsp_sync_state); in-memory implementations live in memory.ts. Every upsert must be idempotent and must
 * never move a row back to an older version of itself.
 */
export interface OrderRepository {
  /**
   * Insert or update by Squarespace order id. `initial` applies on insert only; an existing row keeps its match fields.
   * Returns `stale` without writing when the stored modifiedOn is newer than the incoming one, and `unchanged` when the
   * payload is identical.
   */
  upsert(
    order: SqspOrder,
    ctx: { now: Date; initial: { matchState: MatchState; ignoreReason?: string } },
  ): Promise<UpsertOutcome>
  get(id: string): Promise<StoredOrder | undefined>
  listByMatchState(state: MatchState, limit: number): Promise<StoredOrder[]>
  /** Orders whose Squarespace modifiedOn is inside the open interval; used by the nightly reconcile diff. */
  listModifiedBetween(from: Date, to: Date): Promise<StoredOrder[]>
  setMatch(
    id: string,
    patch: { matchState: MatchState; matchedInvoiceId?: string; customerId?: string; ignoreReason?: string },
  ): Promise<void>
}

export interface TransactionRepository {
  upsert(
    txn: SqspTransaction,
    ctx: { now: Date; initial: { state: TxnState; ignoreReason?: string } },
  ): Promise<UpsertOutcome>
  get(id: string): Promise<StoredTransaction | undefined>
  listByOrder(orderId: string): Promise<StoredTransaction[]>
  listByState(states: TxnState[], limit: number): Promise<StoredTransaction[]>
  setState(
    id: string,
    patch: { state: TxnState; matchedEventId?: string; ignoreReason?: string },
  ): Promise<void>
}

export interface ContactRepository {
  upsert(contact: SqspContact, ctx: { now: Date }): Promise<UpsertOutcome>
  list(): Promise<StoredContact[]>
}

export interface SyncStateRepository {
  get(resource: SyncResource): Promise<SyncState | undefined>
  save(state: SyncState): Promise<void>
}

export interface SyncErrorRepository {
  /** Records a failed item and returns how many times this key has now failed. */
  record(error: SyncItemError): Promise<{ attempts: number }>
  /** Called when an item finally succeeds. */
  clear(resource: SyncResource, key: string): Promise<void>
  list(resource?: SyncResource): Promise<(SyncItemError & { attempts: number })[]>
}
