import type { Clock } from '../../../platform/clock.js'
import type { SmsEvent, SmsPriority, SmsProvider, SmsState } from '../../../integrations/ports/sms.js'
import { SmsProviderError } from '../../../integrations/sms/errors.js'
import { prepareSmsBody } from '../../../integrations/sms/gsm.js'
import { prepareOutboundBody } from '../policy/body.js'
import { expiryFor } from '../policy/body.js'
import { canSendSms, type SmsDecision, type SmsDenyReason, type SmsPolicyContext, type SmsRecipient } from '../policy/canSend.js'
import { classSpec, isTransactional, type SmsClass } from '../policy/classes.js'
import { DEFAULT_QUIET_HOURS, isQuietHour, type QuietHoursConfig } from '../policy/quietHours.js'
import { canSpend, DEFAULT_BUDGET, nextFit, snapshot, usedInWindow, type BudgetConfig, type BudgetSnapshot } from './budget.js'
import { estimateQueue, type QueueEstimate } from './eta.js'
import { DeviceHealthMonitor, type HealthEvaluation } from './health.js'
import { backoffMs, DEFAULT_RETRY, DEFAULT_TRANSIENT_REASONS, isTransientReason, nextRetryProviderId, type RetryConfig } from './retry.js'
import type { DeviceState, OutboxItem, OutboxRepository } from './types.js'

// The dispatcher for ONE physical device. Pure orchestration: time comes from the injected Clock, storage from repository
// interfaces, the radio from an SmsProvider. A host calls enqueue() when something should be texted, tick() every second or
// so (and when woken), reconcile() every couple of minutes, and handleEvent() for each verified webhook.

export interface DispatcherConfig {
  deviceId: string
  budget: BudgetConfig
  /** Minimum gap between two sends. The Android app also randomises its own delay; this keeps our bursts polite. */
  minIntervalMs: number
  maxPerTick: number
  /** Longest message accepted, in segments. */
  maxSegments: number
  retry: RetryConfig
  /** One retry of a device-reported failure with a transient-looking reason, after this delay. */
  deviceFailureRetryAfterMs: number
  deviceFailureMaxRetries: number
  transientReasons: readonly RegExp[]
  reconcile: { afterMs: number; minGapMs: number; maxAgeMs: number; maxResends: number }
  /** An inflight claim older than this is assumed orphaned by a crash and put back (the provider dedupes by id). */
  inflightStaleMs: number
  /** Lane-0 messages waiting longer than this are reported as e-mail fallback candidates. */
  p0FallbackAfterMs: number
  simSlot?: number
  quietHours: QuietHoursConfig
  environment: SmsPolicyContext['environment']
  allowlist: readonly string[]
}

export function defaultDispatcherConfig(overrides: Partial<DispatcherConfig> & Pick<DispatcherConfig, 'deviceId'>): DispatcherConfig {
  return {
    budget: DEFAULT_BUDGET,
    minIntervalMs: 3000,
    maxPerTick: 20,
    maxSegments: 8,
    retry: DEFAULT_RETRY,
    deviceFailureRetryAfterMs: 120_000,
    deviceFailureMaxRetries: 1,
    transientReasons: DEFAULT_TRANSIENT_REASONS,
    reconcile: { afterMs: 5 * 60_000, minGapMs: 5 * 60_000, maxAgeMs: 6 * 3600_000, maxResends: 1 },
    inflightStaleMs: 2 * 60_000,
    p0FallbackAfterMs: 5 * 60_000,
    quietHours: DEFAULT_QUIET_HOURS,
    environment: 'production',
    allowlist: [],
    ...overrides,
  }
}

export interface EnqueueInput {
  /** messages.id: becomes the outbox id and the SMS Gate message id. */
  messageId: string
  recipient: SmsRecipient
  klass: SmsClass
  /** Final text of the message before GSM-7 normalisation and the STOP footer (render templates first). */
  text: string
  /** Override the class lane (e.g. staff marks a message urgent). */
  priority?: SmsPriority
  ttlOverrideSec?: number
  simSlot?: number
}

