// Kiosk mode (ADR 0180): the registered devices, the shop's unlock code, kiosk sessions and their context, the acting employee, and
// the manager's controls. The routes (routes.ts) are thin; the session authorizer (src/modules/auth/authorizer.ts) asks this service
// for a kiosk context when a request carries no live user session.
import type { FastifyRequest } from 'fastify'
import type { Selectable } from 'kysely'
import type { Env } from '../../config/env.js'
import type { KioskAuthContext } from '../../http/authorizer.js'
import * as audit from '../../platform/audit.js'
import type { AuditContext } from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Executor, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { isUuid, type NewId } from '../../platform/ids.js'
import * as realtime from '../../platform/realtime.js'
import { getSetting, updateSetting } from '../../platform/settings.js'
import { addDays, clockLabel, toBizDate } from '../../platform/time.js'
import { displayName } from '../auth/context.js'
import { kioskDeviceCookieName, kioskSessionCookieName } from '../auth/cookie.js'
import type { SessionService } from '../auth/sessions.js'
import { csrfTokenFor, hashToken, newToken, TOKEN_SHAPE } from '../auth/tokens.js'
import { KIOSK_PERMISSIONS, PERMISSIONS } from '../rbac/catalog.js'
import { locationTimezone } from '../scheduling/context.js'
import { listLiveClosures } from '../settings/closures.js'
import { dayInfo } from '../settings/day-info.js'
import { emergencySnapshot, getActiveEmergency } from '../settings/emergency.js'
import { getHours } from '../settings/hours.js'
import { codeProblem, generateCode, KIOSK_CODE_HISTORY, REUSED_CODE_PROBLEM, type KioskCodeHasher } from './code.js'
import { kioskLockTime, type KioskLock } from './lock-time.js'
import './problems.js'
import type { KioskDevicesTable, KioskLockRule } from './schema.js'
import {
  clientIp,
  clientUa,
  createKioskSession,
  lookupKioskSession,
  purgeKioskSessions,
  revokeKioskSessions,
} from './sessions.js'
import { findKioskActor, listKioskStaff, type KioskPerson } from './staff.js'
import {
  deviceRetryAfterSec,
  KIOSK_LOCKOUT_FAILURES,
  kioskDelaySec,
  type KioskUnlockGuard,
} from './throttle.js'

export type KioskEnv = Pick<Env, 'NODE_ENV' | 'COOKIE_SECURE'> & { SESSION_SECRET?: string }

export interface KioskServiceDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: KioskEnv
  hasher: KioskCodeHasher
  guard: KioskUnlockGuard
  /** The user sessions: an unlock signs out a user session on the device; registering a device signs the admin out. */
  userSessions: SessionService
  /** The location of a request that names no device (single-location shop). */
  defaultLocationId: string
  warn?: (msg: string, data?: Record<string, unknown>) => void
}

export interface ClientMeta {
  ip?: string | null
  ua?: string | null
  requestId?: string | null
}

/** The signed-in manager behind an admin call. */
export interface KioskAdmin {
  locationId: string
  userId: string
  employeeId: string
  name: string
  /** The admin's own user session (registering a device while kiosk mode is on signs it out). */
  sessionId: string
  audit: AuditContext
}

type DeviceRow = Selectable<KioskDevicesTable>

export type KioskDeviceState = 'unlocked' | 'locked' | 'locked_out' | 'revoked'

export interface KioskDeviceView {
  id: string
  name: string
  state: KioskDeviceState
  locksAt: string | null
  lastSeenAt: string | null
  lastIp: string | null
  lastUa: string | null
  failedAttempts: number
  createdAt: string
  createdBy: string | null
  version: number
}

export interface KioskMe {
  kind: 'kiosk'
  device: { id: string; name: string }
  lock: { unlockedAt: string; locksAt: string; locksAtLabel: string; rule: KioskLockRule }
  permissions: Record<string, { on: boolean }>
  limits: Record<string, number | null>
  csrfToken: string
  staff: KioskPerson[]
  businessTz: string
  serverTime: string
}

export interface KioskStatus {
  enabled: boolean
  device: { name: string } | null
  unlocked: { locksAt: string; locksAtLabel: string } | null
  lockedOut: boolean
  retryAfterSec: number
}

