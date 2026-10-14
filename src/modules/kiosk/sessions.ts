// Kiosk sessions (ADR 0180): server-side rows addressed by the sha256 of an opaque 256-bit token in the HttpOnly kiosk cookie, like
// user sessions (ADR 0008). A session is only valid together with the cookie of the live device it was made on, and only while kiosk
// mode is on; it ends at its lock time (absolute, no idle expiry) or when it is revoked (lock, lock all, the device locked or removed,
// kiosk mode off, a new unlock on the same device). It records whose PIN opened it (ADR 0180 amendment). Each request must also come
// from a shop network (A13: KioskService.resolveContext checks it after this lookup; the session is kept when it does not).
import { isIP } from 'node:net'
import { sql } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import type { Executor } from '../../platform/db.js'
import { hashToken, newCsrfSecret, newToken, TOKEN_SHAPE } from '../auth/tokens.js'
import type { KioskLockRule, KioskRevokeReason } from './schema.js'
import './schema.js'

/** last_seen_at is rewritten at most this often. */
export const KIOSK_TOUCH_MS = 60 * 1000

export interface KioskSessionRecord {
  id: string
  deviceId: string
  deviceName: string
  locationId: string
  openedBy: { employeeId: string | null; name: string }
  createdAt: Date
  expiresAt: Date
  lockRule: KioskLockRule
  csrfSecret: string
  lastSeenAt: Date
}

export const clientIp = (ip: string | null | undefined): string | null => (ip && isIP(ip) ? ip : null)
export const clientUa = (ua: string | null | undefined): string | null => (ua ? ua.slice(0, 400) : null)

/**
 * The live session behind the two cookies, or null: unknown token, revoked, past its lock time, its device revoked or not the device
 * whose cookie came with it, or kiosk mode off at its location.
 */
export async function lookupKioskSession(
  db: Executor,
  clock: Clock,
  tokens: { session: string | undefined; device: string | undefined },
  opts: { touch?: boolean } = {},
): Promise<KioskSessionRecord | null> {
  if (!tokens.session || !tokens.device) return null
  if (!TOKEN_SHAPE.test(tokens.session) || !TOKEN_SHAPE.test(tokens.device)) return null
  const id = hashToken(tokens.session)
  const row = await db
    .selectFrom('kiosk_sessions as s')
    .innerJoin('kiosk_devices as d', 'd.id', 's.device_id')
    .select([
      's.id',
      's.device_id',
      's.location_id',
      's.opened_by_employee_id',
      's.opened_by_name',
      's.created_at',
      's.expires_at',
      's.lock_rule',
      's.csrf_secret',
      's.last_seen_at',
      's.revoked_at',
      'd.name as device_name',
      'd.revoked_at as device_revoked_at',
      'd.location_id as device_location_id',
      sql<unknown>`(select st.value from settings st where st.location_id = s.location_id and st.key = 'kiosk.enabled')`.as(
        'enabled',
      ),
    ])
    .where('s.id', '=', id)
    .where('d.token_hash', '=', hashToken(tokens.device))
    .executeTakeFirst()
  if (!row || row.revoked_at || row.device_revoked_at || row.device_location_id !== row.location_id) return null
  if (row.enabled !== true) return null
  const now = clock.now().getTime()
  if (now >= row.expires_at.getTime()) return null
  const rec: KioskSessionRecord = {
    id: row.id,
    deviceId: row.device_id,
    deviceName: row.device_name,
    locationId: row.location_id,
    openedBy: { employeeId: row.opened_by_employee_id, name: row.opened_by_name },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lockRule: row.lock_rule,
    csrfSecret: row.csrf_secret,
    lastSeenAt: row.last_seen_at,
  }
  if (opts.touch !== false) await touchKioskSession(db, clock, rec)
  return rec
}

