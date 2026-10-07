import type { Executor, Tx } from '../../../platform/db.js'
import type { DeviceRecord, DeviceRepository, DeviceState } from '../dispatch/types.js'
import { inTx } from './exec.js'
import '../schema.js'

export interface DeviceTransition {
  deviceId: string
  from: DeviceState
  to: DeviceState
  record: DeviceRecord
}

/** Called inside the saving transaction when a save changes the device's state (notifications, SSE, alerts). */
export type TransitionEffects = (tx: Tx, t: DeviceTransition) => Promise<void>

/** DeviceRecord persistence on sms_devices. A save that changes the state runs the transition effects atomically with it. */
export class PgDeviceRepository implements DeviceRepository {
  constructor(
    private readonly exec: Executor,
    private readonly effects?: TransitionEffects,
  ) {}

  async get(id: string): Promise<DeviceRecord | null> {
    const r = await this.exec
      .selectFrom('sms_devices')
      .select([
        'id',
        'status',
        'state_changed_at',
        'last_seen_at',
        'last_ping_at',
        'last_app_started_at',
        'last_poll_ok_at',
        'consecutive_poll_failures',
        'health_status',
        'battery',
        'charging',
      ])
      .where('id', '=', id)
      .executeTakeFirst()
    if (!r) return null
    return {
      id: r.id,
      state: r.status,
      stateChangedAt: r.state_changed_at,
      lastSeenAt: r.last_seen_at,
      lastPingAt: r.last_ping_at,
      lastAppStartedAt: r.last_app_started_at,
      lastPollOkAt: r.last_poll_ok_at,
      consecutivePollFailures: r.consecutive_poll_failures,
      healthStatus: r.health_status,
      battery: r.battery,
      charging: r.charging,
    }
  }

  async save(record: DeviceRecord): Promise<void> {
    await inTx(this.exec, async (tx) => {
      const prev = await tx
        .selectFrom('sms_devices')
        .select(['status', 'state_changed_at', 'last_seen_at', 'last_ping_at', 'last_app_started_at', 'last_poll_ok_at', 'consecutive_poll_failures', 'health_status', 'battery', 'charging'])
        .where('id', '=', record.id)
        .forUpdate()
        .executeTakeFirst()
      if (!prev) return
      const same =
        prev.status === record.state &&
        same2(prev.state_changed_at, record.stateChangedAt) &&
        same2(prev.last_seen_at, record.lastSeenAt) &&
        same2(prev.last_ping_at, record.lastPingAt) &&
        same2(prev.last_app_started_at, record.lastAppStartedAt) &&
        same2(prev.last_poll_ok_at, record.lastPollOkAt) &&
        prev.consecutive_poll_failures === record.consecutivePollFailures &&
        prev.health_status === record.healthStatus &&
        prev.battery === record.battery &&
        prev.charging === record.charging
      if (same) return
      await tx
        .updateTable('sms_devices')
        .set({
          status: record.state,
          state_changed_at: record.stateChangedAt,
          last_seen_at: record.lastSeenAt,
          last_ping_at: record.lastPingAt,
          last_app_started_at: record.lastAppStartedAt,
          last_poll_ok_at: record.lastPollOkAt,
          consecutive_poll_failures: record.consecutivePollFailures,
          health_status: record.healthStatus,
          battery: record.battery,
          charging: record.charging,
        })
        .where('id', '=', record.id)
        .execute()
      if (prev.status !== record.state && this.effects) await this.effects(tx, { deviceId: record.id, from: prev.status, to: record.state, record })
    })
  }
}

const same2 = (a: Date | null, b: Date | null): boolean => (a === null || b === null ? a === b : a.getTime() === b.getTime())
