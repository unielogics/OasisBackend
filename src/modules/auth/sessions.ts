// Server-side sessions. The cookie carries an opaque 256-bit token; the row id is its sha256. Idle expiry slides (12 h),
// absolute expiry does not (14 d). Login always issues a fresh session (rotation); a password change or deactivation
// revokes sessions.
import { isIP } from 'node:net'
import type { Clock } from '../../platform/clock.js'
import type { Executor } from '../../platform/db.js'
import { csrfTokenFor, hashToken, newCsrfSecret, newToken, TOKEN_SHAPE } from './tokens.js'

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000
export const SESSION_ABSOLUTE_MS = 14 * 24 * 60 * 60 * 1000
/** last_seen_at / idle_expires_at are rewritten at most this often per session. */
export const SESSION_TOUCH_MS = 60 * 1000

export interface SessionTimings {
  idleMs: number
  absoluteMs: number
}

export const DEFAULT_SESSION_TIMINGS: SessionTimings = {
  idleMs: SESSION_IDLE_MS,
  absoluteMs: SESSION_ABSOLUTE_MS,
}

/** A manager who signs in on a registered kiosk device (ADR 0180): 15 minutes idle, 4 hours at most, and a banner. */
export const KIOSK_ADMIN_SESSION_TIMINGS: SessionTimings = {
  idleMs: 15 * 60 * 1000,
  absoluteMs: 4 * 60 * 60 * 1000,
}

export interface CreatedSession {
  token: string
  id: string
  csrfToken: string
  expiresAt: Date
}

export interface SessionRecord {
  id: string
  userId: string
  csrfSecret: string
  viewAsRoleId: string | null
  absoluteExpiresAt: Date
  user: { email: string; disabledAt: Date | null }
  employee: {
    id: string
    first: string
    last: string
    title: string
    phone: string
    email: string | null
    avatarColor: string | null
    status: string
  }
  locationId: string | null
  rbacVersion: number
  /** The kiosk device the session was opened on (short timings), or null. */
  kioskDevice: { id: string; name: string } | null
}

export class SessionService {
  constructor(
    private readonly db: Executor,
    private readonly clock: Clock,
    private readonly timings: SessionTimings = DEFAULT_SESSION_TIMINGS,
  ) {}

  /** `kioskDeviceId`: the session is opened on a registered kiosk device and gets the short kiosk-admin timings. */
  async create(
    userId: string,
    meta: { ip?: string | null; ua?: string | null; kioskDeviceId?: string | null },
    db: Executor = this.db,
  ): Promise<CreatedSession> {
    const now = this.clock.now()
    const token = newToken()
    const id = hashToken(token)
    const timings = this.timingsFor(meta.kioskDeviceId ?? null)
    const absolute = new Date(now.getTime() + timings.absoluteMs)
    const idle = new Date(Math.min(now.getTime() + timings.idleMs, absolute.getTime()))
    const csrfSecret = newCsrfSecret()
    await db
      .insertInto('sessions')
      .values({
        id,
        user_id: userId,
        last_seen_at: now,
        idle_expires_at: idle,
        absolute_expires_at: absolute,
        ip: meta.ip && isIP(meta.ip) ? meta.ip : null,
        ua: meta.ua ? meta.ua.slice(0, 400) : null,
        csrf_secret: csrfSecret,
        kiosk_device_id: meta.kioskDeviceId ?? null,
      })
      .execute()
    return { token, id, csrfToken: csrfTokenFor(csrfSecret, id), expiresAt: absolute }
  }

  /** The service's timings, or the shorter of them and the kiosk-admin timings on a kiosk device. */
  private timingsFor(kioskDeviceId: string | null): SessionTimings {
    if (!kioskDeviceId) return this.timings
    return {
      idleMs: Math.min(this.timings.idleMs, KIOSK_ADMIN_SESSION_TIMINGS.idleMs),
      absoluteMs: Math.min(this.timings.absoluteMs, KIOSK_ADMIN_SESSION_TIMINGS.absoluteMs),
    }
  }

