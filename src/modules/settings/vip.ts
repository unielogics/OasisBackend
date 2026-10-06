// VIP program: settings with the design's allowed values, weekly holds, and the VIP client list (resolved by customer id;
// a typed name returns candidates instead of guessing).
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError, registerProblems } from '../../platform/errors.js'
import * as audit from '../../platform/audit.js'
import { isUuid, type NewId } from '../../platform/ids.js'
import { maskPhone } from '../../platform/phone.js'
import { fmtT } from '../../platform/time.js'
import '../customers/schema.js'
import {
  findCustomersByName,
  listVehicles,
  requireCustomer,
  type CustomerRecord,
  type VehicleRecord,
} from '../customers/service.js'
import './schema.js'
import { recordChange } from './changes.js'
import { ensureDomainDefaults } from './defaults.js'
import { throwIfInvalid, type ValidationIssue } from './hours.js'
import { DAY_ABBR, DAY_NAMES } from './labels.js'

export const VIP_ERRORS = { holdTaken: 'That slot is already held' } as const

registerProblems({
  VIP_HOLD_EXISTS: { status: 409, title: VIP_ERRORS.holdTaken, detail: VIP_ERRORS.holdTaken },
})

export const RELEASE_HOURS = [24, 48, 72] as const
export const OFFER_MINUTES = [10, 15, 30] as const
export const CADENCES = ['weekly', 'biweekly', 'triweekly', 'monthly'] as const
export type Cadence = (typeof CADENCES)[number]
/** Labels of the cadence chips in the design. */
export const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  triweekly: 'Every 3 weeks',
  monthly: 'Monthly',
}

export interface VipSettings {
  releaseHours: number
  windowVipDays: number
  windowStdDays: number
  sameDayPerMonth: number
  waitlist: boolean
  offerMinutes: number
  standing: boolean
  autoConfirm: boolean
  cadences: Cadence[]
}

export const DEFAULT_VIP_SETTINGS: VipSettings = {
  releaseHours: 48,
  windowVipDays: 30,
  windowStdDays: 14,
  sameDayPerMonth: 2,
  waitlist: true,
  offerMinutes: 15,
  standing: true,
  autoConfirm: true,
  cadences: ['weekly', 'biweekly', 'monthly'],
}

const intIn = (v: unknown, min: number, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/**
 * Windows are validated as ranges (7-90 and 7-60 days), not as multiples of 7: the design's own defaults (30 and 14
 * days) are not on its stepper's 7-day grid, so the step is a UI affordance only.
 */
export function validateVipSettings(p: Partial<VipSettings>): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (p.releaseHours !== undefined && !(RELEASE_HOURS as readonly number[]).includes(p.releaseHours))
    issues.push({ path: 'releaseHours', message: 'Release holds 24, 48 or 72 hours before.' })
  if (p.windowVipDays !== undefined && !intIn(p.windowVipDays, 7, 90))
    issues.push({ path: 'windowVipDays', message: 'The VIP booking window is 7 to 90 days.' })
  if (p.windowStdDays !== undefined && !intIn(p.windowStdDays, 7, 60))
    issues.push({ path: 'windowStdDays', message: 'The standard booking window is 7 to 60 days.' })
  if (p.sameDayPerMonth !== undefined && !intIn(p.sameDayPerMonth, 0, 8))
    issues.push({ path: 'sameDayPerMonth', message: 'Same-day guarantee is 0 to 8 per month.' })
  if (p.offerMinutes !== undefined && !(OFFER_MINUTES as readonly number[]).includes(p.offerMinutes))
    issues.push({ path: 'offerMinutes', message: 'The waitlist claim window is 10, 15 or 30 minutes.' })
  if (p.cadences !== undefined) {
    if (!Array.isArray(p.cadences) || p.cadences.some((c) => !(CADENCES as readonly string[]).includes(c)))
      issues.push({ path: 'cadences', message: 'Cadences are weekly, biweekly, triweekly or monthly.' })
    else if (new Set(p.cadences).size !== p.cadences.length)
      issues.push({ path: 'cadences', message: 'Each cadence can be selected once.' })
  }
  for (const k of ['waitlist', 'standing', 'autoConfirm'] as const)
    if (p[k] !== undefined && typeof p[k] !== 'boolean')
      issues.push({ path: k, message: 'Must be on or off.' })
  return issues
}

