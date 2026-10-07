import { randomBytes } from 'node:crypto'
import type { Selectable } from 'kysely'
import type { Clock } from '../../../platform/clock.js'
import type { Executor } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import type { NewId } from '../../../platform/ids.js'
import type { SecretBox } from '../crypto.js'
import type { SmsDeviceProviderKind, SmsDevicesTable } from '../schema.js'
import '../schema.js'

export type DeviceRow = Selectable<SmsDevicesTable>

/** A device as the API shows it: never any secret, only whether one is stored. */
export interface DeviceView {
  id: string
  key: string
  label: string
  provider: SmsDeviceProviderKind
  baseUrl: string | null
  username: string | null
  hasPassword: boolean
  simSlotDefault: number | null
  minIntervalMs: number | null
  maxPerWindow: number | null
  windowMinutes: number | null
  enabled: boolean
  status: DeviceRow['status']
  stateChangedAt: string | null
  lastSeenAt: string | null
  lastPingAt: string | null
  lastAppStartedAt: string | null
  lastPollOkAt: string | null
  consecutivePollFailures: number
  healthStatus: DeviceRow['health_status']
  battery: number | null
  charging: boolean | null
  lastError: string | null
  webhooksUrl: string | null
  webhooksRegisteredAt: string | null
  counters: { sent: number; delivered: number; failed: number; received: number }
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

export function deviceView(r: DeviceRow): DeviceView {
  return {
    id: r.id,
    key: r.device_key,
    label: r.label,
    provider: r.provider,
    baseUrl: r.base_url,
    username: r.username,
    hasPassword: r.password_enc !== null,
    simSlotDefault: r.sim_slot_default,
    minIntervalMs: r.min_interval_ms,
    maxPerWindow: r.max_per_window,
    windowMinutes: r.window_minutes,
    enabled: r.enabled,
    status: r.status,
    stateChangedAt: iso(r.state_changed_at),
    lastSeenAt: iso(r.last_seen_at),
    lastPingAt: iso(r.last_ping_at),
    lastAppStartedAt: iso(r.last_app_started_at),
    lastPollOkAt: iso(r.last_poll_ok_at),
    consecutivePollFailures: r.consecutive_poll_failures,
    healthStatus: r.health_status,
    battery: r.battery,
    charging: r.charging,
    lastError: r.last_error,
    webhooksUrl: r.webhooks_url,
    webhooksRegisteredAt: iso(r.webhooks_registered_at),
    counters: { sent: r.sent_count, delivered: r.delivered_count, failed: r.failed_count, received: r.received_count },
  }
}

export interface DeviceSecrets {
  password: string | null
  webhookSecret: string
}

export interface NewDevice {
  label: string
  provider: SmsDeviceProviderKind
  baseUrl?: string | null
  username?: string | null
  password?: string | null
  /** Omit to have one generated (returned once by create). */
  webhookSecret?: string
  deviceKey?: string
  simSlotDefault?: number | null
  minIntervalMs?: number | null
  maxPerWindow?: number | null
  windowMinutes?: number | null
  enabled?: boolean
}

export type DevicePatch = Partial<Omit<NewDevice, 'provider' | 'deviceKey'>>

export const newDeviceKey = (): string => randomBytes(18).toString('base64url')
export const newWebhookSecret = (): string => randomBytes(32).toString('base64url')

/** sms_devices CRUD with credentials encrypted at rest. */
export class DeviceStore {
  constructor(
    private readonly exec: Executor,
    private readonly box: SecretBox,
    private readonly o: { clock: Clock; newId: NewId },
  ) {}

  /** The same store bound to another executor (a transaction). */
  forExecutor(exec: Executor): DeviceStore {
    return new DeviceStore(exec, this.box, this.o)
  }

  list(locationId: string): Promise<DeviceRow[]> {
    return this.exec.selectFrom('sms_devices').selectAll().where('location_id', '=', locationId).orderBy('created_at').orderBy('id').execute()
  }

  async listEnabled(locationId?: string): Promise<DeviceRow[]> {
    let q = this.exec.selectFrom('sms_devices').selectAll().where('enabled', '=', true)
    if (locationId) q = q.where('location_id', '=', locationId)
    return q.orderBy('created_at').orderBy('id').execute()
  }

