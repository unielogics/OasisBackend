import type { Clock } from '../../../platform/clock.js'
import type { DeviceRecord, DeviceRepository, DeviceState } from './types.js'

// Health state machine for the one SMS tablet.
//
//   online    heard from recently, no complaints
//   degraded  alive but something is off (quiet for a while, a failed poll, low battery, warn/fail health)
//   offline   silent for too long or several polls in a row failed: the queue holds, TTLs keep running
//
// "Heard from" is any signal: a system:ping or app:started webhook, a successful health poll, a successful send.

export interface HealthConfig {
  /** Heard from within this long counts as online. Design: 3 minutes (poll every minute). */
  onlineWithinMs: number
  /** Silent for longer than this is offline (SMSGATE_HEARTBEAT_STALE_SECONDS). */
  offlineAfterMs: number
  /** This many consecutive failed polls or sends is offline regardless of other signals. */
  failuresToOffline: number
  /** Below this battery percent and not on power is degraded. */
  lowBatteryPct: number
}

export const DEFAULT_HEALTH: HealthConfig = {
  onlineWithinMs: 3 * 60_000,
  offlineAfterMs: 10 * 60_000,
  failuresToOffline: 3,
  lowBatteryPct: 15,
}

export type HealthSignal =
  | { kind: 'ping'; at: Date; healthStatus?: 'pass' | 'warn' | 'fail'; battery?: number; charging?: boolean }
  | { kind: 'app_started'; at: Date }
  | { kind: 'poll_ok'; at: Date; healthStatus?: 'pass' | 'warn' | 'fail'; battery?: number; charging?: boolean }
  | { kind: 'poll_failed'; at: Date }

export interface HealthEvaluation {
  state: DeviceState
  previous: DeviceState
  changed: boolean
  reason: string
  /** True when this evaluation was triggered by an app:started signal: re-register webhooks. */
  appStarted: boolean
  record: DeviceRecord
}

export function freshRecord(id: string): DeviceRecord {
  return {
    id,
    state: 'unknown',
    stateChangedAt: null,
    lastSeenAt: null,
    lastPingAt: null,
    lastAppStartedAt: null,
    lastPollOkAt: null,
    consecutivePollFailures: 0,
    healthStatus: null,
    battery: null,
    charging: null,
  }
}

/** Pure: the state a record implies at `now`, with the reason. */
export function computeDeviceState(rec: DeviceRecord, now: Date, cfg: HealthConfig): { state: DeviceState; reason: string } {
  if (rec.consecutivePollFailures >= cfg.failuresToOffline) return { state: 'offline', reason: `${rec.consecutivePollFailures} consecutive failures` }
  if (rec.lastSeenAt === null) return { state: rec.consecutivePollFailures > 0 ? 'degraded' : 'unknown', reason: 'no signal yet' }
  const age = now.getTime() - rec.lastSeenAt.getTime()
  if (age > cfg.offlineAfterMs) return { state: 'offline', reason: `silent for ${Math.round(age / 1000)}s` }
  if (age > cfg.onlineWithinMs) return { state: 'degraded', reason: `quiet for ${Math.round(age / 1000)}s` }
  if (rec.consecutivePollFailures > 0) return { state: 'degraded', reason: 'last poll failed' }
  if (rec.healthStatus === 'fail') return { state: 'degraded', reason: 'device reports failing health' }
  if (rec.healthStatus === 'warn') return { state: 'degraded', reason: 'device reports a health warning' }
  if (rec.battery !== null && rec.battery < cfg.lowBatteryPct && rec.charging !== true) return { state: 'degraded', reason: `battery ${rec.battery}% and not charging` }
  return { state: 'online', reason: 'recent signal' }
}

export type TransitionListener = (e: HealthEvaluation) => void

export class DeviceHealthMonitor {
  private readonly listeners: TransitionListener[] = []

  constructor(
    private readonly devices: DeviceRepository,
    private readonly clock: Clock,
    private readonly cfg: HealthConfig = DEFAULT_HEALTH,
  ) {}

  /** Called on every state change (alerting, SSE, e-mail fallback). */
  onTransition(listener: TransitionListener): void {
    this.listeners.push(listener)
  }

  private async load(id: string): Promise<DeviceRecord> {
    return (await this.devices.get(id)) ?? freshRecord(id)
  }

  private async settle(rec: DeviceRecord, appStarted: boolean): Promise<HealthEvaluation> {
    const now = this.clock.now()
    const { state, reason } = computeDeviceState(rec, now, this.cfg)
    const previous = rec.state
    const changed = state !== previous
    if (changed) {
      rec.state = state
      rec.stateChangedAt = now
    }
    await this.devices.save(rec)
    const evaluation: HealthEvaluation = { state, previous, changed, reason, appStarted, record: rec }
    if (changed) for (const l of this.listeners) l(evaluation)
    return evaluation
  }

  async record(deviceId: string, signal: HealthSignal): Promise<HealthEvaluation> {
    const rec = await this.load(deviceId)
    const touch = (): void => {
      if (rec.lastSeenAt === null || signal.at > rec.lastSeenAt) rec.lastSeenAt = signal.at
    }
    switch (signal.kind) {
      case 'ping':
        touch()
        rec.lastPingAt = signal.at
        break
      case 'app_started':
        touch()
        rec.lastAppStartedAt = signal.at
        break
      case 'poll_ok':
        touch()
        rec.lastPollOkAt = signal.at
        rec.consecutivePollFailures = 0
        break
      case 'poll_failed':
        rec.consecutivePollFailures += 1
        break
    }
    if (signal.kind === 'ping' || signal.kind === 'poll_ok') {
      if (signal.healthStatus !== undefined) rec.healthStatus = signal.healthStatus
      if (signal.battery !== undefined) rec.battery = signal.battery
      if (signal.charging !== undefined) rec.charging = signal.charging
    }
    return this.settle(rec, signal.kind === 'app_started')
  }

  /** Re-evaluates with the current time (silence turns online into degraded into offline without any signal). */
  async evaluate(deviceId: string): Promise<HealthEvaluation> {
    return this.settle(await this.load(deviceId), false)
  }
}