type VipRow = {
  release_hours: number
  window_vip_days: number
  window_std_days: number
  same_day_per_month: number
  waitlist: boolean
  offer_minutes: number
  standing: boolean
  auto_confirm: boolean
  cadences: string[]
  version: number
}

const toSettings = (r: VipRow): VipSettings => ({
  releaseHours: r.release_hours,
  windowVipDays: r.window_vip_days,
  windowStdDays: r.window_std_days,
  sameDayPerMonth: r.same_day_per_month,
  waitlist: r.waitlist,
  offerMinutes: r.offer_minutes,
  standing: r.standing,
  autoConfirm: r.auto_confirm,
  cadences: CADENCES.filter((c) => r.cadences.includes(c)),
})

const VIP_COLUMNS = [
  'release_hours',
  'window_vip_days',
  'window_std_days',
  'same_day_per_month',
  'waitlist',
  'offer_minutes',
  'standing',
  'auto_confirm',
  'cadences',
  'version',
] as const

export async function getVipSettings(
  db: Executor,
  locationId: string,
): Promise<{ settings: VipSettings; version: number }> {
  const r = await db
    .selectFrom('vip_settings')
    .select([...VIP_COLUMNS])
    .where('location_id', '=', locationId)
    .executeTakeFirst()
  return r
    ? { settings: toSettings(r), version: r.version }
    : { settings: { ...DEFAULT_VIP_SETTINGS, cadences: [...DEFAULT_VIP_SETTINGS.cadences] }, version: 0 }
}

export async function saveVipSettings(
  tx: Tx,
  input: {
    locationId: string
    patch: Partial<VipSettings>
    expectedVersion?: number
    updatedBy?: string | null
    audit?: audit.AuditContext
  },
): Promise<{ settings: VipSettings; version: number; changed: boolean }> {
  throwIfInvalid(validateVipSettings(input.patch))
  await ensureDomainDefaults(tx, input.locationId)
  const locked = await tx
    .selectFrom('vip_settings')
    .select([...VIP_COLUMNS])
    .where('location_id', '=', input.locationId)
    .forUpdate()
    .executeTakeFirstOrThrow()
  if (input.expectedVersion !== undefined && input.expectedVersion !== locked.version)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: locked.version } })
  const before = toSettings(locked)
  const next: VipSettings = { ...before, ...input.patch }
  next.cadences = CADENCES.filter((c) => next.cadences.includes(c))
  if (JSON.stringify(next) === JSON.stringify(before))
    return { settings: before, version: locked.version, changed: false }
  const updated = await tx
    .updateTable('vip_settings')
    .set((eb) => ({
      release_hours: next.releaseHours,
      window_vip_days: next.windowVipDays,
      window_std_days: next.windowStdDays,
      same_day_per_month: next.sameDayPerMonth,
      waitlist: next.waitlist,
      offer_minutes: next.offerMinutes,
      standing: next.standing,
      auto_confirm: next.autoConfirm,
      cadences: [...next.cadences],
      version: eb('version', '+', 1),
      updated_by: input.updatedBy ?? null,
      updated_at: eb.fn('app_now', []),
    }))
    .where('location_id', '=', input.locationId)
    .returning('version')
    .executeTakeFirstOrThrow()
  await recordChange(tx, {
    locationId: input.locationId,
    action: 'settings.vip.update',
    entityType: 'vip_settings',
    entityId: 'vip',
    before,
    after: next,
    section: 'vip',
    version: updated.version,
    audit: input.audit,
  })
  return { settings: next, version: updated.version, changed: true }
}

// Holds -----------------------------------------------------------------------------------------------------------

export interface VipHold {
  id: string
  weekday: number
  timeMin: number
  /** "Saturday · 8:00 AM" */
  label: string
}

export const holdLabel = (weekday: number, timeMin: number): string =>
  `${DAY_NAMES[weekday]} · ${fmtT(timeMin)}`
/** "Sat 11:00 AM held for VIPs" (the toast). */
export const holdToast = (weekday: number, timeMin: number): string =>
  `${DAY_ABBR[weekday]} ${fmtT(timeMin)} held for VIPs`

/** Monday-first, then by time. */
export const holdSort = (
  a: { weekday: number; timeMin: number },
  b: { weekday: number; timeMin: number },
): number => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.timeMin - b.timeMin

