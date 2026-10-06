// Arrival and check-in settings (geofence radius, prep alert, automation toggles).
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import * as audit from '../../platform/audit.js'
import './schema.js'
import { recordChange } from './changes.js'
import { ensureDomainDefaults } from './defaults.js'
import { throwIfInvalid, type ValidationIssue } from './hours.js'

export const RADIUS_METERS = [150, 300, 500] as const
export const PREP_AT_MINUTES = [10, 15, 20] as const

export interface ArrivalSettings {
  enabled: boolean
  radiusM: number
  prepAtMin: number
  autoArrive: boolean
  welcome: boolean
  alertCrew: boolean
  vipFirst: boolean
}

export const DEFAULT_ARRIVAL_SETTINGS: ArrivalSettings = {
  enabled: true,
  radiusM: 300,
  prepAtMin: 15,
  autoArrive: true,
  welcome: true,
  alertCrew: true,
  vipFirst: true,
}

export function validateArrivalSettings(p: Partial<ArrivalSettings>): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (p.radiusM !== undefined && !(RADIUS_METERS as readonly number[]).includes(p.radiusM))
    issues.push({ path: 'radiusM', message: 'The check-in radius is 150, 300 or 500 m.' })
  if (p.prepAtMin !== undefined && !(PREP_AT_MINUTES as readonly number[]).includes(p.prepAtMin))
    issues.push({ path: 'prepAtMin', message: 'The prep alert is 10, 15 or 20 minutes out.' })
  for (const k of ['enabled', 'autoArrive', 'welcome', 'alertCrew', 'vipFirst'] as const)
    if (p[k] !== undefined && typeof p[k] !== 'boolean')
      issues.push({ path: k, message: 'Must be on or off.' })
  return issues
}

const COLUMNS = [
  'enabled',
  'radius_m',
  'prep_at_min',
  'auto_arrive',
  'welcome',
  'alert_crew',
  'vip_first',
  'version',
] as const

type Row = {
  enabled: boolean
  radius_m: number
  prep_at_min: number
  auto_arrive: boolean
  welcome: boolean
  alert_crew: boolean
  vip_first: boolean
  version: number
}

const toSettings = (r: Row): ArrivalSettings => ({
  enabled: r.enabled,
  radiusM: r.radius_m,
  prepAtMin: r.prep_at_min,
  autoArrive: r.auto_arrive,
  welcome: r.welcome,
  alertCrew: r.alert_crew,
  vipFirst: r.vip_first,
})

export async function getArrivalSettings(
  db: Executor,
  locationId: string,
): Promise<{ settings: ArrivalSettings; version: number }> {
  const r = await db
    .selectFrom('arrival_settings')
    .select([...COLUMNS])
    .where('location_id', '=', locationId)
    .executeTakeFirst()
  return r
    ? { settings: toSettings(r), version: r.version }
    : { settings: { ...DEFAULT_ARRIVAL_SETTINGS }, version: 0 }
}

export async function saveArrivalSettings(
  tx: Tx,
  input: {
    locationId: string
    patch: Partial<ArrivalSettings>
    expectedVersion?: number
    updatedBy?: string | null
    audit?: audit.AuditContext
  },
): Promise<{ settings: ArrivalSettings; version: number; changed: boolean }> {
  throwIfInvalid(validateArrivalSettings(input.patch))
  await ensureDomainDefaults(tx, input.locationId)
  const locked = await tx
    .selectFrom('arrival_settings')
    .select([...COLUMNS])
    .where('location_id', '=', input.locationId)
    .forUpdate()
    .executeTakeFirstOrThrow()
  if (input.expectedVersion !== undefined && input.expectedVersion !== locked.version)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: locked.version } })
  const before = toSettings(locked)
  const next: ArrivalSettings = { ...before, ...input.patch }
  if (JSON.stringify(next) === JSON.stringify(before))
    return { settings: before, version: locked.version, changed: false }
  const updated = await tx
    .updateTable('arrival_settings')
    .set((eb) => ({
      enabled: next.enabled,
      radius_m: next.radiusM,
      prep_at_min: next.prepAtMin,
      auto_arrive: next.autoArrive,
      welcome: next.welcome,
      alert_crew: next.alertCrew,
      vip_first: next.vipFirst,
      version: eb('version', '+', 1),
      updated_by: input.updatedBy ?? null,
      updated_at: eb.fn('app_now', []),
    }))
    .where('location_id', '=', input.locationId)
    .returning('version')
    .executeTakeFirstOrThrow()
  await recordChange(tx, {
    locationId: input.locationId,
    action: 'settings.arrival.update',
    entityType: 'arrival_settings',
    entityId: 'arrival',
    before,
    after: next,
    section: 'arrival',
    version: updated.version,
    audit: input.audit,
  })
  return { settings: next, version: updated.version, changed: true }
}