/** Marks the session and its browser as seen now (at most once a minute). */
export async function touchKioskSession(db: Executor, clock: Clock, rec: KioskSessionRecord): Promise<void> {
  const now = clock.now().getTime()
  if (now - rec.lastSeenAt.getTime() < KIOSK_TOUCH_MS) return
  const at = new Date(now)
  await db.updateTable('kiosk_sessions').set({ last_seen_at: at }).where('id', '=', rec.id).execute()
  await db.updateTable('kiosk_devices').set({ last_seen_at: at }).where('id', '=', rec.deviceId).execute()
  rec.lastSeenAt = at
}

export interface NewKioskSession {
  deviceId: string
  locationId: string
  /** Whose PIN opened it, and their name ("Marco R.") at the time. */
  openedBy: { employeeId: string; name: string }
  expiresAt: Date
  lockRule: KioskLockRule
  ip?: string | null
  ua?: string | null
}

/** Inserts a session; the token is returned once (the cookie), only its hash is stored. */
export async function createKioskSession(
  db: Executor,
  clock: Clock,
  s: NewKioskSession,
): Promise<{ token: string; id: string; csrfSecret: string; createdAt: Date }> {
  const token = newToken()
  const id = hashToken(token)
  const csrfSecret = newCsrfSecret()
  const now = clock.now()
  await db
    .insertInto('kiosk_sessions')
    .values({
      id,
      device_id: s.deviceId,
      location_id: s.locationId,
      opened_by_employee_id: s.openedBy.employeeId,
      opened_by_name: s.openedBy.name,
      created_at: now,
      last_seen_at: now,
      expires_at: s.expiresAt,
      lock_rule: s.lockRule,
      csrf_secret: csrfSecret,
      ip: clientIp(s.ip),
      ua: clientUa(s.ua),
    })
    .execute()
  return { token, id, csrfSecret, createdAt: now }
}

/** Revokes the live sessions matching `where`; returns how many. */
export async function revokeKioskSessions(
  db: Executor,
  clock: Clock,
  where: { id: string } | { deviceId: string } | { locationId: string },
  reason: KioskRevokeReason,
): Promise<number> {
  let q = db
    .updateTable('kiosk_sessions')
    .set({ revoked_at: clock.now(), revoked_reason: reason })
    .where('revoked_at', 'is', null)
  if ('id' in where) q = q.where('id', '=', where.id)
  else if ('deviceId' in where) q = q.where('device_id', '=', where.deviceId)
  else q = q.where('location_id', '=', where.locationId)
  const r = await q.executeTakeFirst()
  return Number(r.numUpdatedRows)
}

/**
 * Ends the signed-in (user) sessions opened on, or tied to, kiosk devices (sessions.kiosk_device_id): a manager on the shared tablet
 * is signed out by the same controls that lock it. Returns the ids of the sessions it ended.
 */
export async function revokeUserSessionsOnKiosks(
  db: Executor,
  clock: Clock,
  where: { deviceId: string } | { locationId: string },
): Promise<string[]> {
  const rows = await db
    .updateTable('sessions')
    .set({ revoked_at: clock.now() })
    .where('revoked_at', 'is', null)
    .where('kiosk_device_id', 'in', (eb) => {
      const q = eb.selectFrom('kiosk_devices').select('id')
      return 'deviceId' in where ? q.where('id', '=', where.deviceId) : q.where('location_id', '=', where.locationId)
    })
    .returning('id')
    .execute()
  return rows.map((r) => r.id)
}

/** Housekeeping: drops sessions that ended (lock time or revoked) more than 30 days ago. */
export async function purgeKioskSessions(db: Executor, clock: Clock): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - 30 * 24 * 60 * 60 * 1000)
  const r = await db
    .deleteFrom('kiosk_sessions')
    .where((eb) => eb.or([eb('expires_at', '<', cutoff), eb('revoked_at', '<', cutoff)]))
    .executeTakeFirst()
  return Number(r.numDeletedRows)
}