export async function listVipHolds(db: Executor, locationId: string): Promise<VipHold[]> {
  const rows = await db
    .selectFrom('vip_holds')
    .select(['id', 'weekday', 'time_min'])
    .where('location_id', '=', locationId)
    .execute()
  return rows
    .map((r) => ({
      id: r.id,
      weekday: r.weekday,
      timeMin: r.time_min,
      label: holdLabel(r.weekday, r.time_min),
    }))
    .sort(holdSort)
}

export async function addVipHold(
  tx: Tx,
  input: { locationId: string; weekday: number; timeMin: number; newId: NewId; audit?: audit.AuditContext },
): Promise<VipHold> {
  const issues: ValidationIssue[] = []
  if (!intIn(input.weekday, 0, 6)) issues.push({ path: 'weekday', message: 'Pick a day of the week.' })
  if (!intIn(input.timeMin, 300, 1410) || input.timeMin % 30 !== 0)
    issues.push({
      path: 'time',
      message: `Pick a time from ${fmtT(300)} to ${fmtT(1410)} in 30-minute steps.`,
    })
  throwIfInvalid(issues)
  const id = input.newId()
  const inserted = await tx
    .insertInto('vip_holds')
    .values({ id, location_id: input.locationId, weekday: input.weekday, time_min: input.timeMin })
    .onConflict((oc) => oc.columns(['location_id', 'weekday', 'time_min']).doNothing())
    .returning('id')
    .executeTakeFirst()
  if (!inserted) throw new AppError('VIP_HOLD_EXISTS')
  await recordChange(tx, {
    locationId: input.locationId,
    action: 'settings.vip.hold.add',
    entityType: 'vip_hold',
    entityId: id,
    after: { weekday: input.weekday, timeMin: input.timeMin },
    section: 'vip',
    audit: input.audit,
  })
  return {
    id,
    weekday: input.weekday,
    timeMin: input.timeMin,
    label: holdLabel(input.weekday, input.timeMin),
  }
}

export async function removeVipHold(
  tx: Tx,
  input: { locationId: string; id: string; audit?: audit.AuditContext },
): Promise<VipHold> {
  const row = isUuid(input.id)
    ? await tx
        .deleteFrom('vip_holds')
        .where('location_id', '=', input.locationId)
        .where('id', '=', input.id)
        .returning(['id', 'weekday', 'time_min'])
        .executeTakeFirst()
    : undefined
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That hold does not exist' })
  await recordChange(tx, {
    locationId: input.locationId,
    action: 'settings.vip.hold.remove',
    entityType: 'vip_hold',
    entityId: row.id,
    before: { weekday: row.weekday, timeMin: row.time_min },
    section: 'vip',
    audit: input.audit,
  })
  return {
    id: row.id,
    weekday: row.weekday,
    timeMin: row.time_min,
    label: holdLabel(row.weekday, row.time_min),
  }
}

/** The instant a hold stops being VIP-only: release_hours before the slot. */
export const holdReleasesAt = (slotStart: Date, releaseHours: number): Date =>
  new Date(slotStart.getTime() - releaseHours * 3_600_000)

/** True when a non-VIP may book the held slot (now is at or past the release instant). */
export const isHoldReleased = (now: Date, slotStart: Date, releaseHours: number): boolean =>
  now.getTime() >= holdReleasesAt(slotStart, releaseHours).getTime()

// Clients ---------------------------------------------------------------------------------------------------------

export interface VipClient {
  customerId: string
  fullName: string
  addedAt: Date
}

export async function listVipClients(db: Executor, locationId: string): Promise<VipClient[]> {
  const rows = await db
    .selectFrom('vip_clients as v')
    .innerJoin('customers as c', 'c.id', 'v.customer_id')
    .select(['v.customer_id', 'c.full_name', 'v.added_at'])
    .where('v.location_id', '=', locationId)
    .orderBy('v.added_at')
    .orderBy('c.full_name')
    .execute()
  return rows.map((r) => ({ customerId: r.customer_id, fullName: r.full_name, addedAt: r.added_at }))
}

