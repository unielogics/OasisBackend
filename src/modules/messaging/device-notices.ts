// Manager notices about the SMS channel that can repeat, debounced through `notice_debounce` (ADR 0122):
//   - the device went offline / came back: at most one notice of each kind per device per FLAP_WINDOW_MS. A change held back
//     inside the window still shows live (SSE) and is announced when the window closes if the device did not end where the
//     last notice left it (catchUpDeviceNotices, run by the per-minute health poll);
//   - the SMS app restarted while the tablet stayed reachable (an `app:started` without a reboot: Android killed the app);
//   - texts are waiting and no SMS device is enabled: once per episode, repeated every NO_DEVICE_REPEAT_MS while it lasts.
// Everything runs inside the caller's transaction.
import { sql } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import type { Executor, Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import * as realtime from '../../platform/realtime.js'
import type { DeviceTransition } from './db/device-repo.js'
import type { DeviceRow } from './db/devices.js'
import { notifyManagers, publishToManagers, type NoticeSpec } from './notify.js'
import './schema.js'

export const FLAP_WINDOW_MS = 30 * 60_000
/** An app:started this soon after the tablet was last heard from, with no failed poll in between, was not a reboot. */
export const APP_RESTART_QUIET_MS = 90_000
export const NO_DEVICE_REPEAT_MS = 6 * 3600_000

export interface NoticeDeps {
  clock: Clock
  newId: NewId
}

type Coarse = 'offline' | 'online'

interface DebounceRow {
  state: string | null
  last_sent_at: Date | null
  suppressed: number
}

async function readRow(db: Executor, locationId: string, key: string): Promise<DebounceRow | undefined> {
  return db
    .selectFrom('notice_debounce')
    .select(['state', 'last_sent_at', 'suppressed'])
    .where('location_id', '=', locationId)
    .where('key', '=', key)
    .executeTakeFirst()
}

async function writeRow(
  tx: Tx,
  locationId: string,
  key: string,
  patch: { state?: string | null; lastSentAt?: Date; suppressed?: number | 'increment' },
  now: Date,
): Promise<void> {
  const suppressed =
    patch.suppressed === 'increment'
      ? sql<number>`notice_debounce.suppressed + 1`
      : patch.suppressed !== undefined
        ? sql<number>`${patch.suppressed}`
        : sql<number>`notice_debounce.suppressed`
  await sql`
    insert into notice_debounce (location_id, key, state, last_sent_at, suppressed, updated_at)
    values (${locationId}, ${key}, ${patch.state ?? null}, ${patch.lastSentAt ?? null},
      ${patch.suppressed === 'increment' ? 1 : (patch.suppressed ?? 0)}, ${now})
    on conflict (location_id, key) do update set
      state = ${patch.state !== undefined ? sql`excluded.state` : sql`notice_debounce.state`},
      last_sent_at = ${patch.lastSentAt !== undefined ? sql`excluded.last_sent_at` : sql`notice_debounce.last_sent_at`},
      suppressed = ${suppressed},
      updated_at = excluded.updated_at`.execute(tx)
}

/** Sent less than `ms` ago (a mark in the future, after a clock correction, does not hold anything back). */
const within = (at: Date | null | undefined, now: Date, ms: number): boolean => {
  if (at === null || at === undefined) return false
  const age = now.getTime() - at.getTime()
  return age >= 0 && age < ms
}

const deviceKey = (deviceId: string, part: string): string => `sms.device:${deviceId}:${part}`

function deviceSpec(
  dev: { id: string; location_id: string; label: string },
  kind: Coarse,
  payload: Record<string, string>,
  held: number,
): NoticeSpec {
  const again =
    held > 0 ? ` It changed ${held} more time${held === 1 ? '' : 's'} in the last 30 minutes.` : ''
  return kind === 'offline'
    ? {
        locationId: dev.location_id,
        kind: 'sms.device_offline',
        title: 'SMS device offline',
        body: `${dev.label} stopped responding. Texts wait in the queue until it is back.${again}`,
        entityType: 'sms_device',
        entityId: dev.id,
        event: { type: 'sms.device.health', payload },
      }
    : {
        locationId: dev.location_id,
        kind: 'sms.device_recovered',
        title: 'SMS device back online',
        body: `${dev.label} is responding again. Queued texts are being sent.${again}`,
        entityType: 'sms_device',
        entityId: dev.id,
        event: { type: 'sms.device.health', payload },
      }
}

/** Sends the offline / back-online notice unless one of that kind went out within the window. Returns whether it was sent. */
async function announce(
  tx: Tx,
  d: NoticeDeps,
  dev: { id: string; location_id: string; label: string },
  kind: Coarse,
  payload: Record<string, string>,
): Promise<boolean> {
  const now = d.clock.now()
  const key = deviceKey(dev.id, kind)
  const last = await readRow(tx, dev.location_id, key)
  if (within(last?.last_sent_at, now, FLAP_WINDOW_MS)) {
    await writeRow(tx, dev.location_id, key, { suppressed: 'increment' }, now)
    return false
  }
  const other = await readRow(
    tx,
    dev.location_id,
    deviceKey(dev.id, kind === 'offline' ? 'online' : 'offline'),
  )
  const held = (last?.suppressed ?? 0) + (other?.suppressed ?? 0)
  await notifyManagers(tx, deviceSpec(dev, kind, payload, held), d)
  await writeRow(tx, dev.location_id, key, { lastSentAt: now, suppressed: 0 }, now)
  await writeRow(
    tx,
    dev.location_id,
    deviceKey(dev.id, kind === 'offline' ? 'online' : 'offline'),
    { suppressed: 0 },
    now,
  )
  await writeRow(tx, dev.location_id, deviceKey(dev.id, 'state'), { state: kind }, now)
  return true
}

/** The device-state change effects: debounced notices for offline / back online, live SSE for every change. */
export async function onDeviceTransition(tx: Tx, d: NoticeDeps, t: DeviceTransition): Promise<void> {
  const dev = await tx
    .selectFrom('sms_devices')
    .select(['id', 'location_id', 'label'])
    .where('id', '=', t.deviceId)
    .executeTakeFirst()
  if (!dev) return
  const payload = { deviceId: t.deviceId, label: dev.label, from: t.from, to: t.to }
  const kind: Coarse | null = t.to === 'offline' ? 'offline' : t.from === 'offline' ? 'online' : null
  const sent = kind ? await announce(tx, d, dev, kind, payload) : false
  if (!sent && (kind !== null || t.from !== 'unknown'))
    await publishToManagers(tx, dev.location_id, 'sms.device.health', payload)
  await realtime.publish(tx, {
    locationId: dev.location_id,
    channel: 'ops',
    type: 'alerts.changed',
    payload: { source: 'sms', kind: 'device_health' },
  })
}

/**
 * When the device ended a flapping window somewhere other than where the last notice left it (offline after a "back online",
 * or the reverse), says so once the window allows. Called by the health poll for every enabled device.
 */
export async function catchUpDeviceNotices(tx: Tx, d: NoticeDeps, device: DeviceRow): Promise<boolean> {
  const fresh = await tx
    .selectFrom('sms_devices')
    .select(['id', 'location_id', 'label', 'status'])
    .where('id', '=', device.id)
    .executeTakeFirst()
  if (!fresh || fresh.status === 'unknown') return false
  const announced = (await readRow(tx, fresh.location_id, deviceKey(fresh.id, 'state')))?.state
  if (announced !== 'offline' && announced !== 'online') return false
  const current: Coarse = fresh.status === 'offline' ? 'offline' : 'online'
  if (current === announced) return false
  return announce(tx, d, fresh, current, {
    deviceId: fresh.id,
    label: fresh.label,
    from: announced,
    to: fresh.status,
  })
}

/**
 * An `app:started` from a tablet that was heard from moments ago with no failed poll in between: the app was restarted
 * without a reboot (Android or the vendor's battery manager killed it). Managers are told once per window.
 */
export async function noteAppStarted(
  tx: Tx,
  d: NoticeDeps,
  before: Pick<
    DeviceRow,
    'id' | 'location_id' | 'label' | 'status' | 'last_seen_at' | 'consecutive_poll_failures'
  >,
  at: Date,
): Promise<boolean> {
  const seen = before.last_seen_at
  const quiet = seen ? at.getTime() - seen.getTime() : Infinity
  const unexpected =
    before.consecutive_poll_failures === 0 &&
    before.status !== 'offline' &&
    quiet >= 0 &&
    quiet <= APP_RESTART_QUIET_MS
  if (!unexpected) return false
  const now = d.clock.now()
  const key = `sms.app_restarted:${before.id}`
  const last = await readRow(tx, before.location_id, key)
  if (within(last?.last_sent_at, now, FLAP_WINDOW_MS)) {
    await writeRow(tx, before.location_id, key, { suppressed: 'increment' }, now)
    return false
  }
  await notifyManagers(
    tx,
    {
      locationId: before.location_id,
      kind: 'sms.app_restarted',
      title: 'SMS app restarted',
      body: `The SMS app on ${before.label} restarted while the tablet stayed online, which usually means Android stopped it. Set the app's battery use to Unrestricted and allow it to start on its own.`,
      entityType: 'sms_device',
      entityId: before.id,
    },
    d,
  )
  await writeRow(tx, before.location_id, key, { lastSentAt: now, suppressed: 0 }, now)
  return true
}

/**
 * Texts waiting and no SMS device enabled: tells managers once per episode (again every NO_DEVICE_REPEAT_MS while it lasts);
 * the episode ends when a device is enabled or the queue empties. Returns whether a notice was sent.
 */
export async function checkNoDevice(tx: Tx, d: NoticeDeps, locationId: string): Promise<boolean> {
  const now = d.clock.now()
  const key = 'sms.no_device'
  const enabled = await tx
    .selectFrom('sms_devices')
    .select('id')
    .where('location_id', '=', locationId)
    .where('enabled', '=', true)
    .executeTakeFirst()
  const waiting = enabled
    ? 0
    : Number(
        (
          await sql<{
            n: number
          }>`select count(*)::int as n from sms_outbox o join messages m on m.id = o.message_id
            where m.location_id = ${locationId} and o.state = 'pending'`.execute(tx)
        ).rows[0]?.n ?? 0,
      )
  const row = await readRow(tx, locationId, key)
  if (waiting === 0) {
    if (row?.state === 'open') await writeRow(tx, locationId, key, { state: 'closed', suppressed: 0 }, now)
    return false
  }
  if (row?.state === 'open' && within(row.last_sent_at, now, NO_DEVICE_REPEAT_MS)) return false
  await notifyManagers(
    tx,
    {
      locationId,
      kind: 'sms.no_device',
      title: 'No SMS device',
      body: `${waiting} text${waiting === 1 ? ' is' : 's are'} waiting to be sent and no SMS device is enabled. Enable the tablet in Settings, or add one.`,
      entityType: null,
      entityId: null,
    },
    d,
  )
  await writeRow(tx, locationId, key, { state: 'open', lastSentAt: now, suppressed: 0 }, now)
  return true
}
