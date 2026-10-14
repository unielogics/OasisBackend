// Kiosk mode (ADR 0180 and its 2026-10-14 amendment): per-employee PINs, the shop's networks (where PINs work), the browsers that
// unlocked at the shop, kiosk sessions and their context, the acting employee, and the manager's controls. The routes (routes.ts) are
// thin; the session authorizer (src/modules/auth/authorizer.ts) asks this service for a kiosk context when a request carries no live
// user session.
//
// Unlock (POST /kiosk/unlock {pin}): kiosk mode off -> 409; the caller's address in no shop network -> 403 KIOSK_NOT_AT_SHOP before any
// PIN work (the try is listed for the Super Admin, capped and rate-limited); then the per-address and per-browser throttle; then the
// PIN's lookup must name an active or invited employee shown on the kiosk. Success opens a kiosk session for everyone until the lock
// time, "Opened by Marco R.", and gives a browser without a device cookie its own ("Shop browser N").
import type { FastifyRequest } from 'fastify'
import { sql, type Selectable } from 'kysely'
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
import { recordStaffEvent } from '../../platform/staff-events.js'
import { addDays, clockLabel, toBizDate } from '../../platform/time.js'
import { displayName } from '../auth/context.js'
import { kioskDeviceCookieName, kioskSessionCookieName } from '../auth/cookie.js'
import '../auth/problems.js'
import type { SessionService } from '../auth/sessions.js'
import { csrfTokenFor, hashToken, newToken, TOKEN_SHAPE } from '../auth/tokens.js'
import { KIOSK_PERMISSIONS, PERMISSIONS } from '../rbac/catalog.js'
import { locationTimezone } from '../scheduling/context.js'
import { listLiveClosures } from '../settings/closures.js'
import { dayInfo } from '../settings/day-info.js'
import { emergencySnapshot, getActiveEmergency } from '../settings/emergency.js'
import { getHours } from '../settings/hours.js'
import { kioskLockTime, type KioskLock } from './lock-time.js'
import { callerAddress, networkLabel, networkOf } from './network.js'
import {
  generatePin,
  KIOSK_PIN_HISTORY,
  pinLookup,
  pinProblem,
  REUSED_PIN_PROBLEM,
  TAKEN_PIN_PROBLEM,
} from './pin.js'
import './problems.js'
import type { KioskDevicesTable, KioskLockRule, KioskNetworksTable } from './schema.js'
import {
  clientIp,
  clientUa,
  createKioskSession,
  lookupKioskSession,
  purgeKioskSessions,
  revokeKioskSessions,
  revokeUserSessionsOnKiosks,
} from './sessions.js'
import { findKioskActor, listKioskStaff, type KioskPerson } from './staff.js'
import {
  KIOSK_ADDRESS_RULE,
  KIOSK_BROWSER_RULE,
  kioskDelaySec,
  retryAfterSec,
  type KioskUnlockGuard,
} from './throttle.js'

export type KioskEnv = Pick<Env, 'NODE_ENV' | 'COOKIE_SECURE'> & { SESSION_SECRET?: string }

export interface KioskServiceDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: KioskEnv
  /** The kiosk PIN key (pin.ts kioskKey, from SESSION_SECRET). */
  pinKey: Buffer
  guard: KioskUnlockGuard
  /** The user sessions: an unlock signs out a user session on the browser. */
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
  /** The admin's own user session (a change that signs out the managers on kiosk browsers says whether it was theirs). */
  sessionId: string
  /** Acting as a Super Admin (the locked role, not while viewing as a lesser role): shop networks need it. */
  isSuper: boolean
  /** The caller's address as the server sees it (req.ip through TRUST_PROXY). */
  ip: string | null
  audit: AuditContext
}

type DeviceRow = Selectable<KioskDevicesTable>
type NetworkRow = Selectable<KioskNetworksTable>

export type KioskDeviceState = 'unlocked' | 'locked' | 'locked_out' | 'revoked'

export interface KioskDeviceView {
  id: string
  name: string
  state: KioskDeviceState
  locksAt: string | null
  /** Whose PIN opened its current kiosk session ("Marco R."), while unlocked. */
  openedBy: string | null
  lastSeenAt: string | null
  lastIp: string | null
  lastUa: string | null
  failedAttempts: number
  createdAt: string
  createdBy: string | null
  version: number
}

export interface KioskNetworkView {
  id: string
  /** "203.0.113.7", or an IPv6 prefix "2001:db8:1:2::/64". */
  address: string
  label: string | null
  addedBy: string | null
  addedAt: string
  lastSeenAt: string | null
  failedAttempts: number
  lockedOut: boolean
}

export interface KioskRefusedView {
  id: string
  /** As GET /kiosk shows it; POST /kiosk/networks {address} approves it. */
  address: string
  firstSeenAt: string
  lastSeenAt: string
  attempts: number
  /** A try carried the cookie of a browser that unlocked at the shop before: the shop's address probably changed. */
  fromKnownBrowser: boolean
  browserName: string | null
}

export interface KioskMe {
  kind: 'kiosk'
  device: { id: string; name: string }
  lock: { unlockedAt: string; locksAt: string; locksAtLabel: string; rule: KioskLockRule }
  openedBy: { id: string | null; name: string }
  permissions: Record<string, { on: boolean }>
  limits: Record<string, number | null>
  csrfToken: string
  staff: KioskPerson[]
  businessTz: string
  serverTime: string
}

export interface KioskStatus {
  enabled: boolean
  /** At least one shop network exists (else the keypad says a Super Admin must set it first). */
  networkSet: boolean
  /** The caller's address is a shop network. */
  atShop: boolean
  unlocked: { locksAt: string; locksAtLabel: string } | null
  lockedOut: boolean
  retryAfterSec: number
}

export interface KioskStaffRow {
  id: string
  name: string
  status: 'active' | 'invited' | 'inactive'
  listed: boolean
  /** Whether they have a PIN (never the PIN), when and by whom it was set. */
  pin: { setAt: string; setBy: string | null } | null
}