  async get(id: string): Promise<DeviceRow | null> {
    return (await this.exec.selectFrom('sms_devices').selectAll().where('id', '=', id).executeTakeFirst()) ?? null
  }

  async getByKey(key: string): Promise<DeviceRow | null> {
    return (await this.exec.selectFrom('sms_devices').selectAll().where('device_key', '=', key).executeTakeFirst()) ?? null
  }

  secrets(r: DeviceRow): DeviceSecrets {
    return { password: r.password_enc ? this.box.decrypt(r.password_enc) : null, webhookSecret: this.box.decrypt(r.webhook_secret_enc) }
  }

  async create(locationId: string, d: NewDevice): Promise<{ device: DeviceRow; webhookSecret: string }> {
    if (d.provider === 'smsgate' && (!d.baseUrl || !d.username || !d.password))
      throw new AppError('VALIDATION_FAILED', { errors: [{ path: 'baseUrl', message: 'An SMS Gate device needs its URL, username and password' }] })
    const webhookSecret = d.webhookSecret ?? newWebhookSecret()
    const now = this.o.clock.now()
    const row = await this.exec
      .insertInto('sms_devices')
      .values({
        id: this.o.newId(),
        location_id: locationId,
        device_key: d.deviceKey ?? newDeviceKey(),
        label: d.label,
        provider: d.provider,
        base_url: d.baseUrl ?? null,
        username: d.username ?? null,
        password_enc: d.password ? this.box.encrypt(d.password) : null,
        webhook_secret_enc: this.box.encrypt(webhookSecret),
        remote_device_id: null,
        sim_slot_default: d.simSlotDefault ?? null,
        min_interval_ms: d.minIntervalMs ?? null,
        max_per_window: d.maxPerWindow ?? null,
        window_minutes: d.windowMinutes ?? null,
        enabled: d.enabled ?? true,
        state_changed_at: null,
        last_seen_at: null,
        last_ping_at: null,
        last_app_started_at: null,
        last_poll_ok_at: null,
        health_status: null,
        battery: null,
        charging: null,
        last_health: null,
        last_error: null,
        webhooks_url: null,
        webhooks_registered_at: null,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    return { device: row, webhookSecret }
  }

  async update(id: string, p: DevicePatch): Promise<DeviceRow | null> {
    const set: Record<string, unknown> = { updated_at: this.o.clock.now() }
    if (p.label !== undefined) set.label = p.label
    if (p.baseUrl !== undefined) set.base_url = p.baseUrl
    if (p.username !== undefined) set.username = p.username
    if (p.password !== undefined) set.password_enc = p.password ? this.box.encrypt(p.password) : null
    if (p.webhookSecret !== undefined) set.webhook_secret_enc = this.box.encrypt(p.webhookSecret)
    if (p.simSlotDefault !== undefined) set.sim_slot_default = p.simSlotDefault
    if (p.minIntervalMs !== undefined) set.min_interval_ms = p.minIntervalMs
    if (p.maxPerWindow !== undefined) set.max_per_window = p.maxPerWindow
    if (p.windowMinutes !== undefined) set.window_minutes = p.windowMinutes
    if (p.enabled !== undefined) set.enabled = p.enabled
    const row = await this.exec.updateTable('sms_devices').set(set as never).where('id', '=', id).returningAll().executeTakeFirst()
    return row ?? null
  }

  async noteRemoteId(id: string, remote: string): Promise<void> {
    await this.exec.updateTable('sms_devices').set({ remote_device_id: remote }).where('id', '=', id).where((eb) => eb.or([eb('remote_device_id', 'is', null), eb('remote_device_id', '!=', remote)])).execute()
  }

  async noteRegistered(id: string, url: string, at: Date): Promise<void> {
    await this.exec.updateTable('sms_devices').set({ webhooks_url: url, webhooks_registered_at: at, last_error: null }).where('id', '=', id).execute()
  }

  async noteError(id: string, error: string | null): Promise<void> {
    await this.exec.updateTable('sms_devices').set({ last_error: error }).where('id', '=', id).execute()
  }

  async bumpReceived(id: string): Promise<void> {
    await this.exec.updateTable('sms_devices').set((eb) => ({ received_count: eb('received_count', '+', 1) })).where('id', '=', id).execute()
  }
}