export async function addVipClient(
  tx: Tx,
  input: { locationId: string; customerId: string; addedBy?: string | null; audit?: audit.AuditContext },
): Promise<{ customer: CustomerRecord; added: boolean }> {
  const customer = await requireCustomer(tx, input.customerId)
  if (customer.deletedAt || customer.mergedInto)
    throw new AppError('VALIDATION_FAILED', {
      detail: 'That customer is no longer active.',
      errors: [{ path: 'customerId', message: 'That customer is no longer active.' }],
    })
  const inserted = await tx
    .insertInto('vip_clients')
    .values({ location_id: input.locationId, customer_id: customer.id, added_by: input.addedBy ?? null })
    .onConflict((oc) => oc.columns(['location_id', 'customer_id']).doNothing())
    .returning('customer_id')
    .executeTakeFirst()
  if (inserted)
    await recordChange(tx, {
      locationId: input.locationId,
      action: 'settings.vip.client.add',
      entityType: 'vip_client',
      entityId: customer.id,
      after: { fullName: customer.fullName },
      section: 'vip',
      audit: input.audit,
    })
  return { customer, added: inserted !== undefined }
}

export async function removeVipClient(
  tx: Tx,
  input: { locationId: string; customerId: string; audit?: audit.AuditContext },
): Promise<boolean> {
  const row = isUuid(input.customerId)
    ? await tx
        .deleteFrom('vip_clients')
        .where('location_id', '=', input.locationId)
        .where('customer_id', '=', input.customerId)
        .returning('customer_id')
        .executeTakeFirst()
    : undefined
  if (row)
    await recordChange(tx, {
      locationId: input.locationId,
      action: 'settings.vip.client.remove',
      entityType: 'vip_client',
      entityId: input.customerId,
      section: 'vip',
      audit: input.audit,
    })
  return row !== undefined
}

export interface VipCandidate {
  customerId: string
  fullName: string
  /** Last four digits only, enough to tell two people with one name apart. */
  phoneHint: string | null
  vehicles: string[]
  alreadyVip: boolean
}

export type AddVipByNameResult =
  | { status: 'added'; customer: CustomerRecord; toast: string }
  | { status: 'already_vip'; customer: CustomerRecord }
  | { status: 'candidates'; candidates: VipCandidate[] }
  | { status: 'not_found' }

const vehicleLabel = (v: VehicleRecord): string => [v.year, v.make, v.model].filter(Boolean).join(' ')

/**
 * The design's "Client name" box. A name that matches exactly one customer (case-insensitive) is added; several exact
 * matches, or only partial matches, return candidates for the caller to pick by id; no match returns not_found. A typed
 * name is never silently attached to a guessed person.
 */
export async function addVipByName(
  tx: Tx,
  input: { locationId: string; name: string; addedBy?: string | null; audit?: audit.AuditContext },
): Promise<AddVipByNameResult> {
  const name = input.name.trim()
  if (name === '')
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Enter a client name.',
      errors: [{ path: 'name', message: 'Enter a client name.' }],
    })
  const { exact, partial } = await findCustomersByName(tx, name)
  if (exact.length === 1) {
    const c = exact[0]!
    const r = await addVipClient(tx, {
      locationId: input.locationId,
      customerId: c.id,
      addedBy: input.addedBy,
      audit: input.audit,
    })
    return r.added
      ? { status: 'added', customer: r.customer, toast: `${r.customer.fullName} is now VIP` }
      : { status: 'already_vip', customer: r.customer }
  }
  const matches = exact.length > 1 ? exact : partial
  if (matches.length === 0) return { status: 'not_found' }
  const vips = new Set(
    (
      await tx
        .selectFrom('vip_clients')
        .select('customer_id')
        .where('location_id', '=', input.locationId)
        .where(
          'customer_id',
          'in',
          matches.map((m) => m.id),
        )
        .execute()
    ).map((r) => r.customer_id),
  )
  const candidates: VipCandidate[] = []
  for (const m of matches) {
    candidates.push({
      customerId: m.id,
      fullName: m.fullName,
      phoneHint: m.phoneE164 ? maskPhone(m.phoneE164) : null,
      vehicles: (await listVehicles(tx, m.id)).map(vehicleLabel).filter(Boolean),
      alreadyVip: vips.has(m.id),
    })
  }
  return { status: 'candidates', candidates }
}

export async function countVipClients(db: Executor, locationId: string): Promise<number> {
  const r = await db
    .selectFrom('vip_clients')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('location_id', '=', locationId)
    .executeTakeFirstOrThrow()
  return r.n
}
