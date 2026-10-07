import type { SmsPriority } from '../../../integrations/ports/sms.js'
import type { SmsEncoding } from '../../../integrations/sms/gsm.js'
import type { SmsClass } from '../policy/classes.js'

export type OutboxState =
  'pending' | 'inflight' | 'accepted' | 'sent' | 'delivered' | 'failed' | 'expired' | 'cancelled'

/** One queued text. `id` is also the SMS Gate message id of the first device attempt. */
export interface OutboxItem {
  id: string
  messageId: string
  toE164: string
  body: string
  encoding: SmsEncoding
  segments: number
  klass: SmsClass
  priority: SmsPriority
  state: OutboxState
  /** Send attempts that failed before the device accepted the message (network/5xx). */
  attempts: number
  /** Retries after the device itself reported a failure. */
  deviceFailures: number
  /** Resends after the device lost an accepted message (found by reconciliation). */
  reconcileResends: number
  nextAttemptAt: Date | null
  /** Id the device knows the message by; differs from `id` after a retry that followed a device-reported failure. */
  providerMessageId: string | null
  deviceId: string | null
  simSlot?: number
  lastError: string | null
  queuedAt: Date
  ttlAt: Date
  /** Quiet-hours release time computed at enqueue, informational. */
  holdUntil: Date | null
  acceptedAt: Date | null
  sentAt: Date | null
  deliveredAt: Date | null
  failedAt: Date | null
  lastReconciledAt: Date | null
}

export interface UsageEntry {
  providerMessageId: string
  segments: number
  /** When the device accepted the message. */
  acceptedAt: Date
  /** When the device reported it sent (preferred for the rate window). */
  sentAt?: Date
}

export interface OutboxRepository {
  /** Inserts a new item. Returns false (and changes nothing) when an item with this id exists. */
  insert(item: OutboxItem): Promise<boolean>
  get(id: string): Promise<OutboxItem | null>
  findByProviderMessageId(providerMessageId: string): Promise<OutboxItem | null>
  /** Atomically moves pending to inflight. Null when another worker already claimed it. */
  claim(id: string, at: Date): Promise<OutboxItem | null>
  update(id: string, patch: Partial<OutboxItem>): Promise<OutboxItem>
  /** All pending items (the dispatcher filters by readiness). */
  listPending(): Promise<OutboxItem[]>
  /** Items in accepted or sent whose last device contact is older than the cutoff and that have not been reconciled since. */
  listUnconfirmed(acceptedBefore: Date, acceptedAfter: Date, reconciledBefore: Date): Promise<OutboxItem[]>
  /** Items stuck in inflight since before the cutoff (a crash between claim and result). */
  listStuckInflight(lockedBefore: Date): Promise<OutboxItem[]>
  /** True when we have ever queued a message to the number (drives the first-message STOP footer). */
  hasPriorOutbound(phone: string): Promise<boolean>
  recordUsage(entry: UsageEntry): Promise<void>
  markUsageSent(providerMessageId: string, sentAt: Date): Promise<void>
  /** Window accounting rows with their effective time at or after `since`. */
  listUsage(since: Date): Promise<Array<{ at: Date; segments: number }>>
}

export type DeviceState = 'unknown' | 'online' | 'degraded' | 'offline'

export interface DeviceRecord {
  id: string
  state: DeviceState
  stateChangedAt: Date | null
  lastSeenAt: Date | null
  lastPingAt: Date | null
  lastAppStartedAt: Date | null
  lastPollOkAt: Date | null
  consecutivePollFailures: number
  healthStatus: 'pass' | 'warn' | 'fail' | null
  battery: number | null
  charging: boolean | null
}

export interface DeviceRepository {
  get(id: string): Promise<DeviceRecord | null>
  save(record: DeviceRecord): Promise<void>
}

export interface ProcessedEventRepository {
  /** True when this envelope id is new (and is now recorded); false for a duplicate delivery. */
  markIfNew(eventId: string, at: Date): Promise<boolean>
  /** Un-records an id so the device's retry is processed again after a handler failure (a DB wiring does this by rolling back). */
  forget(eventId: string): Promise<void>
}