  /** The live session behind a cookie token, or null when unknown, revoked, expired, or its user/employee is inactive. */
  async lookup(token: string, opts: { touch?: boolean } = {}): Promise<SessionRecord | null> {
    if (!TOKEN_SHAPE.test(token)) return null
    const id = hashToken(token)
    const row = await this.db
      .selectFrom('sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .innerJoin('employees as e', 'e.id', 'u.employee_id')
      .leftJoin('kiosk_devices as kd', 'kd.id', 's.kiosk_device_id')
      .select((eb) => [
        'kd.id as kiosk_device_id',
        'kd.name as kiosk_device_name',
        's.id',
        's.user_id',
        's.csrf_secret',
        's.view_as_role_id',
        's.last_seen_at',
        's.idle_expires_at',
        's.absolute_expires_at',
        's.revoked_at',
        'u.email as user_email',
        'u.disabled_at',
        'e.id as employee_id',
        'e.first',
        'e.last',
        'e.title',
        'e.phone',
        'e.email as employee_email',
        'e.avatar_color',
        'e.status',
        eb
          .selectFrom('employee_locations as el')
          .select('el.location_id')
          .whereRef('el.employee_id', '=', 'e.id')
          .orderBy('el.location_id')
          .limit(1)
          .as('location_id'),
        eb.selectFrom('rbac_state').select('version').as('rbac_version'),
      ])
      .where('s.id', '=', id)
      .executeTakeFirst()
    if (!row || row.revoked_at) return null
    const now = this.clock.now().getTime()
    if (now >= row.idle_expires_at.getTime() || now >= row.absolute_expires_at.getTime()) return null
    if (row.disabled_at || row.status !== 'active') return null

    if (opts.touch !== false && now - row.last_seen_at.getTime() >= SESSION_TOUCH_MS) {
      const idle = new Date(
        Math.min(now + this.timingsFor(row.kiosk_device_id).idleMs, row.absolute_expires_at.getTime()),
      )
      await this.db
        .updateTable('sessions')
        .set({ last_seen_at: new Date(now), idle_expires_at: idle })
        .where('id', '=', id)
        .where('revoked_at', 'is', null)
        .execute()
    }
    return {
      id,
      userId: row.user_id,
      csrfSecret: row.csrf_secret,
      viewAsRoleId: row.view_as_role_id,
      absoluteExpiresAt: row.absolute_expires_at,
      user: { email: row.user_email, disabledAt: row.disabled_at },
      employee: {
        id: row.employee_id,
        first: row.first,
        last: row.last,
        title: row.title,
        phone: row.phone,
        email: row.employee_email,
        avatarColor: row.avatar_color,
        status: row.status,
      },
      locationId: row.location_id,
      rbacVersion: Number(row.rbac_version ?? 1),
      kioskDevice:
        row.kiosk_device_id && row.kiosk_device_name ? { id: row.kiosk_device_id, name: row.kiosk_device_name } : null,
    }
  }

  async revoke(id: string, db: Executor = this.db): Promise<void> {
    await db
      .updateTable('sessions')
      .set({ revoked_at: this.clock.now() })
      .where('id', '=', id)
      .where('revoked_at', 'is', null)
      .execute()
  }

  /** Revokes every live session of the user, optionally keeping one (the caller's own after a password change). */
  async revokeAllForUser(userId: string, exceptId?: string | null, db: Executor = this.db): Promise<number> {
    let q = db
      .updateTable('sessions')
      .set({ revoked_at: this.clock.now() })
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
    if (exceptId) q = q.where('id', '!=', exceptId)
    const r = await q.executeTakeFirst()
    return Number(r.numUpdatedRows)
  }

  async setViewAs(id: string, roleId: string | null, db: Executor = this.db): Promise<void> {
    await db.updateTable('sessions').set({ view_as_role_id: roleId }).where('id', '=', id).execute()
  }

  /** Housekeeping: drops sessions that expired or were revoked more than 30 days ago. */
  async purge(db: Executor = this.db): Promise<number> {
    const cutoff = new Date(this.clock.now().getTime() - 30 * 24 * 60 * 60 * 1000)
    const r = await db
      .deleteFrom('sessions')
      .where((eb) => eb.or([eb('absolute_expires_at', '<', cutoff), eb('revoked_at', '<', cutoff)]))
      .executeTakeFirst()
    return Number(r.numDeletedRows)
  }
}