export interface KioskOverview {
  enabled: boolean
  version: number
  yourAddress: string | null
  yourAddressIsShop: boolean
  /** The caller may add, remove and approve shop networks (a Super Admin). */
  canManageNetworks: boolean
  networks: KioskNetworkView[]
  refused: KioskRefusedView[]
  thisDeviceId: string | null
  devices: KioskDeviceView[]
  staff: KioskStaffRow[]
  recent: { at: string; action: string; label: string; by: string | null; deviceName: string | null }[]
}

const DAY_MS = 24 * 60 * 60 * 1000
/** The refused list keeps this long, and at most this many rows a location (unknown browsers' rows go first). */
export const KIOSK_REFUSED_KEEP_DAYS = 30
export const KIOSK_REFUSED_MAX_ROWS = 50
/** An employee's history keeps this many previous PINs (more than the last-3 rule needs). */
const PIN_HISTORY_KEEP = 5

/** Plain lines for the Settings "Recent kiosk events" list. */
const RECENT_LABELS: Record<string, string> = {
  'kiosk.unlock': 'Unlocked',
  'kiosk.unlock.failed': 'Wrong PIN',
  'kiosk.unlock.alert': 'Many wrong PINs on every kiosk',
  'kiosk.lock': 'Locked',
  'kiosk.lock_all': 'Locked every kiosk',
  'kiosk.mode.on': 'Kiosk mode turned on',
  'kiosk.mode.off': 'Kiosk mode turned off',
  'kiosk.device.register': 'New shop browser',
  'kiosk.device.rename': 'Renamed',
  'kiosk.device.revoke': 'Removed',
  'kiosk.device.lock': 'Locked from Settings',
  'kiosk.device.lockout': 'Browser locked out after too many wrong PINs',
  'kiosk.device.lockout.clear': 'Lockout cleared',
  'kiosk.staff.listed': 'Kiosk list changed',
  'kiosk.pin.set': 'PIN set',
  'kiosk.pin.remove': 'PIN removed',
  'kiosk.network.add': 'Shop network added',
  'kiosk.network.remove': 'Shop network removed',
  'kiosk.network.lockout': 'Shop network locked out after too many wrong PINs',
  'kiosk.network.lockout.clear': 'Network lockout cleared',
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

const isUniqueViolation = (e: unknown, constraint: string): boolean =>
  (e as { code?: string } | null)?.code === '23505' && (e as { constraint?: string }).constraint === constraint

/** "Safari on iPad", "Chrome on Android", ... from a user agent; null when nothing is recognised. */
export function browserSummary(ua: string | null | undefined): string | null {
  if (!ua) return null
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? 'Edge'
    : /Firefox\/|FxiOS\//.test(ua)
      ? 'Firefox'
      : /SamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null
  const device = /iPad/.test(ua)
    ? 'iPad'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? 'Android'
        : /CrOS/.test(ua)
          ? 'Chromebook'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Mac OS X|Macintosh/.test(ua)
              ? 'Mac'
              : /Linux/.test(ua)
                ? 'Linux'
                : null
  if (browser && device) return `${browser} on ${device}`
  return browser ?? device
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

  /**
   * The live (not removed) browser behind a device cookie: one that unlocked at the shop. A manager signing in there gets the short
   * kiosk-admin session (ADR 0180 K12).
   */
  async liveDeviceId(token: string | null | undefined, db: Executor = this.d.db): Promise<string | null> {
    const d = await this.deviceByToken(db, token ?? undefined)
    return d && !d.revoked_at ? d.id : null
  }

  /** The live device behind the request's device cookie (the authorizer ties a user session that comes with it to the device). */
  liveDeviceOf(req: FastifyRequest): Promise<string | null> {
    return this.liveDeviceId(this.deviceToken(req))
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

  /** GET /kiosk/status: whether the keypad is on, whether PINs work from here, and this browser's state (no personal data). */
  async status(req: FastifyRequest): Promise<KioskStatus> {
    const { db, clock } = this.d
    const now = clock.now()
    const raw = await this.deviceByToken(db, this.deviceToken(req))
    const device = raw && !raw.revoked_at ? raw : null
    const locationId = device?.location_id ?? this.d.defaultLocationId
    const enabled = (await getSetting(db, locationId, 'kiosk.enabled')).value
    const networkSet = await this.hasNetworks(db, locationId)
    const net = networkSet ? await this.matchNetwork(db, locationId, callerAddress(req.ip)) : null
    const s = device
      ? await lookupKioskSession(db, clock, { session: this.sessionToken(req), device: this.deviceToken(req) }, { touch: false })
      : null
    const tz = s ? await locationTimezone(db, s.locationId) : null
    return {
      enabled,
      networkSet,
      atShop: !!net,
      unlocked: s && tz ? { locksAt: s.expiresAt.toISOString(), locksAtLabel: clockLabel(s.expiresAt, tz) } : null,
      lockedOut: !!device?.locked_out_at || !!net?.locked_out_at,
      retryAfterSec: Math.max(
        device ? retryAfterSec({ failedAttempts: device.failed_attempts, lastFailedAt: device.last_failed_at }, now, KIOSK_BROWSER_RULE) : 0,
        net ? retryAfterSec({ failedAttempts: net.failed_attempts, lastFailedAt: net.last_failed_at }, now, KIOSK_ADDRESS_RULE) : 0,
        net ? this.d.guard.globalRetryAfterSec() : 0,
      ),
    }
  }

  /**
   * POST /kiosk/unlock. Refused before any PIN work when kiosk mode is off or the caller's address is in no shop network; then the
   * per-address and per-browser throttle refuses before the PIN is evaluated. Success opens a kiosk session until the lock time for
   * everyone, recorded as opened by the PIN's employee; ends the browser's previous kiosk session; signs out a user session on it; and
   * gives a browser without a live device cookie its own (the device token is returned for the cookie).
   */
  async unlock(i: {
    pin: string
    deviceToken: string | undefined
    userSessionToken: string | undefined
    meta: ClientMeta
  }): Promise<{ me: KioskMe; token: string; deviceToken: string; expiresAt: Date; userSignedOut: boolean }> {
    const { db, clock } = this.d
    const address = callerAddress(i.meta.ip)
    const found = await this.deviceByToken(db, i.deviceToken)
    const known = found && !found.revoked_at ? found : null
    const locationId = known?.location_id ?? this.d.defaultLocationId
    if (!(await getSetting(db, locationId, 'kiosk.enabled')).value) throw new AppError('KIOSK_OFF')
    const matched = await this.matchNetwork(db, locationId, address)
    if (!matched) {
      await this.recordRefused(locationId, address, known).catch((e: unknown) =>
        this.d.warn?.('kiosk: could not record a refused PIN try', { error: String(e) }),
      )
      throw new AppError('KIOSK_NOT_AT_SHOP', { meta: { networkSet: await this.hasNetworks(db, locationId) } })
    }
    const lookup = pinLookup(this.d.pinKey, locationId, i.pin)

    type Outcome =
      | {
          ok: true
          token: string
          sessionId: string
          csrfSecret: string
          lock: KioskLock
          createdAt: Date
          userSignedOut: boolean
          device: { id: string; name: string; token: string }
          openedBy: { id: string; name: string }
        }
      | { ok: false; wait: number; lockedOut: boolean; deviceAudit: AuditContext; entity: { type: string; id: string } }
    const outcome = await transaction(db, async (tx): Promise<Outcome> => {
      // the shop address's row lock serialises every guess from the shop (the per-address throttle cannot be slipped under), and Lock
      // all takes the same rows first; then the browser's row
      const net = await tx
        .selectFrom('kiosk_networks')
        .selectAll()
        .where('id', '=', matched.id)
        .forUpdate()
        .executeTakeFirst()
      if (!net) throw new AppError('KIOSK_NOT_AT_SHOP', { meta: { networkSet: await this.hasNetworks(tx, locationId) } })
      const locked = known
        ? await tx.selectFrom('kiosk_devices').selectAll().where('id', '=', known.id).forUpdate().executeTakeFirstOrThrow()
        : null
      const dev = locked && !locked.revoked_at ? locked : null
      if (net.locked_out_at || dev?.locked_out_at) throw new AppError('KIOSK_LOCKED_OUT')
      // likewise kiosk mode: turning it off waits for this unlock, then ends its session
      const mode = await tx
        .selectFrom('settings')
        .select('value')
        .where('location_id', '=', locationId)
        .where('key', '=', 'kiosk.enabled')
        .forShare()
        .executeTakeFirst()
      if (mode && (mode.value as unknown) !== true) throw new AppError('KIOSK_OFF')
      if (!mode && !(await getSetting(tx, locationId, 'kiosk.enabled')).value) throw new AppError('KIOSK_OFF')
      const now = clock.now()
      const wait = Math.max(
        retryAfterSec({ failedAttempts: net.failed_attempts, lastFailedAt: net.last_failed_at }, now, KIOSK_ADDRESS_RULE),
        dev ? retryAfterSec({ failedAttempts: dev.failed_attempts, lastFailedAt: dev.last_failed_at }, now, KIOSK_BROWSER_RULE) : 0,
        this.d.guard.globalRetryAfterSec(),
      )
      if (wait > 0)
        throw new AppError('KIOSK_THROTTLED', { headers: { 'Retry-After': String(wait) }, meta: { retryAfterSec: wait } })

      const who = await tx
        .selectFrom('employee_kiosk_pins as p')
        .innerJoin('employees as e', 'e.id', 'p.employee_id')
        .innerJoin('employee_locations as el', (j) =>
          j.onRef('el.employee_id', '=', 'e.id').on('el.location_id', '=', locationId),
        )
        .select(['e.id', 'e.first', 'e.last'])
        .where('p.location_id', '=', locationId)
        .where('p.pin_lookup', '=', lookup)
        .where('e.status', 'in', ['active', 'invited'])
        .where('e.kiosk_listed', '=', true)
        .executeTakeFirst()

      if (!who) {
        // the same answer whether nobody has the PIN or its employee may not open the kiosk (deactivated, hidden): it never tells
        const netFailures = net.failed_attempts + 1
        const netLockedOut = netFailures >= KIOSK_ADDRESS_RULE.lockout
        await tx
          .updateTable('kiosk_networks')
          .set({ failed_attempts: netFailures, last_failed_at: now, ...(netLockedOut ? { locked_out_at: now } : {}) })
          .where('id', '=', net.id)
          .execute()
        let devFailures = 0
        let devLockedOut = false
        if (dev) {
          devFailures = dev.failed_attempts + 1
          devLockedOut = devFailures >= KIOSK_BROWSER_RULE.lockout
          await tx
            .updateTable('kiosk_devices')
            .set({ failed_attempts: devFailures, last_failed_at: now, ...(devLockedOut ? { locked_out_at: now } : {}) })
            .where('id', '=', dev.id)
            .execute()
        }
        const ctx = this.keypadAudit(dev, i.meta)
        const entity = dev ? { type: 'kiosk_device', id: dev.id } : { type: 'kiosk_network', id: net.id }
        await audit.record(tx, {
          locationId,
          action: 'kiosk.unlock.failed',
          entityType: entity.type,
          entityId: entity.id,
          after: { failures: dev ? devFailures : netFailures, addressFailures: netFailures, network: networkLabel(net.cidr) },
          ctx,
        })
        if (devLockedOut && dev)
          await audit.record(tx, {
            locationId,
            action: 'kiosk.device.lockout',
            entityType: 'kiosk_device',
            entityId: dev.id,
            after: { failures: devFailures },
            ctx,
          })
        if (netLockedOut)
          await audit.record(tx, {
            locationId,
            action: 'kiosk.network.lockout',
            entityType: 'kiosk_network',
            entityId: net.id,
            after: { failures: netFailures, network: networkLabel(net.cidr) },
            ctx,
          })
        if (devLockedOut || netLockedOut) await this.changed(tx, locationId)
        return {
          ok: false,
          wait: Math.max(kioskDelaySec(netFailures, KIOSK_ADDRESS_RULE), dev ? kioskDelaySec(devFailures, KIOSK_BROWSER_RULE) : 0),
          lockedOut: devLockedOut || netLockedOut,
          deviceAudit: ctx,
          entity,
        }
      }

      await tx
        .updateTable('kiosk_networks')
        .set({ failed_attempts: 0, last_failed_at: null, last_seen_at: now })
        .where('id', '=', net.id)
        .execute()
      const opener = { id: who.id, name: displayName(who.first, who.last) }
      let device: { id: string; name: string; token: string }
      if (dev) {
        await tx
          .updateTable('kiosk_devices')
          .set({ failed_attempts: 0, last_failed_at: null, last_seen_at: now, last_ip: clientIp(address), last_ua: clientUa(i.meta.ua) })
          .where('id', '=', dev.id)
          .execute()
        device = { id: dev.id, name: dev.name, token: i.deviceToken! }
      } else {
        // the browser's first unlock at the shop: it becomes a listed browser with its own device cookie
        device = await this.newBrowser(tx, locationId, opener, { ...i.meta, ip: address })
      }
      const ctx: AuditContext = {
        actor: { userId: null, employeeId: opener.id, name: opener.name, roles: 'Kiosk' },
        requestId: i.meta.requestId ?? null,
        ip: i.meta.ip ?? null,
        kioskDeviceId: device.id,
      }
      if (!dev)
        await audit.record(tx, {
          locationId,
          action: 'kiosk.device.register',
          entityType: 'kiosk_device',
          entityId: device.id,
          after: { name: device.name, auto: true },
          ctx,
        })
      await revokeKioskSessions(tx, clock, { deviceId: device.id }, 'unlock_again')
      const lock = await this.lockFor(tx, locationId, now)
      const s = await createKioskSession(tx, clock, {
        deviceId: device.id,
        locationId,
        openedBy: { employeeId: opener.id, name: opener.name },
        expiresAt: lock.locksAt,
        lockRule: lock.rule,
        ip: address,
        ua: i.meta.ua,
      })
      // a manager signed in on the browser is signed out by the unlock
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
      const auditId = await audit.record(tx, {
        locationId,
        action: 'kiosk.unlock',
        entityType: 'kiosk_device',
        entityId: device.id,
        after: {
          openedBy: { employeeId: opener.id, name: opener.name },
          locksAt: lock.locksAt.toISOString(),
          rule: lock.rule,
          network: networkLabel(net.cidr),
          userSignedOut,
        },
        ctx,
      })
      await recordStaffEvent(tx, {
        locationId,
        ctx,
        kind: 'kiosk_unlock',
        auditId,
        meta: { locksAt: lock.locksAt.toISOString() }, // the same as the history backfill rebuilds (backfill.ts)
      })
      await this.changed(tx, locationId)
      return {
        ok: true,
        token: s.token,
        sessionId: s.id,
        csrfSecret: s.csrfSecret,
        lock,
        createdAt: s.createdAt,
        userSignedOut,
        device,
        openedBy: opener,
      }
    })

    if (!outcome.ok) {
      if (this.d.guard.failure().alert) {
        this.d.warn?.('kiosk: more than 60 wrong PINs in an hour across every kiosk; unlocks are slowed for everyone', { locationId })
        await transaction(db, (tx) =>
          audit.record(tx, {
            locationId,
            action: 'kiosk.unlock.alert',
            entityType: outcome.entity.type,
            entityId: outcome.entity.id,
            ctx: outcome.deviceAudit,
          }),
        )
      }
      if (outcome.lockedOut) throw new AppError('KIOSK_LOCKED_OUT')
      throw new AppError('KIOSK_PIN_WRONG', { meta: { retryAfterSec: outcome.wait } })
    }
    await purgeKioskSessions(db, clock).catch(() => undefined)
    const tz = await locationTimezone(db, locationId)
    const me = await this.meOf({
      sessionId: outcome.sessionId,
      csrfSecret: outcome.csrfSecret,
      device: { id: outcome.device.id, name: outcome.device.name },
      openedBy: outcome.openedBy,
      locationId,
      createdAt: outcome.createdAt,
      locksAt: outcome.lock.locksAt,
      rule: outcome.lock.rule,
      tz,
    })
    return {
      me,
      token: outcome.token,
      deviceToken: outcome.device.token,
      expiresAt: outcome.lock.locksAt,
      userSignedOut: outcome.userSignedOut,
    }
  }

  /** GET /kiosk/me. */
  async me(ctx: KioskAuthContext): Promise<KioskMe> {
    const s = await this.d.db
      .selectFrom('kiosk_sessions')
      .select(['created_at', 'expires_at', 'lock_rule', 'opened_by_employee_id', 'opened_by_name'])
      .where('id', '=', ctx.kiosk.sessionId)
      .executeTakeFirstOrThrow()
    return this.meOf({
      sessionId: ctx.kiosk.sessionId,
      csrfSecret: ctx.kiosk.csrfSecret,
      device: { id: ctx.kiosk.deviceId, name: ctx.kiosk.deviceName },
      openedBy: { id: s.opened_by_employee_id, name: s.opened_by_name },
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
    const { db } = this.d
    const loc = admin.locationId
    const enabled = await getSetting(db, loc, 'kiosk.enabled')
    const thisDevice = await this.deviceByToken(db, deviceToken)
    const yourAddress = callerAddress(admin.ip)
    const staff = await db
      .selectFrom('employees as e')
      .innerJoin('employee_locations as el', (j) => j.onRef('el.employee_id', '=', 'e.id').on('el.location_id', '=', loc))
      .leftJoin('employee_kiosk_pins as p', (j) => j.onRef('p.employee_id', '=', 'e.id').on('p.location_id', '=', loc))
      .select(['e.id', 'e.first', 'e.last', 'e.status', 'e.kiosk_listed', 'p.set_at as pin_set_at', 'p.set_by_name as pin_set_by'])
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
      yourAddress,
      yourAddressIsShop: !!(await this.matchNetwork(db, loc, yourAddress)),
      canManageNetworks: admin.isSuper,
      networks: await this.networkViews(db, loc),
      refused: await this.refusedViews(db, loc),
      thisDeviceId: thisDevice && !thisDevice.revoked_at && thisDevice.location_id === loc ? thisDevice.id : null,
      devices: await this.deviceViews(db, loc),
      staff: staff.map((e) => ({
        id: e.id,
        name: displayName(e.first, e.last),
        status: e.status,
        listed: e.kiosk_listed,
        pin: e.pin_set_at ? { setAt: e.pin_set_at.toISOString(), setBy: e.pin_set_by } : null,
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

  /**
   * PUT /kiosk/settings: turning kiosk mode off ends every kiosk session. Either change also signs out every manager on a kiosk browser
   * (the tablets go to the keypad, or to the sign-in page when mode is off); `signedOut` says whether that included the caller.
   */
  async setEnabled(
    admin: KioskAdmin,
    enabled: boolean,
    version: number,
  ): Promise<{ enabled: boolean; version: number; signedOut: boolean }> {
    return transaction(this.d.db, async (tx) => {
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
      const ended =
        before !== enabled || !enabled
          ? await revokeUserSessionsOnKiosks(tx, this.d.clock, { locationId: admin.locationId })
          : []
      return { enabled: rec.value, version: rec.version, signedOut: ended.includes(admin.sessionId) }
    })
  }

  /**
   * PUT /kiosk/staff/:employeeId/pin: a PIN the manager typed, or a generated one (returned once). The rules; not used by anyone else
   * in the shop (a neutral "Choose another PIN"); not one of the employee's last 3. Nothing is locked: the tablet stays open.
   */
  async setPin(
    admin: KioskAdmin,
    employeeId: string,
    input: { pin?: string; generate?: boolean },
  ): Promise<{ employeeId: string; setAt: string; pin?: string }> {
    if (!isUuid(employeeId)) throw new AppError('NOT_FOUND')
    const generated = input.generate === true
    const reject = (message: string): AppError =>
      new AppError('KIOSK_PIN_REJECTED', { detail: message, errors: [{ path: 'body.pin', message }] })
    for (let attempt = 0; ; attempt++) {
      const pin = generated ? generatePin() : (input.pin ?? '')
      const problem = pinProblem(pin)
      if (problem) throw reject(problem)
      const lookup = pinLookup(this.d.pinKey, admin.locationId, pin)
      const r = await this.writePin(admin, employeeId, lookup, generated).catch((e: unknown) => {
        if (isUniqueViolation(e, 'employee_kiosk_pins_lookup_uq')) return 'taken' as const // the same PIN set for someone else meanwhile
        throw e
      })
      if (r === 'taken' || r === 'reused') {
        if (generated && attempt < 20) continue // astronomically unlikely: draw again
        throw reject(r === 'taken' ? TAKEN_PIN_PROBLEM : REUSED_PIN_PROBLEM)
      }
      return generated ? { employeeId, setAt: r.toISOString(), pin } : { employeeId, setAt: r.toISOString() }
    }
  }

  private writePin(admin: KioskAdmin, employeeId: string, lookup: string, generated: boolean): Promise<Date | 'taken' | 'reused'> {
    return transaction(this.d.db, async (tx) => {
      const e = await this.lockEmployee(tx, admin.locationId, employeeId)
      if (e.status === 'inactive') throw new AppError('KIOSK_PIN_INACTIVE')
      const current = await tx
        .selectFrom('employee_kiosk_pins')
        .select(['pin_lookup', 'set_at'])
        .where('employee_id', '=', employeeId)
        .executeTakeFirst()
      const previous = await tx
        .selectFrom('employee_kiosk_pin_history')
        .select('pin_lookup')
        .where('employee_id', '=', employeeId)
        .orderBy('id', 'desc')
        .limit(KIOSK_PIN_HISTORY - (current ? 1 : 0))
        .execute()
      if (current?.pin_lookup === lookup || previous.some((p) => p.pin_lookup === lookup)) return 'reused'
      const taken = await tx
        .selectFrom('employee_kiosk_pins')
        .select('employee_id')
        .where('location_id', '=', admin.locationId)
        .where('pin_lookup', '=', lookup)
        .where('employee_id', '<>', employeeId)
        .executeTakeFirst()
      if (taken) return 'taken'
      const now = this.d.clock.now()
      if (current) {
        await tx
          .insertInto('employee_kiosk_pin_history')
          .values({ employee_id: employeeId, pin_lookup: current.pin_lookup, set_at: current.set_at, retired_at: now })
          .execute()
        await this.trimPinHistory(tx, employeeId)
        await tx
          .updateTable('employee_kiosk_pins')
          .set({ pin_lookup: lookup, location_id: admin.locationId, set_at: now, set_by: admin.userId, set_by_name: admin.name })
          .where('employee_id', '=', employeeId)
          .execute()
      } else {
        await tx
          .insertInto('employee_kiosk_pins')
          .values({
            employee_id: employeeId,
            location_id: admin.locationId,
            pin_lookup: lookup,
            set_at: now,
            set_by: admin.userId,
            set_by_name: admin.name,
          })
          .execute()
      }
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.pin.set',
        entityType: 'employee',
        entityId: employeeId,
        after: { name: displayName(e.first, e.last), generated, replaced: !!current }, // never the PIN
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
      return now
    })
  }

  /** DELETE /kiosk/staff/:employeeId/pin: the PIN stops working (it joins the employee's history). No PIN: nothing to do. */
  async removePin(admin: KioskAdmin, employeeId: string): Promise<void> {
    if (!isUuid(employeeId)) throw new AppError('NOT_FOUND')
    await transaction(this.d.db, async (tx) => {
      const e = await this.lockEmployee(tx, admin.locationId, employeeId)
      const gone = await tx
        .deleteFrom('employee_kiosk_pins')
        .where('employee_id', '=', employeeId)
        .returning(['pin_lookup', 'set_at'])
        .executeTakeFirst()
      if (!gone) return
      await tx
        .insertInto('employee_kiosk_pin_history')
        .values({ employee_id: employeeId, pin_lookup: gone.pin_lookup, set_at: gone.set_at, retired_at: this.d.clock.now() })
        .execute()
      await this.trimPinHistory(tx, employeeId)
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.pin.remove',
        entityType: 'employee',
        entityId: employeeId,
        after: { name: displayName(e.first, e.last) },
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
    })
  }

  /**
   * POST /kiosk/networks, Super Admin only. `{confirmAddress}`: "This is the shop's network" adds THE CALLER's address (IPv4, or its
   * IPv6 /64), and only when it is still the address the screen showed (409 KIOSK_ADDRESS_CHANGED: a phone that moved between the
   * Wi-Fi and mobile data meanwhile cannot add the wrong one). `{address}`: approves an address of the refused list, from anywhere
   * (404 KIOSK_REFUSED_UNKNOWN for any other). Adding one that is already a shop network changes nothing (`created: false`).
   */
  async addNetwork(
    admin: KioskAdmin,
    input: { label?: string | null; confirmAddress?: string; address?: string },
  ): Promise<{ network: KioskNetworkView; created: boolean }> {
    if (!admin.isSuper) throw new AppError('SUPER_ONLY')
    const loc = admin.locationId
    let cidr: string
    let source: 'this_connection' | 'refused'
    if (input.confirmAddress !== undefined) {
      const caller = callerAddress(admin.ip)
      const here = networkOf(caller)
      if (!here || networkOf(input.confirmAddress) !== here)
        throw new AppError('KIOSK_ADDRESS_CHANGED', { meta: { yourAddress: caller } })
      cidr = here
      source = 'this_connection'
    } else {
      const asked = networkOf(input.address)
      const listed = asked
        ? await this.d.db
            .selectFrom('kiosk_refused_networks')
            .select('id')
            .where('location_id', '=', loc)
            .where(sql<boolean>`cidr = ${asked}::cidr`)
            .executeTakeFirst()
        : undefined
      if (!asked || !listed) throw new AppError('KIOSK_REFUSED_UNKNOWN')
      cidr = asked
      source = 'refused'
    }
    const label = input.label?.trim() || null
    const r = await transaction(this.d.db, async (tx) => {
      // two adds of the same address at once take turns on the shop's row (the second one then finds the first's)
      await tx.selectFrom('locations').select('id').where('id', '=', loc).forNoKeyUpdate().executeTakeFirstOrThrow()
      const existing = await tx
        .selectFrom('kiosk_networks')
        .select('id')
        .where('location_id', '=', loc)
        .where(sql<boolean>`cidr = ${cidr}::cidr`)
        .executeTakeFirst()
      if (existing) return { id: existing.id, created: false }
      const id = this.d.newId()
      await tx
        .insertInto('kiosk_networks')
        .values({
          id,
          location_id: loc,
          cidr,
          label,
          added_by: admin.userId,
          added_by_name: admin.name,
          added_at: this.d.clock.now(),
        })
        .execute()
      await tx.deleteFrom('kiosk_refused_networks').where('location_id', '=', loc).where(sql<boolean>`cidr = ${cidr}::cidr`).execute()
      await audit.record(tx, {
        locationId: loc,
        action: 'kiosk.network.add',
        entityType: 'kiosk_network',
        entityId: id,
        after: { address: networkLabel(cidr), label, source },
        ctx: admin.audit,
      })
      await this.changed(tx, loc)
      return { id, created: true }
    })
    return { network: await this.networkView(this.d.db, loc, r.id), created: r.created }
  }

  /** DELETE /kiosk/networks/:id, Super Admin only: PINs stop working from that address (open kiosks stay open until they lock). */
  async removeNetwork(admin: KioskAdmin, id: string): Promise<void> {
    if (!admin.isSuper) throw new AppError('SUPER_ONLY')
    if (!isUuid(id)) throw new AppError('NOT_FOUND')
    await transaction(this.d.db, async (tx) => {
      const gone = await tx
        .deleteFrom('kiosk_networks')
        .where('id', '=', id)
        .where('location_id', '=', admin.locationId)
        .returning(['cidr', 'label'])
        .executeTakeFirst()
      if (!gone) throw new AppError('NOT_FOUND')
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.network.remove',
        entityType: 'kiosk_network',
        entityId: id,
        before: { address: networkLabel(gone.cidr), label: gone.label },
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
    })
  }

  /** POST /kiosk/networks/:id/clear-lockout (a manager): the shop address's wrong-PIN counter starts over. */
  async clearNetworkLockout(admin: KioskAdmin, id: string): Promise<KioskNetworkView> {
    if (!isUuid(id)) throw new AppError('NOT_FOUND')
    await transaction(this.d.db, async (tx) => {
      const n = await tx
        .selectFrom('kiosk_networks')
        .selectAll()
        .where('id', '=', id)
        .where('location_id', '=', admin.locationId)
        .forUpdate()
        .executeTakeFirst()
      if (!n) throw new AppError('NOT_FOUND')
      await tx
        .updateTable('kiosk_networks')
        .set({ failed_attempts: 0, last_failed_at: null, locked_out_at: null })
        .where('id', '=', id)
        .execute()
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.network.lockout.clear',
        entityType: 'kiosk_network',
        entityId: id,
        before: { failures: n.failed_attempts, lockedOut: !!n.locked_out_at },
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
    })
    return this.networkView(this.d.db, admin.locationId, id)
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

  /**
   * DELETE /kiosk/devices/:id: the browser's cookie stops working for good, its kiosk session ends and so does any manager signed in on
   * it. Returns whether that included the caller. (A PIN typed later on that browser, at the shop, makes it a new shop browser.)
   */
  async revokeDevice(admin: KioskAdmin, id: string): Promise<{ signedOut: boolean }> {
    return transaction(this.d.db, async (tx) => {
      const dev = await this.lockDeviceRow(tx, admin.locationId, id)
      if (dev.revoked_at) return { signedOut: false }
      await tx
        .updateTable('kiosk_devices')
        .set({ revoked_at: this.d.clock.now(), revoked_by: admin.userId, version: dev.version + 1 })
        .where('id', '=', id)
        .execute()
      await revokeKioskSessions(tx, this.d.clock, { deviceId: id }, 'device_revoked')
      const ended = await revokeUserSessionsOnKiosks(tx, this.d.clock, { deviceId: id })
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.device.revoke',
        entityType: 'kiosk_device',
        entityId: id,
        ...(ended.length ? { after: { managersSignedOut: ended.length } } : {}),
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
      return { signedOut: ended.includes(admin.sessionId) }
    })
  }

  /** POST /kiosk/devices/:id/lock: its kiosk session ends, and so does any manager signed in on it. */
  async lockDevice(admin: KioskAdmin, id: string): Promise<{ signedOut: boolean }> {
    return transaction(this.d.db, async (tx) => {
      await this.lockDeviceRow(tx, admin.locationId, id)
      const n = await revokeKioskSessions(tx, this.d.clock, { deviceId: id }, 'lock_device')
      const ended = await revokeUserSessionsOnKiosks(tx, this.d.clock, { deviceId: id })
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.device.lock',
        entityType: 'kiosk_device',
        entityId: id,
        after: { locked: n, ...(ended.length ? { managersSignedOut: ended.length } : {}) },
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
      return { signedOut: ended.includes(admin.sessionId) }
    })
  }

  /** POST /kiosk/devices/:id/clear-lockout: the browser's wrong-PIN counter starts over. */
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

  /** POST /kiosk/lock-all: every kiosk session ends, and so does every manager signed in on a kiosk browser. */
  async lockAll(admin: KioskAdmin): Promise<{ locked: number; signedOut: boolean }> {
    return transaction(this.d.db, async (tx) => {
      // take the shop's network rows, then its device rows, in the order an unlock takes them: an unlock in progress (a first one
      // too, which creates its browser) finishes first and its new session is then ended here; an unlock that comes after waits and
      // opens its session after Lock all
      await tx
        .selectFrom('kiosk_networks')
        .select('id')
        .where('location_id', '=', admin.locationId)
        .orderBy('id')
        .forUpdate()
        .execute()
      await tx
        .selectFrom('kiosk_devices')
        .select('id')
        .where('location_id', '=', admin.locationId)
        .orderBy('id')
        .forUpdate()
        .execute()
      const n = await revokeKioskSessions(tx, this.d.clock, { locationId: admin.locationId }, 'lock_all')
      const ended = await revokeUserSessionsOnKiosks(tx, this.d.clock, { locationId: admin.locationId })
      await audit.record(tx, {
        locationId: admin.locationId,
        action: 'kiosk.lock_all',
        entityType: 'location',
        entityId: admin.locationId,
        after: { locked: n, ...(ended.length ? { managersSignedOut: ended.length } : {}) },
        ctx: admin.audit,
      })
      await this.changed(tx, admin.locationId)
      return { locked: n, signedOut: ended.includes(admin.sessionId) }
    })
  }

  /** PUT /kiosk/staff/:employeeId: "Shows on the kiosk" (a hidden employee's PIN does not open the kiosk either). */
  async setListed(
    admin: KioskAdmin,
    employeeId: string,
    listed: boolean,
  ): Promise<{ id: string; name: string; status: 'active' | 'invited' | 'inactive'; listed: boolean }> {
    if (!isUuid(employeeId)) throw new AppError('NOT_FOUND')
    return transaction(this.d.db, async (tx) => {
      const e = await this.lockEmployee(tx, admin.locationId, employeeId)
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

  /** The shop network `address` belongs to (IPv4 exact, IPv6 by its /64), or null. */
  private async matchNetwork(db: Executor, locationId: string, address: string | null): Promise<NetworkRow | null> {
    if (!address) return null
    const row = await db
      .selectFrom('kiosk_networks')
      .selectAll()
      .where('location_id', '=', locationId)
      .where(sql<boolean>`cidr >>= ${address}::inet`)
      .orderBy('added_at')
      .executeTakeFirst()
    return row ?? null
  }

  private async hasNetworks(db: Executor, locationId: string): Promise<boolean> {
    return !!(await db.selectFrom('kiosk_networks').select('id').where('location_id', '=', locationId).limit(1).executeTakeFirst())
  }

  /**
   * Lists a PIN tried from an address that is not a shop network, for the Super Admin to approve: one row per address (/32 or /64),
   * written at most once a minute per address (the guard counts the tries in between), with the browser when the try carried the
   * cookie of one that unlocked at the shop before. Rows older than 30 days go, and past 50 rows the oldest of unknown browsers go
   * first, so a flood of addresses can neither grow the table nor push out the shop tablet's entry.
   */
  private async recordRefused(locationId: string, address: string | null, device: DeviceRow | null): Promise<void> {
    const cidr = networkOf(address)
    if (!cidr) return
    const add = this.d.guard.refusedTry(cidr)
    if (add === 0) return
    const now = this.d.clock.now()
    await transaction(this.d.db, async (tx) => {
      await tx
        .insertInto('kiosk_refused_networks')
        .values({
          id: this.d.newId(),
          location_id: locationId,
          cidr,
          first_seen_at: now,
          last_seen_at: now,
          attempts: add,
          known_device_id: device?.id ?? null,
          known_device_name: device?.name ?? null,
        })
        .onConflict((oc) =>
          oc.columns(['location_id', 'cidr']).doUpdateSet((eb) => ({
            last_seen_at: now,
            attempts: sql<number>`least(${eb.ref('kiosk_refused_networks.attempts')} + ${add}, 1000000000)`,
            known_device_id: sql<string | null>`coalesce(${eb.ref('excluded.known_device_id')}, ${eb.ref('kiosk_refused_networks.known_device_id')})`,
            known_device_name: sql<string | null>`case when ${eb.ref('excluded.known_device_id')} is not null
              then ${eb.ref('excluded.known_device_name')} else ${eb.ref('kiosk_refused_networks.known_device_name')} end`,
          })),
        )
        .execute()
      await tx
        .deleteFrom('kiosk_refused_networks')
        .where('location_id', '=', locationId)
        .where('last_seen_at', '<', new Date(now.getTime() - KIOSK_REFUSED_KEEP_DAYS * DAY_MS))
        .execute()
      await sql`
        delete from kiosk_refused_networks where id in (
          select id from kiosk_refused_networks where location_id = ${locationId}::uuid
          order by (known_device_id is not null) desc, last_seen_at desc, id desc
          offset ${KIOSK_REFUSED_MAX_ROWS})`.execute(tx)
      // Settings → Kiosk refreshes for the tablet's own tries (the likely "the provider changed the address"), never for a flood
      if (device) await this.changed(tx, locationId)
    })
  }

  /** A browser's first unlock at the shop: "Shop browser N · Safari on iPad", its token for the device cookie. */
  private async newBrowser(
    tx: Tx,
    locationId: string,
    opener: { id: string; name: string },
    meta: ClientMeta,
  ): Promise<{ id: string; name: string; token: string }> {
    // one name at a time per shop (two first unlocks at once still get different numbers)
    await tx.selectFrom('locations').select('id').where('id', '=', locationId).forNoKeyUpdate().executeTakeFirstOrThrow()
    const count = await tx
      .selectFrom('kiosk_devices')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('location_id', '=', locationId)
      .executeTakeFirstOrThrow()
    const summary = browserSummary(meta.ua)
    const name = `Shop browser ${Number(count.n) + 1}${summary ? ` · ${summary}` : ''}`.slice(0, 40).trim()
    const token = newToken()
    const id = this.d.newId()
    const now = this.d.clock.now()
    await tx
      .insertInto('kiosk_devices')
      .values({
        id,
        location_id: locationId,
        name,
        token_hash: hashToken(token),
        created_at: now,
        created_by: null,
        created_by_name: opener.name,
        last_seen_at: now,
        last_ip: clientIp(meta.ip),
        last_ua: clientUa(meta.ua),
      })
      .execute()
    return { id, name, token }
  }

  private async meOf(s: {
    sessionId: string
    csrfSecret: string
    device: { id: string; name: string }
    openedBy: { id: string | null; name: string }
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
      openedBy: s.openedBy,
      permissions,
      limits: {},
      csrfToken: csrfTokenFor(s.csrfSecret, s.sessionId),
      staff: await listKioskStaff(this.d.db, s.locationId),
      businessTz: s.tz,
      serverTime: this.d.clock.now().toISOString(),
    }
  }

  /** The audit context of a keypad request with no PIN match: the browser (or an unknown browser) as the actor. */
  private keypadAudit(dev: { id: string; name: string } | null, meta: ClientMeta): AuditContext {
    return {
      actor: { userId: null, employeeId: null, name: dev ? `Kiosk · ${dev.name}` : 'Kiosk · new browser', roles: 'Kiosk' },
      requestId: meta.requestId ?? null,
      ip: meta.ip ?? null,
      kioskDeviceId: dev?.id ?? null,
    }
  }

  private async lockEmployee(tx: Tx, locationId: string, employeeId: string) {
    const e = await tx
      .selectFrom('employees as e')
      .innerJoin('employee_locations as el', (j) => j.onRef('el.employee_id', '=', 'e.id').on('el.location_id', '=', locationId))
      .select(['e.id', 'e.first', 'e.last', 'e.status', 'e.kiosk_listed'])
      .where('e.id', '=', employeeId)
      .forUpdate()
      .executeTakeFirst()
    if (!e) throw new AppError('NOT_FOUND')
    return e
  }

  private async trimPinHistory(tx: Tx, employeeId: string): Promise<void> {
    await sql`
      delete from employee_kiosk_pin_history where employee_id = ${employeeId}::uuid and id not in (
        select id from employee_kiosk_pin_history where employee_id = ${employeeId}::uuid order by id desc limit ${PIN_HISTORY_KEEP})`.execute(
      tx,
    )
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

  private async networkViews(db: Executor, locationId: string, id?: string): Promise<KioskNetworkView[]> {
    let q = db.selectFrom('kiosk_networks').selectAll().where('location_id', '=', locationId)
    if (id) q = q.where('id', '=', id)
    const rows = await q.orderBy('added_at').orderBy('id').execute()
    return rows.map((n) => ({
      id: n.id,
      address: networkLabel(n.cidr),
      label: n.label,
      addedBy: n.added_by_name,
      addedAt: n.added_at.toISOString(),
      lastSeenAt: n.last_seen_at ? n.last_seen_at.toISOString() : null,
      failedAttempts: n.failed_attempts,
      lockedOut: !!n.locked_out_at,
    }))
  }

  private async networkView(db: Executor, locationId: string, id: string): Promise<KioskNetworkView> {
    const [v] = await this.networkViews(db, locationId, id)
    if (!v) throw new AppError('NOT_FOUND')
    return v
  }

  private async refusedViews(db: Executor, locationId: string): Promise<KioskRefusedView[]> {
    const since = new Date(this.d.clock.now().getTime() - KIOSK_REFUSED_KEEP_DAYS * DAY_MS)
    const rows = await db
      .selectFrom('kiosk_refused_networks as r')
      .leftJoin('kiosk_devices as d', 'd.id', 'r.known_device_id')
      .select(['r.id', 'r.cidr', 'r.first_seen_at', 'r.last_seen_at', 'r.attempts', 'r.known_device_id', 'r.known_device_name', 'd.name'])
      .where('r.location_id', '=', locationId)
      .where('r.last_seen_at', '>=', since)
      .orderBy('r.last_seen_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(KIOSK_REFUSED_MAX_ROWS)
      .execute()
    return rows.map((r) => ({
      id: r.id,
      address: networkLabel(r.cidr),
      firstSeenAt: r.first_seen_at.toISOString(),
      lastSeenAt: r.last_seen_at.toISOString(),
      attempts: r.attempts,
      fromKnownBrowser: !!r.known_device_id || !!r.known_device_name,
      browserName: r.name ?? r.known_device_name,
    }))
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
        eb
          .selectFrom('kiosk_sessions as s')
          .select('s.opened_by_name')
          .whereRef('s.device_id', '=', 'd.id')
          .where('s.revoked_at', 'is', null)
          .where('s.expires_at', '>', now)
          .orderBy('s.created_at', 'desc')
          .limit(1)
          .as('opened_by'),
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
        openedBy: state === 'unlocked' ? (r.opened_by ?? null) : null,
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
