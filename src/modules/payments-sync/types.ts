import type { SqspContact, SqspOrder, SqspTransaction } from '../../integrations/ports/squarespace.js'

export type MatchState = 'unmatched' | 'auto' | 'manual' | 'ignored' | 'membership'
export type TxnState = 'new' | 'matched' | 'manual' | 'ignored' | 'deferred' | 'membership'

export interface StoredOrder {
  order: SqspOrder
  firstSeenAt: Date
  syncedAt: Date
  matchState: MatchState
  ignoreReason?: string
  matchedInvoiceId?: string
  customerId?: string
}

export interface StoredTransaction {
  txn: SqspTransaction
  firstSeenAt: Date
  syncedAt: Date
  state: TxnState
  ignoreReason?: string
  matchedEventId?: string
}

export interface StoredContact {
  contact: SqspContact
  syncedAt: Date
  customerId?: string
}

/** inserted/updated change the row; unchanged is a no-op; stale means the stored row is newer (out-of-order delivery). */
export type UpsertOutcome = 'inserted' | 'updated' | 'unchanged' | 'stale'

export type SyncResource = 'orders' | 'transactions' | 'contacts' | 'reconcile'
export type SyncStatus = 'idle' | 'ok' | 'partial' | 'error' | 'dead_letter'

export interface InFlightWindow {
  from: Date
  to: Date
  cursor?: string
}

export interface SyncState {
  resource: SyncResource
  /** End of the last fully ingested window; the next window starts at watermark minus the overlap. */
  watermark?: Date
  inFlight?: InFlightWindow
  /** Reconcile only: which feed is being re-read and the window it covers. */
  phase?: 'orders' | 'transactions'
  windowStart?: Date
  lastRunAt?: Date
  lastSuccessAt?: Date
  status: SyncStatus
  lastError?: string
  consecutiveFailures: number
}

export interface SyncItemError {
  resource: SyncResource
  key: string
  kind: 'mapping' | 'persist'
  message: string
  raw?: unknown
  at: Date
}