export type EnqueueResult =
  | { status: 'queued' | 'held'; id: string; segments: number; encoding: string; ttlAt: Date; holdUntil: Date | null; body: string; warnings: string[] }
  | { status: 'duplicate'; id: string }
  | { status: 'suppressed'; reason: SmsDenyReason }
  | { status: 'rejected'; reason: 'too_long' | 'empty'; segments?: number }

export interface TickReport {
  at: Date
  device: DeviceState
  /** Provider message ids handed to the device this tick. */
  sent: string[]
  expired: string[]
  failed: string[]
  /** Pending items skipped because quiet hours hold their class. */
  heldByQuietHours: number
  rateLimited: boolean
  /** When the budget next frees room for the head of the queue. */
  resumesAt: Date | null
  paced: boolean
  /** The device is offline: nothing was attempted. */
  offline: boolean
  authFailure: boolean
  /** Lane-0 items stranded long enough that the host should fall back to e-mail. */
  p0FallbackCandidates: string[]
}

export interface DispatcherStatus {
  device: DeviceState
  rateLimited: boolean
  resumesAt: Date | null
  budget: BudgetSnapshot
  queue: QueueEstimate
  heldByQuietHours: number
}

export interface EventResult {
  handled: boolean
  detail: 'updated' | 'ignored_unknown_message' | 'ignored_stale' | 'requeued' | 'health' | 'not_applicable'
  outboxId?: string
}

const RANK: Record<string, number> = { pending: 0, inflight: 1, accepted: 2, sent: 3, delivered: 4 }

export class Dispatcher {
  constructor(
    private readonly provider: SmsProvider,
    private readonly outbox: OutboxRepository,
    private readonly health: DeviceHealthMonitor,
    private readonly clock: Clock,
    private readonly cfg: DispatcherConfig,
  ) {}

  private policyContext(now: Date): SmsPolicyContext {
    return { now, environment: this.cfg.environment, allowlist: this.cfg.allowlist, quietHours: this.cfg.quietHours }
  }

  // ---- enqueue ---------------------------------------------------------------------------------------------------

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const now = this.clock.now()
    if (input.text.trim().length === 0) return { status: 'rejected', reason: 'empty' }

    const existing = await this.outbox.get(input.messageId)
    if (existing) return { status: 'duplicate', id: existing.id }

    const decision: SmsDecision = canSendSms(input.recipient, { klass: input.klass }, this.policyContext(now))
    if (decision.verdict === 'deny') return { status: 'suppressed', reason: decision.reason }
    const phone = input.recipient.phone as string // canSendSms denied when null

    if (prepareSmsBody(input.text, undefined).body.length === 0) return { status: 'rejected', reason: 'empty' }
    const first = !(await this.outbox.hasPriorOutbound(phone))
    const prepared = prepareOutboundBody(input.text, input.klass, { firstMessageToNumber: first })
    if (prepared.segments > this.cfg.maxSegments) return { status: 'rejected', reason: 'too_long', segments: prepared.segments }