export interface KioskOverview {
  enabled: boolean
  version: number
  code: { set: boolean; setAt: string | null; setBy: string | null; ageDays: number | null }
  thisDeviceId: string | null
  devices: KioskDeviceView[]
  staff: { id: string; name: string; status: 'active' | 'invited' | 'inactive'; listed: boolean }[]
  recent: { at: string; action: string; label: string; by: string | null; deviceName: string | null }[]
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Plain lines for the Settings "Recent kiosk events" list. */
const RECENT_LABELS: Record<string, string> = {
  'kiosk.unlock': 'Unlocked',
  'kiosk.unlock.failed': 'Wrong code',
  'kiosk.unlock.alert': 'Many wrong codes on every kiosk',
  'kiosk.lock': 'Locked',
  'kiosk.lock_all': 'Locked every kiosk',
  'kiosk.code.set': 'Code changed',
  'kiosk.mode.on': 'Kiosk mode turned on',
  'kiosk.mode.off': 'Kiosk mode turned off',
  'kiosk.device.register': 'Made a kiosk',
  'kiosk.device.rename': 'Renamed',
  'kiosk.device.revoke': 'Removed',
  'kiosk.device.lock': 'Locked from Settings',
  'kiosk.device.lockout': 'Locked out after too many wrong codes',
  'kiosk.device.lockout.clear': 'Lockout cleared',
  'kiosk.staff.listed': 'Kiosk list changed',
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

export class KioskService {
  private readonly deviceCookie: string
  private readonly sessionCookie: string

  constructor(private readonly d: KioskServiceDeps) {
    this.deviceCookie = kioskDeviceCookieName(d.env)
    this.sessionCookie = kioskSessionCookieName(d.env)
  }

  get clock(): Clock {
    return this.d.clock
  }

  // --- cookies -------------------------------------------------------------------------------------------------------------------

  deviceToken(req: FastifyRequest): string | undefined {
    return req.cookies?.[this.deviceCookie]
  }

  sessionToken(req: FastifyRequest): string | undefined {
    return req.cookies?.[this.sessionCookie]
  }

  /** The device behind a device cookie (any state), or null. */
  async deviceByToken(db: Executor, token: string | undefined): Promise<DeviceRow | null> {
    if (!token || !TOKEN_SHAPE.test(token)) return null
    const row = await db.selectFrom('kiosk_devices').selectAll().where('token_hash', '=', hashToken(token)).executeTakeFirst()
    return row ?? null
  }

  /** The live (not revoked) device behind a device cookie, for the short admin session on a kiosk device. */
  async liveDeviceId(token: string | null | undefined, db: Executor = this.d.db): Promise<string | null> {
    const d = await this.deviceByToken(db, token ?? undefined)
    return d && !d.revoked_at ? d.id : null
  }

  // --- the request context -------------------------------------------------------------------------------------------------------

  /** A kiosk context for the request's kiosk cookies, or null (no session, locked, revoked, other device, kiosk mode off). */
  async resolveContext(req: FastifyRequest, opts: { touch?: boolean } = {}): Promise<KioskAuthContext | null> {
    const s = await lookupKioskSession(
      this.d.db,
      this.d.clock,
      { session: this.sessionToken(req), device: this.deviceToken(req) },
      opts,
    )
    if (!s) return null
    return {
      kind: 'kiosk',
      userId: null,
      employeeId: null,
      locationId: s.locationId,
      permissions: KIOSK_PERMISSIONS,
      limits: {},
      actorName: `Kiosk · ${s.deviceName}`,
      roles: ['Kiosk'],
      viewAsRoleId: null,
      realUserId: null,
      kiosk: {
        sessionId: s.id,
        deviceId: s.deviceId,
        deviceName: s.deviceName,
        csrfSecret: s.csrfSecret,
        locksAt: s.expiresAt,
        acting: null,
      },
    }
  }

  /**
   * Binds X-Oasis-Employee as the request's actor: an active or invited, listed employee of the device's location (else 422
   * KIOSK_EMPLOYEE_INVALID); `required` answers 428 KIOSK_EMPLOYEE_REQUIRED when the header is missing.
   */
  async bindActor(req: FastifyRequest, ctx: KioskAuthContext, required: boolean): Promise<void> {
    const raw = header(req, 'x-oasis-employee')?.trim()
    if (!raw) {
      if (required) throw new AppError('KIOSK_EMPLOYEE_REQUIRED')
      return
    }
    const person = isUuid(raw) ? await findKioskActor(this.d.db, ctx.locationId, raw.toLowerCase()) : null
    if (!person) throw new AppError('KIOSK_EMPLOYEE_INVALID')
    ctx.employeeId = person.id
    ctx.actorName = person.name
    ctx.kiosk.acting = person
  }

  // --- the keypad ----------------------------------------------------------------------------------------------------------------

  /** GET /kiosk/status: whether the keypad is on and whether this browser is a kiosk (no personal data). */
  async status(req: FastifyRequest): Promise<KioskStatus> {
    const now = this.d.clock.now()
    const raw = await this.deviceByToken(this.d.db, this.deviceToken(req))
    const device = raw && !raw.revoked_at ? raw : null
    const locationId = device?.location_id ?? this.d.defaultLocationId
    const enabled = (await getSetting(this.d.db, locationId, 'kiosk.enabled')).value
    const s = device
      ? await lookupKioskSession(
          this.d.db,
          this.d.clock,
          { session: this.sessionToken(req), device: this.deviceToken(req) },
          { touch: false },
        )
      : null
    const tz = s ? await locationTimezone(this.d.db, s.locationId) : null
    return {
      enabled,
      device: device ? { name: device.name } : null,
      unlocked: s && tz ? { locksAt: s.expiresAt.toISOString(), locksAtLabel: clockLabel(s.expiresAt, tz) } : null,
      lockedOut: !!device?.locked_out_at,
      retryAfterSec: device
        ? deviceRetryAfterSec({ failedAttempts: device.failed_attempts, lastFailedAt: device.last_failed_at }, now)
        : 0,
    }
  }

  /**
   * POST /kiosk/unlock. The device cookie and the code are the credential: an unregistered device never has its code checked; the
   * throttle refuses before the code is evaluated. Success opens a kiosk session until the lock time, ends the device's previous
   * kiosk session and signs out a user session on the device.
   */
  async unlock(i: {
    code: string
    deviceToken: string | undefined
    userSessionToken: string | undefined
    meta: ClientMeta
  }): Promise<{ me: KioskMe; token: string; expiresAt: Date; userSignedOut: boolean }> {
    const { db, clock } = this.d
    const ip = i.meta.ip ?? 'unknown'
    const found = await this.deviceByToken(db, i.deviceToken)
    if (!found || found.revoked_at) throw new AppError('KIOSK_DEVICE_UNKNOWN')
    const locationId = found.location_id
    if (!(await getSetting(db, locationId, 'kiosk.enabled')).value) throw new AppError('KIOSK_OFF')
    if (!(await this.currentCode(db, locationId))) throw new AppError('KIOSK_CODE_NOT_SET')

    type Outcome =
      | { ok: true; token: string; sessionId: string; csrfSecret: string; lock: KioskLock; createdAt: Date; userSignedOut: boolean }
      | { ok: false; failures: number; lockedOut: boolean }
    const outcome = await transaction(db, async (tx): Promise<Outcome> => {
      // the device row lock serialises guesses on one device: two at once cannot both slip under the throttle
      const dev = await tx
        .selectFrom('kiosk_devices')
        .selectAll()
        .where('id', '=', found.id)
        .forUpdate()
        .executeTakeFirstOrThrow()
      if (dev.revoked_at) throw new AppError('KIOSK_DEVICE_UNKNOWN')
      if (dev.locked_out_at) throw new AppError('KIOSK_LOCKED_OUT')
      // read again and share-lock the current code: a code change waits for this unlock and then ends its session (its own
      // update of the row), and an unlock behind a code change never opens a session with the retired code
      const code = await this.currentCode(tx, locationId, true)
      if (!code) throw new AppError('KIOSK_CODE_NOT_SET')
      // likewise kiosk mode: turning it off waits for this unlock, then ends its session
      const mode = await tx
        .selectFrom('settings')
        .select('value')
        .where('location_id', '=', locationId)
        .where('key', '=', 'kiosk.enabled')
        .forShare()
        .executeTakeFirst()
      if ((mode?.value as unknown) !== true) throw new AppError('KIOSK_OFF')
      const now = clock.now()
      const wait = Math.max(
        deviceRetryAfterSec({ failedAttempts: dev.failed_attempts, lastFailedAt: dev.last_failed_at }, now),
        this.d.guard.retryAfterSec(ip),
      )
      if (wait > 0)
        throw new AppError('KIOSK_THROTTLED', { headers: { 'Retry-After': String(wait) }, meta: { retryAfterSec: wait } })

      const ctx = this.deviceAudit(dev, i.meta)
      if (!(await this.d.hasher.verify(locationId, i.code, code.code_hash))) {
        const failures = dev.failed_attempts + 1
        const lockedOut = failures >= KIOSK_LOCKOUT_FAILURES
        await tx
          .updateTable('kiosk_devices')
          .set({ failed_attempts: failures, last_failed_at: now, ...(lockedOut ? { locked_out_at: now } : {}) })
          .where('id', '=', dev.id)
          .execute()
        await audit.record(tx, {
          locationId,
          action: 'kiosk.unlock.failed',
          entityType: 'kiosk_device',
          entityId: dev.id,
          after: { failures },
          ctx,
        })
        if (lockedOut) {
          await audit.record(tx, {
            locationId,
            action: 'kiosk.device.lockout',
            entityType: 'kiosk_device',
            entityId: dev.id,
            after: { failures },
            ctx,
          })
          await this.changed(tx, locationId)
        }
        return { ok: false, failures, lockedOut }
      }

      await tx
        .updateTable('kiosk_devices')
        .set({
          failed_attempts: 0,
          last_failed_at: null,
          last_seen_at: now,
          last_ip: clientIp(i.meta.ip),
          last_ua: clientUa(i.meta.ua),
        })
        .where('id', '=', dev.id)
        .execute()
      await revokeKioskSessions(tx, clock, { deviceId: dev.id }, 'unlock_again')
      const lock = await this.lockFor(tx, locationId, now)
      const s = await createKioskSession(tx, clock, {
        deviceId: dev.id,
        locationId,
        codeId: code.id,
        expiresAt: lock.locksAt,
        lockRule: lock.rule,
        ip: i.meta.ip,
        ua: i.meta.ua,
      })
      // a manager signed in on the tablet is signed out by the next unlock
      let userSignedOut = false
      if (i.userSessionToken && TOKEN_SHAPE.test(i.userSessionToken)) {
        const r = await tx
          .updateTable('sessions')
          .set({ revoked_at: now })
          .where('id', '=', hashToken(i.userSessionToken))
          .where('revoked_at', 'is', null)
          .executeTakeFirst()
        userSignedOut = Number(r.numUpdatedRows) > 0
      }
      await audit.record(tx, {
        locationId,
        action: 'kiosk.unlock',
        entityType: 'kiosk_device',
        entityId: dev.id,
        after: { locksAt: lock.locksAt.toISOString(), rule: lock.rule, userSignedOut },
        ctx,
      })
      await this.changed(tx, locationId)
      return { ok: true, token: s.token, sessionId: s.id, csrfSecret: s.csrfSecret, lock, createdAt: s.createdAt, userSignedOut }
    })

    if (!outcome.ok) {
      if (this.d.guard.failure(ip).alert) {
        this.d.warn?.('kiosk: more than 60 wrong codes in an hour across every kiosk; unlocks are slowed for everyone', {
          locationId,
        })
        await transaction(db, (tx) =>
          audit.record(tx, {
            locationId,
            action: 'kiosk.unlock.alert',
            entityType: 'kiosk_device',
            entityId: found.id,
            ctx: this.deviceAudit(found, i.meta),
          }),
        )
      }
      if (outcome.lockedOut) throw new AppError('KIOSK_LOCKED_OUT')
      throw new AppError('KIOSK_CODE_WRONG', { meta: { retryAfterSec: kioskDelaySec(outcome.failures) } })
    }
    await purgeKioskSessions(db, clock).catch(() => undefined)
    const tz = await locationTimezone(db, locationId)
    const me = await this.meOf({
      sessionId: outcome.sessionId,
      csrfSecret: outcome.csrfSecret,
      device: { id: found.id, name: found.name },
      locationId,
      createdAt: outcome.createdAt,
      locksAt: outcome.lock.locksAt,
      rule: outcome.lock.rule,
      tz,
    })
    return { me, token: outcome.token, expiresAt: outcome.lock.locksAt, userSignedOut: outcome.userSignedOut }
  }

  /** GET /kiosk/me. */
  async me(ctx: KioskAuthContext): Promise<KioskMe> {
    const s = await this.d.db
      .selectFrom('kiosk_sessions')
      .select(['created_at', 'expires_at', 'lock_rule'])
      .where('id', '=', ctx.kiosk.sessionId)
      .executeTakeFirstOrThrow()
    return this.meOf({
      sessionId: ctx.kiosk.sessionId,
      csrfSecret: ctx.kiosk.csrfSecret,
      device: { id: ctx.kiosk.deviceId, name: ctx.kiosk.deviceName },
      locationId: ctx.locationId,
      createdAt: s.created_at,
      locksAt: s.expires_at,
      rule: s.lock_rule,
      tz: await locationTimezone(this.d.db, ctx.locationId),
    })
  }

  staff(locationId: string): Promise<KioskPerson[]> {
    return listKioskStaff(this.d.db, locationId)
  }

  /** POST /kiosk/lock: ends this kiosk session (the keypad shows again). */
  async lock(ctx: KioskAuthContext, auditCtx: AuditContext): Promise<void> {
    await transaction(this.d.db, async (tx) => {
      await revokeKioskSessions(tx, this.d.clock, { id: ctx.kiosk.sessionId }, 'lock')
      await audit.record(tx, {
        locationId: ctx.locationId,
        action: 'kiosk.lock',
        entityType: 'kiosk_device',
        entityId: ctx.kiosk.deviceId,
        ctx: auditCtx,
      })
      await this.changed(tx, ctx.locationId)
    })
  }

  // --- the manager's controls ----------------------------------------------------------------------------------------------------

  /** GET /kiosk. */
  async overview(admin: KioskAdmin, deviceToken: string | undefined): Promise<KioskOverview> {
    const { db, clock } = this.d
    const now = clock.now()
    const loc = admin.locationId
    const enabled = await getSetting(db, loc, 'kiosk.enabled')
    const code = await this.currentCode(db, loc)
    const thisDevice = await this.deviceByToken(db, deviceToken)
    const staff = await db
      .selectFrom('employees as e')
      .innerJoin('employee_locations as el', (j) => j.onRef('el.employee_id', '=', 'e.id').on('el.location_id', '=', loc))
      .select(['e.id', 'e.first', 'e.last', 'e.status', 'e.kiosk_listed'])
      .where('e.status', 'in', ['active', 'invited'])
      .orderBy('e.first')
      .orderBy('e.last')
      .orderBy('e.id')
      .execute()
    const recent = await db
      .selectFrom('audit_log as a')
      .leftJoin('kiosk_devices as d', 'd.id', 'a.kiosk_device_id')
      .select(['a.at', 'a.action', 'a.actor_name', 'a.entity_type', 'a.entity_id', 'd.name as device_name'])
      .where('a.location_id', '=', loc)
      .where('a.action', 'like', 'kiosk.%')
      .orderBy('a.id', 'desc')
      .limit(30)
      .execute()
    const deviceNames = new Map(
      (await db.selectFrom('kiosk_devices').select(['id', 'name']).where('location_id', '=', loc).execute()).map((r) => [r.id, r.name]),
    )
    return {
      enabled: enabled.value,
      version: enabled.version,
      code: code
        ? {
            set: true,
            setAt: code.created_at.toISOString(),
            setBy: code.created_by_name,
            ageDays: Math.floor((now.getTime() - code.created_at.getTime()) / DAY_MS),
          }
        : { set: false, setAt: null, setBy: null, ageDays: null },
      thisDeviceId: thisDevice && !thisDevice.revoked_at && thisDevice.location_id === loc ? thisDevice.id : null,
      devices: await this.deviceViews(db, loc),
      staff: staff.map((e) => ({
        id: e.id,
        name: displayName(e.first, e.last),
        status: e.status,
        listed: e.kiosk_listed,
      })),
      recent: recent.map((r) => ({
        at: r.at.toISOString(),
        action: r.action,
        label: RECENT_LABELS[r.action] ?? r.action,
        by: r.actor_name,
        deviceName: r.device_name ?? (r.entity_type === 'kiosk_device' && r.entity_id ? (deviceNames.get(r.entity_id) ?? null) : null),
      })),
    }
  }

  /** PUT /kiosk/settings: turning kiosk mode on needs a code; turning it off ends every kiosk session. */
  async setEnabled(admin: KioskAdmin, enabled: boolean, version: number): Promise<{ enabled: boolean; version: number }> {
    return transaction(this.d.db, async (tx) => {
      if (enabled && !(await this.currentCode(tx, admin.locationId))) throw new AppError('KIOSK_CODE_NOT_SET')
      const before = (await getSetting(tx, admin.locationId, 'kiosk.enabled')).value
      const rec = await updateSetting(tx, {
        locationId: admin.locationId,
        key: 'kiosk.enabled',
        value: enabled,
        expectedVersion: version,
        updatedBy: admin.userId,
        audit: admin.audit,
      })
      if (before !== enabled)
        await audit.record(tx, {
          locationId: admin.locationId,
          action: enabled ? 'kiosk.mode.on' : 'kiosk.mode.off',
          entityType: 'setting',
          entityId: 'kiosk.enabled',
          ctx: admin.audit,
        })
      if (!enabled) await revokeKioskSessions(tx, this.d.clock, { locationId: admin.locationId }, 'kiosk_off')
      return { enabled: rec.value, version: rec.version }
    })
  }

  /**
   * PUT /kiosk/code: a code the manager typed, or a generated one (returned once). The rules, then not one of the last 3 codes.
   * Changing the code locks every kiosk now.
   */
  async setCode(admin: KioskAdmin, input: { code?: string; generate?: boolean }): Promise<{ setAt: string; code?: string }> {
    const generated = input.generate === true
    const code = generated ? generateCode() : (input.code ?? '')
    const reject = (message: string): AppError =>
      new AppError('KIOSK_CODE_REJECTED', { detail: message, errors: [{ path: 'body.code', message }] })
    const problem = codeProblem(code)
    if (problem) throw reject(problem)
    const recent = await this.d.db
      .selectFrom('kiosk_codes')
      .select('code_hash')
      .where('location_id', '=', admin.locationId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc') // time-ordered ids: two codes set in the same instant still have an order
      .limit(KIOSK_CODE_HISTORY)
      .execute()
    for (const r of recent)
      if (await this.d.hasher.verify(admin.locationId, code, r.code_hash)) {
        if (generated) return this.setCode(admin, input) // astronomically unlikely: draw again
        throw reject(REUSED_CODE_PROBLEM)
      }
    const hash = await this.d.hasher.hash(admin.locationId, code)
    const setAt = await transaction(this.d.db, async (tx) => {
      const now = this.d.clock.now()
      await tx
        .updateTable('kiosk_codes')
        .set({ retired_at: now })
        .where('location_id', '=', admin.locationId)
        .where('retired_at', 'is', null)
        .execute()
      await tx
        .insertInto('kiosk_codes')
        .values({
          id: this.d.newId(),
          location_id: admin.locationId,
          code_hash: hash,
          created_at: now,
          created_by: admin.userId,
          created_by_name: admin.name,
        })
        .execute()
      const locked = await revokeKioskSessions(tx, this.d.clock, { locationId: admin.locationId }, 'code_changed')
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.code.set',
        entityType: 'location',
        entityId: admin.locationId,
        after: { generated, locked }, // never the code
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
      return now
    })
    return generated ? { setAt: setAt.toISOString(), code } : { setAt: setAt.toISOString() }
  }

  /**
   * POST /kiosk/devices ("Make this a kiosk"): registers the browser the manager is using. Its token goes to the device cookie only.
   * While kiosk mode is on the manager's own session ends (the tablet goes straight to the keypad).
   */
  async registerDevice(
    admin: KioskAdmin,
    name: string,
    deviceToken: string | undefined,
    meta: ClientMeta,
  ): Promise<{ device: KioskDeviceView; token: string; signedOut: boolean }> {
    const existing = await this.deviceByToken(this.d.db, deviceToken)
    if (existing && !existing.revoked_at) throw new AppError('KIOSK_DEVICE_EXISTS')
    const token = newToken()
    const id = this.d.newId()
    const signedOut = await transaction(this.d.db, async (tx) => {
      const now = this.d.clock.now()
      await tx
        .insertInto('kiosk_devices')
        .values({
          id,
          location_id: admin.locationId,
          name,
          token_hash: hashToken(token),
          created_at: now,
          created_by: admin.userId,
          created_by_name: admin.name,
          last_seen_at: now,
          last_ip: clientIp(meta.ip),
          last_ua: clientUa(meta.ua),
        })
        .execute()
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.device.register',
        entityType: 'kiosk_device',
        entityId: id,
        after: { name },
        ctx: { ...admin.audit, kioskDeviceId: id },
      })
      await this.changed(tx, admin.locationId)
      if (!(await getSetting(tx, admin.locationId, 'kiosk.enabled')).value) return false
      await this.d.userSessions.revoke(admin.sessionId, tx)
      return true
    })
    return { device: await this.deviceView(this.d.db, admin.locationId, id), token, signedOut }
  }

  async renameDevice(admin: KioskAdmin, id: string, name: string, version: number): Promise<KioskDeviceView> {
    await transaction(this.d.db, async (tx) => {
      const dev = await this.lockDeviceRow(tx, admin.locationId, id)
      if (dev.version !== version) throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: dev.version } })
      await tx
        .updateTable('kiosk_devices')
        .set({ name, version: dev.version + 1 })
        .where('id', '=', id)
        .execute()
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.device.rename',
        entityType: 'kiosk_device',
        entityId: id,
        before: { name: dev.name },
        after: { name },
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
    })
    return this.deviceView(this.d.db, admin.locationId, id)
  }

  /** DELETE /kiosk/devices/:id: the device's cookie stops working for good and its session ends. */
  async revokeDevice(admin: KioskAdmin, id: string): Promise<void> {
    await transaction(this.d.db, async (tx) => {
      const dev = await this.lockDeviceRow(tx, admin.locationId, id)
      if (dev.revoked_at) return
      await tx
        .updateTable('kiosk_devices')
        .set({ revoked_at: this.d.clock.now(), revoked_by: admin.userId, version: dev.version + 1 })
        .where('id', '=', id)
        .execute()
      await revokeKioskSessions(tx, this.d.clock, { deviceId: id }, 'device_revoked')
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.device.revoke',
        entityType: 'kiosk_device',
        entityId: id,
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
    })
  }

  /** POST /kiosk/devices/:id/lock. */
  async lockDevice(admin: KioskAdmin, id: string): Promise<void> {
    await transaction(this.d.db, async (tx) => {
      await this.lockDeviceRow(tx, admin.locationId, id)
      const n = await revokeKioskSessions(tx, this.d.clock, { deviceId: id }, 'lock_device')
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.device.lock',
        entityType: 'kiosk_device',
        entityId: id,
        after: { locked: n },
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
    })
  }

  /** POST /kiosk/devices/:id/clear-lockout: the wrong-code counter starts over. */
  async clearLockout(admin: KioskAdmin, id: string): Promise<KioskDeviceView> {
    await transaction(this.d.db, async (tx) => {
      const dev = await this.lockDeviceRow(tx, admin.locationId, id)
      await tx
        .updateTable('kiosk_devices')
        .set({ failed_attempts: 0, last_failed_at: null, locked_out_at: null, version: dev.version + 1 })
        .where('id', '=', id)
        .execute()
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.device.lockout.clear',
        entityType: 'kiosk_device',
        entityId: id,
        before: { failures: dev.failed_attempts, lockedOut: !!dev.locked_out_at },
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
    })
    return this.deviceView(this.d.db, admin.locationId, id)
  }

  /** POST /kiosk/lock-all. */
  async lockAll(admin: KioskAdmin): Promise<number> {
    return transaction(this.d.db, async (tx) => {
      const n = await revokeKioskSessions(tx, this.d.clock, { locationId: admin.locationId }, 'lock_all')
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.lock_all',
        entityType: 'location',
        entityId: admin.locationId,
        after: { locked: n },
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
      return n
    })
  }

  /** PUT /kiosk/staff/:employeeId: "Shows on the kiosk". */
  async setListed(
    admin: KioskAdmin,
    employeeId: string,
    listed: boolean,
  ): Promise<{ id: string; name: string; status: 'active' | 'invited' | 'inactive'; listed: boolean }> {
    if (!isUuid(employeeId)) throw new AppError('NOT_FOUND')
    return transaction(this.d.db, async (tx) => {
      const e = await tx
        .selectFrom('employees as e')
        .innerJoin('employee_locations as el', (j) =>
          j.onRef('el.employee_id', '=', 'e.id').on('el.location_id', '=', admin.locationId),
        )
        .select(['e.id', 'e.first', 'e.last', 'e.status', 'e.kiosk_listed'])
        .where('e.id', '=', employeeId)
        .forUpdate()
        .executeTakeFirst()
      if (!e) throw new AppError('NOT_FOUND')
      if (e.kiosk_listed !== listed) {
        await tx.updateTable('employees').set({ kiosk_listed: listed }).where('id', '=', employeeId).execute()
        await audit.record(tx, {
          locationId: admin.locationId,
          action: 'kiosk.staff.listed',
          entityType: 'employee',
          entityId: employeeId,
          before: { listed: e.kiosk_listed },
          after: { listed },
          ctx: admin.audit,
        })
        await this.changed(tx, admin.locationId)
      }
      return { id: e.id, name: displayName(e.first, e.last), status: e.status, listed }
    })
  }

  // --- helpers -------------------------------------------------------------------------------------------------------------------

  /** The current code row of the location, or undefined. */
  private currentCode(db: Executor, locationId: string, share = false) {
    const q = db
      .selectFrom('kiosk_codes')
      .select(['id', 'code_hash', 'created_at', 'created_by_name'])
      .where('location_id', '=', locationId)
      .where('retired_at', 'is', null)
    return (share ? q.forShare() : q).executeTakeFirst()
  }

  /** The lock time of an unlock now: today's and yesterday's hours, closures and the emergency, in the business time zone. */
  async lockFor(db: Executor, locationId: string, now: Date): Promise<KioskLock> {
    const tz = await locationTimezone(db, locationId)
    const today = toBizDate(now, tz)
    const yesterday = addDays(today, -1)
    const [hours, closures, emergency] = await Promise.all([
      getHours(db, locationId),
      listLiveClosures(db, locationId, { from: yesterday, to: today }),
      getActiveEmergency(db, locationId),
    ])
    const snap = emergencySnapshot(emergency, tz)
    const info = (date: string) => dayInfo({ date, hours, closures, emergency: snap })
    return kioskLockTime({ now, tz, today: info(today), yesterday: info(yesterday) })
  }

  private async meOf(s: {
    sessionId: string
    csrfSecret: string
    device: { id: string; name: string }
    locationId: string
    createdAt: Date
    locksAt: Date
    rule: KioskLockRule
    tz: string
  }): Promise<KioskMe> {
    const permissions: KioskMe['permissions'] = {}
    for (const p of PERMISSIONS) permissions[p.key] = { on: KIOSK_PERMISSIONS.has(p.key) }
    return {
      kind: 'kiosk',
      device: s.device,
      lock: {
        unlockedAt: s.createdAt.toISOString(),
        locksAt: s.locksAt.toISOString(),
        locksAtLabel: clockLabel(s.locksAt, s.tz),
        rule: s.rule,
      },
      permissions,
      limits: {},
      csrfToken: csrfTokenFor(s.csrfSecret, s.sessionId),
      staff: await listKioskStaff(this.d.db, s.locationId),
      businessTz: s.tz,
      serverTime: this.d.clock.now().toISOString(),
    }
  }

  /** The audit context of a keypad request (no user): the device as the actor. */
  private deviceAudit(dev: { id: string; name: string }, meta: ClientMeta): AuditContext {
    return {
      actor: { userId: null, employeeId: null, name: `Kiosk · ${dev.name}`, roles: 'Kiosk' },
      requestId: meta.requestId ?? null,
      ip: meta.ip ?? null,
      kioskDeviceId: dev.id,
    }
  }

  private async lockDeviceRow(tx: Tx, locationId: string, id: string): Promise<DeviceRow> {
    if (!isUuid(id)) throw new AppError('NOT_FOUND')
    const dev = await tx
      .selectFrom('kiosk_devices')
      .selectAll()
      .where('id', '=', id)
      .where('location_id', '=', locationId)
      .forUpdate()
      .executeTakeFirst()
    if (!dev) throw new AppError('NOT_FOUND')
    return dev
  }

  /** Settings -> Kiosk refreshes on this (the dashboard's kiosk refetches its staff on it too). */
  private changed(tx: Tx, locationId: string): Promise<number> {
    return realtime.publish(tx, { locationId, channel: 'settings', type: 'settings.changed', payload: { section: 'kiosk' } })
  }

  private async deviceViews(db: Executor, locationId: string, id?: string): Promise<KioskDeviceView[]> {
    const now = this.d.clock.now()
    let q = db
      .selectFrom('kiosk_devices as d')
      .select((eb) => [
        'd.id',
        'd.name',
        'd.created_at',
        'd.created_by_name',
        'd.last_seen_at',
        'd.last_ip',
        'd.last_ua',
        'd.failed_attempts',
        'd.locked_out_at',
        'd.revoked_at',
        'd.version',
        eb
          .selectFrom('kiosk_sessions as s')
          .select((x) => x.fn.max('s.expires_at').as('m'))
          .whereRef('s.device_id', '=', 'd.id')
          .where('s.revoked_at', 'is', null)
          .where('s.expires_at', '>', now)
          .as('locks_at'),
      ])
      .where('d.location_id', '=', locationId)
    if (id) q = q.where('d.id', '=', id)
    const rows = await q.orderBy('d.revoked_at', (o) => o.desc().nullsFirst()).orderBy('d.created_at', 'desc').execute()
    return rows.map((r) => {
      const locksAt = r.locks_at ? new Date(r.locks_at as unknown as string | Date) : null
      const state: KioskDeviceState = r.revoked_at
        ? 'revoked'
        : r.locked_out_at
          ? 'locked_out'
          : locksAt
            ? 'unlocked'
            : 'locked'
      return {
        id: r.id,
        name: r.name,
        state,
        locksAt: state === 'unlocked' && locksAt ? locksAt.toISOString() : null,
        lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
        lastIp: r.last_ip,
        lastUa: r.last_ua,
        failedAttempts: r.failed_attempts,
        createdAt: r.created_at.toISOString(),
        createdBy: r.created_by_name,
        version: r.version,
      }
    })
  }

  private async deviceView(db: Executor, locationId: string, id: string): Promise<KioskDeviceView> {
    const [v] = await this.deviceViews(db, locationId, id)
    if (!v) throw new AppError('NOT_FOUND')
    return v
  }
}
