// Shared types and small helpers for the scheduling services: the per-call context (clock, ids, location, ports) and
// the settings bundle every read model and guard needs.
import type { AuthContext } from '../../http/authorizer.js'
import { hasPermission } from '../../http/authorizer.js'
import type { AuditContext } from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import type { Executor } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { getLocation } from '../../platform/locations.js'
import { getSetting } from '../../platform/settings.js'
import { displayName } from '../auth/context.js'
import { isSessionContext } from '../auth/context.js'
import { getArrivalSettings, type ArrivalSettings } from '../settings/arrival.js'
import { getBookingRules, getHours, type BookingRules, type HoursDay } from '../settings/hours.js'
import { getVipSettings, type VipSettings } from '../settings/vip.js'
import type { SchedulingPorts } from './ports.js'

export interface SchedulingCtx {
  clock: Clock
  newId: NewId
  locationId: string
  tz: string
  ports: SchedulingPorts
}

/** Who is acting: the resolved auth context and what the audit log records about the request. */
export interface Actor {
  auth: AuthContext
  audit: AuditContext
}

export const can = (a: Actor, perm: string): boolean => hasPermission(a.auth, perm)

/** The acting employee's display name ("Marco R.") for the activity log. */
export function actorName(a: Actor | null | undefined): string | null {
  if (!a) return null
  if (isSessionContext(a.auth)) return displayName(a.auth.employee.first, a.auth.employee.last)
  return a.auth.actorName ?? null
}

export interface OpsSettings {
  lateGraceMin: number
  etaVisibleMaxMin: number
  prepAtMin: number
  vipFirst: boolean
  autoArrive: boolean
  welcome: boolean
  arrivalEnabled: boolean
}

export interface SettingsBundle {
  hours: HoursDay[]
  rules: BookingRules
  vip: VipSettings
  arrival: ArrivalSettings
  ops: OpsSettings
}

export async function loadSettingsBundle(db: Executor, locationId: string): Promise<SettingsBundle> {
  const [hours, rules, vip, arrival, late, eta] = await Promise.all([
    getHours(db, locationId),
    getBookingRules(db, locationId),
    getVipSettings(db, locationId),
    getArrivalSettings(db, locationId),
    getSetting(db, locationId, 'ops.late_grace_min'),
    getSetting(db, locationId, 'ops.eta_visible_max_min'),
  ])
  return {
    hours,
    rules: rules.rules,
    vip: vip.settings,
    arrival: arrival.settings,
    ops: {
      lateGraceMin: late.value,
      etaVisibleMaxMin: eta.value,
      prepAtMin: arrival.settings.prepAtMin,
      vipFirst: arrival.settings.vipFirst,
      autoArrive: arrival.settings.autoArrive,
      welcome: arrival.settings.welcome,
      arrivalEnabled: arrival.settings.enabled,
    },
  }
}

const tzCache = new Map<string, string>()

/** The location's business time zone (cached: it changes with a migration, not at runtime). */
export async function locationTimezone(db: Executor, locationId: string): Promise<string> {
  const hit = tzCache.get(locationId)
  if (hit) return hit
  const loc = await getLocation(db, locationId)
  const tz = loc?.timezone ?? 'America/New_York'
  tzCache.set(locationId, tz)
  return tz
}

export const firstName = (full: string): string => full.trim().split(/\s+/)[0] ?? full