    const holdUntil = decision.verdict === 'hold' ? decision.holdUntil : null
    const ttlAt = expiryFor(input.klass, now, holdUntil, input.ttlOverrideSec)
    const item: OutboxItem = {
      id: input.messageId,
      messageId: input.messageId,
      toE164: phone,
      body: prepared.body,
      encoding: prepared.encoding,
      segments: prepared.segments,
      klass: input.klass,
      priority: input.priority ?? classSpec(input.klass).priority,
      state: 'pending',
      attempts: 0,
      deviceFailures: 0,
      reconcileResends: 0,
      nextAttemptAt: holdUntil,
      providerMessageId: null,
      deviceId: this.cfg.deviceId,
      simSlot: input.simSlot ?? this.cfg.simSlot,
      lastError: null,
      queuedAt: now,
      ttlAt,
      holdUntil,
      acceptedAt: null,
      sentAt: null,
      deliveredAt: null,
      failedAt: null,
      lastReconciledAt: null,
    }
    if (!(await this.outbox.insert(item))) return { status: 'duplicate', id: item.id }
    return {
      status: holdUntil ? 'held' : 'queued',
      id: item.id,
      segments: item.segments,
      encoding: item.encoding,
      ttlAt,
      holdUntil,
      body: item.body,
      warnings: decision.warnings,
    }
  }

  /** Cancels a message that has not been handed to the device yet. */
  async cancel(id: string): Promise<boolean> {
    const item = await this.outbox.get(id)
    if (!item || item.state !== 'pending') return false
    await this.outbox.update(id, { state: 'cancelled', lastError: 'cancelled by staff' })
    return true
  }

  /** Staff "retry" on a failed or expired message: a fresh attempt under a new device id with a fresh TTL. */
  async retryFailed(id: string): Promise<boolean> {
    const item = await this.outbox.get(id)
    if (!item || (item.state !== 'failed' && item.state !== 'expired')) return false
    const now = this.clock.now()
    await this.outbox.update(id, {
      state: 'pending',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      failedAt: null,
      providerMessageId: item.acceptedAt === null ? item.providerMessageId : nextRetryProviderId(item.id, item.providerMessageId),
      ttlAt: expiryFor(item.klass, now),
    })
    return true
  }

  // ---- tick ------------------------------------------------------------------------------------------------------

  async tick(): Promise<TickReport> {
    const now = this.clock.now()
    const report: TickReport = {
      at: now,
      device: 'unknown',
      sent: [],
      expired: [],
      failed: [],
      heldByQuietHours: 0,
      rateLimited: false,
      resumesAt: null,
      paced: false,
      offline: false,
      authFailure: false,
      p0FallbackCandidates: [],
    }

    // A crash between claim and result leaves an item inflight. Put it back; the provider answers 409/status for its id.
    for (const stuck of await this.outbox.listStuckInflight(new Date(now.getTime() - this.cfg.inflightStaleMs))) {
      await this.outbox.update(stuck.id, { state: 'pending', nextAttemptAt: null })
    }

    let pending = await this.outbox.listPending()
    for (const item of pending) {
      if (item.ttlAt.getTime() <= now.getTime()) {
        await this.outbox.update(item.id, { state: 'expired', lastError: 'expired before it could be sent' })
        report.expired.push(item.id)
      }
    }
    pending = pending.filter((i) => !report.expired.includes(i.id))

    const evaluation = await this.health.evaluate(this.cfg.deviceId)
    report.device = evaluation.state
    if (evaluation.state === 'offline') {
      report.offline = true
      report.p0FallbackCandidates = this.fallbackCandidates(pending, now)
      return report
    }

    const quiet = isQuietHour(now, this.cfg.quietHours)
    const ready = pending.filter((i) => i.nextAttemptAt === null || i.nextAttemptAt.getTime() <= now.getTime())
    const eligible = ready.filter((i) => {
      if (quiet && !isTransactional(i.klass)) {
        report.heldByQuietHours += 1
        return false
      }
      return true
    })
    eligible.sort((a, b) => a.priority - b.priority || a.queuedAt.getTime() - b.queuedAt.getTime() || (a.id < b.id ? -1 : 1))

    const usage = (await this.outbox.listUsage(new Date(now.getTime() - this.cfg.budget.windowMs))).map((u) => ({ at: u.at, segments: u.segments }))
    let lastSendAt = usage.reduce((m, u) => Math.max(m, u.at.getTime()), Number.NEGATIVE_INFINITY)

    for (const item of eligible) {
      if (report.sent.length >= this.cfg.maxPerTick) break
      if (now.getTime() - lastSendAt < this.cfg.minIntervalMs) {
        report.paced = true
        break
      }
      if (!canSpend(usage, now, item.segments, item.priority, this.cfg.budget)) {
        report.rateLimited = true
        const fit = nextFit(usage, now, item.segments, item.priority, this.cfg.budget)
        if (fit && (report.resumesAt === null || fit < report.resumesAt)) report.resumesAt = fit
        continue
      }
      const ttlSec = Math.floor((item.ttlAt.getTime() - now.getTime()) / 1000)
      if (ttlSec < 5) {
        await this.outbox.update(item.id, { state: 'expired', lastError: 'expired before it could be sent' })
        report.expired.push(item.id)
        continue
      }
      const claimed = await this.outbox.claim(item.id, now)
      if (!claimed) continue

      const providerId = claimed.providerMessageId ?? claimed.id
      try {
        const result = await this.provider.send({
          id: providerId,
          to: claimed.toE164,
          body: claimed.body,
          simSlot: claimed.simSlot,
          ttlSec,
          priority: claimed.priority,
        })
        await this.onAccepted(claimed, result.providerMessageId, result.state, now)
        usage.push({ at: now, segments: claimed.segments })
        lastSendAt = now.getTime()
        report.sent.push(result.providerMessageId)
        await this.health.record(this.cfg.deviceId, { kind: 'poll_ok', at: now })
      } catch (err) {
        const outcome = await this.onSendError(claimed, err, now)
        if (outcome.failed) report.failed.push(claimed.id)
        if (outcome.auth) report.authFailure = true
        if (outcome.stop) break
      }
    }

    report.p0FallbackCandidates = this.fallbackCandidates(
      pending.filter((i) => !report.sent.includes(i.providerMessageId ?? i.id)),
      now,
    )
    return report
  }

  private fallbackCandidates(pending: readonly OutboxItem[], now: Date): string[] {
    return pending
      .filter((i) => i.priority === 0 && now.getTime() - i.queuedAt.getTime() >= this.cfg.p0FallbackAfterMs)
      .map((i) => i.id)
  }

  private async onAccepted(item: OutboxItem, providerId: string, deviceState: SmsState, now: Date): Promise<void> {
    await this.outbox.recordUsage({ providerMessageId: providerId, segments: item.segments, acceptedAt: now })
    if (deviceState === 'Failed') {
      await this.applyDeviceFailure({ ...item, providerMessageId: providerId, acceptedAt: now }, 'device reported Failed on submit', now)
      return
    }
    const state = deviceState === 'Delivered' ? 'delivered' : deviceState === 'Sent' ? 'sent' : 'accepted'
    await this.outbox.update(item.id, {
      state,
      providerMessageId: providerId,
      acceptedAt: now,
      attempts: item.attempts + 1,
      lastError: null,
      nextAttemptAt: null,
      ...(state === 'sent' || state === 'delivered' ? { sentAt: now } : {}),
      ...(state === 'delivered' ? { deliveredAt: now } : {}),
    })
  }

  private async onSendError(item: OutboxItem, err: unknown, now: Date): Promise<{ failed: boolean; auth: boolean; stop: boolean }> {
    const e = err instanceof SmsProviderError ? err : new SmsProviderError('transient', (err as Error)?.message ?? String(err))
    if (e.kind === 'rejected') {
      await this.outbox.update(item.id, { state: 'failed', failedAt: now, lastError: e.message })
      return { failed: true, auth: false, stop: false }
    }
    if (e.kind === 'auth') {
      // Not the message's fault: put it back without burning an attempt and stop for this tick.
      await this.outbox.update(item.id, { state: 'pending', nextAttemptAt: new Date(now.getTime() + 5 * 60_000), lastError: e.message })
      return { failed: false, auth: true, stop: true }
    }
    // transient or protocol: outcome unknown to us; the provider already checked the device before giving up.
    await this.health.record(this.cfg.deviceId, { kind: 'poll_failed', at: now })
    const attempts = item.attempts + 1
    if (attempts >= this.cfg.retry.maxAttempts) {
      await this.outbox.update(item.id, { state: 'failed', failedAt: now, attempts, lastError: e.message })
      return { failed: true, auth: false, stop: true }
    }
    await this.outbox.update(item.id, {
      state: 'pending',
      attempts,
      lastError: e.message,
      nextAttemptAt: new Date(now.getTime() + backoffMs(attempts, this.cfg.retry)),
    })
    // The device is probably down: do not hammer it with the rest of the queue this tick.
    return { failed: false, auth: false, stop: true }
  }

  // ---- device events ---------------------------------------------------------------------------------------------

  async handleEvent(event: SmsEvent, extras: { health?: { status: 'pass' | 'warn' | 'fail'; battery?: number; charging?: boolean } } = {}): Promise<EventResult & { health?: HealthEvaluation }> {
    const now = this.clock.now()
    switch (event.kind) {
      case 'ping': {
        const evaluation = await this.health.record(event.deviceId, {
          kind: 'ping',
          at: event.at,
          healthStatus: extras.health?.status,
          battery: extras.health?.battery,
          charging: extras.health?.charging,
        })
        return { handled: true, detail: 'health', health: evaluation }
      }
      case 'app_started': {
        const evaluation = await this.health.record(event.deviceId, { kind: 'app_started', at: event.at })
        return { handled: true, detail: 'health', health: evaluation }
      }
      case 'received':
        return { handled: false, detail: 'not_applicable' }
      default:
        break
    }

    const item = await this.outbox.findByProviderMessageId(event.providerMessageId)
    if (!item) return { handled: false, detail: 'ignored_unknown_message' }

    switch (event.kind) {
      case 'sent': {
        await this.outbox.markUsageSent(event.providerMessageId, event.at)
        if ((RANK[item.state] ?? 0) >= RANK.sent!) {
          // The sent event carries the true send time; a delivered event that overtook it only had a fallback.
          await this.outbox.update(item.id, { sentAt: event.at })
          return { handled: true, detail: 'ignored_stale', outboxId: item.id }
        }
        await this.outbox.update(item.id, { state: 'sent', sentAt: event.at, lastError: null })
        return { handled: true, detail: 'updated', outboxId: item.id }
      }
      case 'delivered': {
        // Delivered is the strongest fact; it wins over a late or contradictory failure.
        if (item.state === 'delivered') return { handled: true, detail: 'ignored_stale', outboxId: item.id }
        await this.outbox.update(item.id, {
          state: 'delivered',
          deliveredAt: event.at,
          sentAt: item.sentAt ?? event.at,
          lastError: null,
          failedAt: null,
        })
        return { handled: true, detail: 'updated', outboxId: item.id }
      }
      case 'failed': {
        if (item.state === 'delivered' || item.state === 'failed') return { handled: true, detail: 'ignored_stale', outboxId: item.id }
        const requeued = await this.applyDeviceFailure(item, event.reason ?? 'unknown', now, event.at)
        return { handled: true, detail: requeued ? 'requeued' : 'updated', outboxId: item.id }
      }
      case 'cancelled': {
        if ((RANK[item.state] ?? 0) >= RANK.sent!) return { handled: true, detail: 'ignored_stale', outboxId: item.id }
        await this.outbox.update(item.id, { state: 'cancelled', lastError: 'cancelled on the device' })
        return { handled: true, detail: 'updated', outboxId: item.id }
      }
    }
  }

  /** Returns true when the message was put back for one more try. */
  private async applyDeviceFailure(item: OutboxItem, reason: string, now: Date, at: Date = now): Promise<boolean> {
    const canRetry = isTransientReason(reason, this.cfg.transientReasons) && item.deviceFailures < this.cfg.deviceFailureMaxRetries
    if (canRetry && item.ttlAt.getTime() > now.getTime() + this.cfg.deviceFailureRetryAfterMs) {
      await this.outbox.update(item.id, {
        state: 'pending',
        deviceFailures: item.deviceFailures + 1,
        // The device keeps the failed message under its id and would answer 409 to a repeat, so the retry gets a new one.
        providerMessageId: nextRetryProviderId(item.id, item.providerMessageId),
        nextAttemptAt: new Date(now.getTime() + this.cfg.deviceFailureRetryAfterMs),
        lastError: `device failure, retrying: ${reason}`,
      })
      return true
    }
    await this.outbox.update(item.id, { state: 'failed', failedAt: at, lastError: reason })
    return false
  }

  // ---- reconciliation --------------------------------------------------------------------------------------------

  /**
   * Asks the device about messages it accepted but never confirmed: webhooks can be lost (tablet offline, HTTPS broken),
   * and the device may have lost a message in a crash. A message the device has never heard of is safe to send again.
   */
  async reconcile(): Promise<{ checked: number; updated: number; resent: number; errors: number }> {
    const now = this.clock.now()
    const r = this.cfg.reconcile
    const items = await this.outbox.listUnconfirmed(
      new Date(now.getTime() - r.afterMs),
      new Date(now.getTime() - r.maxAgeMs),
      new Date(now.getTime() - r.minGapMs),
    )
    const out = { checked: 0, updated: 0, resent: 0, errors: 0 }
    for (const item of items) {
      out.checked += 1
      const providerId = item.providerMessageId ?? item.id
      let status: { state: SmsState; reason?: string } | null
      try {
        status = await this.provider.status(providerId)
      } catch {
        out.errors += 1
        await this.health.record(this.cfg.deviceId, { kind: 'poll_failed', at: now })
        break
      }
      await this.health.record(this.cfg.deviceId, { kind: 'poll_ok', at: now })
      if (status === null) {
        if (item.reconcileResends < r.maxResends && item.ttlAt.getTime() > now.getTime()) {
          await this.outbox.update(item.id, { state: 'pending', reconcileResends: item.reconcileResends + 1, nextAttemptAt: null, lastReconciledAt: now, lastError: 'device had no record of the message' })
          out.resent += 1
        } else {
          await this.outbox.update(item.id, { state: 'failed', failedAt: now, lastReconciledAt: now, lastError: 'device lost the message' })
        }
        out.updated += 1
        continue
      }
      await this.outbox.update(item.id, { lastReconciledAt: now })
      if (status.state === 'Delivered' && item.state !== 'delivered') {
        await this.outbox.update(item.id, { state: 'delivered', deliveredAt: now, sentAt: item.sentAt ?? now })
        out.updated += 1
      } else if (status.state === 'Sent' && item.state === 'accepted') {
        await this.outbox.update(item.id, { state: 'sent', sentAt: now })
        out.updated += 1
      } else if (status.state === 'Failed') {
        await this.applyDeviceFailure(item, status.reason ?? 'unknown', now)
        out.updated += 1
      }
    }
    return out
  }

  // ---- reporting -------------------------------------------------------------------------------------------------

  async status(): Promise<DispatcherStatus> {
    const now = this.clock.now()
    const evaluation = await this.health.evaluate(this.cfg.deviceId)
    const pending = await this.outbox.listPending()
    const usage = (await this.outbox.listUsage(new Date(now.getTime() - this.cfg.budget.windowMs))).map((u) => ({ at: u.at, segments: u.segments }))
    const queue = estimateQueue(pending, usage, now, this.cfg.budget, this.cfg.minIntervalMs, this.cfg.quietHours)
    const quiet = isQuietHour(now, this.cfg.quietHours)
    const head = pending.find((i) => !(quiet && !isTransactional(i.klass)))
    const blocked = head ? !canSpend(usage, now, head.segments, head.priority, this.cfg.budget) : false
    return {
      device: evaluation.state,
      rateLimited: blocked,
      resumesAt: head && blocked ? nextFit(usage, now, head.segments, head.priority, this.cfg.budget) : null,
      budget: snapshot(usage, now, this.cfg.budget),
      queue,
      heldByQuietHours: quiet ? pending.filter((i) => !isTransactional(i.klass)).length : 0,
    }
  }

  usedInWindow(usage: readonly { at: Date; segments: number }[], now: Date): number {
    return usedInWindow(usage, now, this.cfg.budget.windowMs)
  }
}
