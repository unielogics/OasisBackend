// Wiring of the identity services (sessions, RBAC engine, auth flows, people) and the Authorizer built on them.
// src/server.ts builds one Identity at boot and hands identity.authorizer to the app; the route modules find the same
// instance through the authorizer, or build a private one over the app's own dependencies (tests, openapi generation).
import type { Env } from '../../config/env.js'
import type { Authorizer } from '../../http/authorizer.js'
import type { Clock } from '../../platform/clock.js'
import type { Db } from '../../platform/db.js'
import { createIdGenerator, type NewId } from '../../platform/ids.js'
import { RbacService } from '../rbac/service.js'
import { PeopleService } from '../people/employees.js'
import { RolesService } from '../people/roles.js'
import { unconfiguredBusinessHours, type BusinessHoursPort } from '../people/business-hours.js'
import { KioskNetworkCache } from '../kiosk/network.js'
import { kioskKey } from '../kiosk/pin.js'
import { KioskService } from '../kiosk/service.js'
import { KioskUnlockGuard } from '../kiosk/throttle.js'
import { createSessionAuthorizer } from './authorizer.js'
import './problems.js'
import { InMemoryNotifier, type NotificationPort } from './notifications.js'
import { PasswordHasher, DEFAULT_SCRYPT_PARAMS, type ScryptParams } from './password.js'
import { AuthService } from './service.js'
import { DEFAULT_SESSION_TIMINGS, SessionService, type SessionTimings } from './sessions.js'
import { DEFAULT_THROTTLE, LoginThrottle, type ThrottleOptions } from './throttle.js'

export type IdentityEnv = Pick<
  Env,
  'NODE_ENV' | 'COOKIE_SECURE' | 'SESSION_COOKIE_NAME' | 'PUBLIC_DASHBOARD_URL'
> & {
  /** The kiosk PIN key derives from it (ADR 0180); a fixed development value stands in outside production. */
  SESSION_SECRET?: string
}

export interface IdentityOptions {
  db: Db
  clock: Clock
  env: IdentityEnv
  newId?: NewId
  /** Location used for audit rows and for employees that have no location link yet. */
  locationId: string
  notifier?: NotificationPort
  businessHours?: BusinessHoursPort
  passwordParams?: ScryptParams
  sessionTimings?: SessionTimings
  throttle?: ThrottleOptions
  warn?: (msg: string, data?: Record<string, unknown>) => void
}

export interface Identity {
  readonly db: Db
  readonly clock: Clock
  readonly newId: NewId
  readonly env: IdentityEnv
  readonly locationId: string
  readonly rbac: RbacService
  readonly sessions: SessionService
  readonly hasher: PasswordHasher
  readonly throttle: LoginThrottle
  readonly notifier: NotificationPort
  readonly businessHours: BusinessHoursPort
  readonly auth: AuthService
  readonly people: PeopleService
  readonly roles: RolesService
  /** Kiosk mode (ADR 0180): employees' PINs, the shop's networks, shop browsers, kiosk sessions, the acting employee. */
  readonly kiosk: KioskService
  readonly kioskGuard: KioskUnlockGuard
  /** The kiosk's in-memory shop-network answers (30 s) and last-seen write throttle. */
  readonly kioskNetworks: KioskNetworkCache
  readonly authorizer: Authorizer
}

export type IdentityAuthorizer = Authorizer & { readonly identity: Identity }

export function createIdentity(o: IdentityOptions): IdentityAuthorizer {
  const newId = o.newId ?? createIdGenerator(o.clock)
  const rbac = new RbacService(o.db)
  const sessions = new SessionService(o.db, o.clock, o.sessionTimings ?? DEFAULT_SESSION_TIMINGS)
  const hasher = new PasswordHasher(o.passwordParams ?? DEFAULT_SCRYPT_PARAMS)
  const throttle = new LoginThrottle(o.clock, o.throttle ?? DEFAULT_THROTTLE)
  const notifier = o.notifier ?? new InMemoryNotifier()
  const kioskGuard = new KioskUnlockGuard(o.clock)
  const kioskNetworks = new KioskNetworkCache(() => o.clock.now().getTime())
  const kiosk = new KioskService({
    db: o.db,
    clock: o.clock,
    newId,
    env: o.env,
    pinKey: kioskKey(o.env),
    guard: kioskGuard,
    networks: kioskNetworks,
    userSessions: sessions,
    defaultLocationId: o.locationId,
    warn: o.warn,
  })
  const businessHours = o.businessHours ?? unconfiguredBusinessHours
  const auth = new AuthService({
    db: o.db,
    clock: o.clock,
    newId,
    env: o.env,
    hasher,
    sessions,
    throttle,
    notifier,
    locationId: o.locationId,
    warn: o.warn,
    kioskDeviceOf: (token) => kiosk.liveDeviceId(token),
  })
  const people = new PeopleService({
    db: o.db,
    clock: o.clock,
    newId,
    auth,
    sessions,
    businessHours,
    warn: o.warn,
  })
  const roles = new RolesService({ db: o.db, newId })
  const base = createSessionAuthorizer({
    env: o.env,
    sessions,
    rbac,
    defaultLocationId: o.locationId,
    kiosk,
  })
  const identity: Identity = {
    db: o.db,
    clock: o.clock,
    newId,
    env: o.env,
    locationId: o.locationId,
    rbac,
    sessions,
    hasher,
    throttle,
    notifier,
    businessHours,
    auth,
    people,
    roles,
    kiosk,
    kioskGuard,
    kioskNetworks,
    authorizer: base,
  }
  return Object.assign(base, { identity })
}
