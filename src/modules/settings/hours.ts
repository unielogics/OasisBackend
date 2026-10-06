// Working hours and booking rules. Both live behind one version (booking_rules.version): the Working hours screen
// saves them together, but either part may be sent alone (rules save immediately, B22).
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import * as audit from '../../platform/audit.js'
import { fmtT } from '../../platform/time.js'
import './schema.js'
import { DEFAULT_HOURS, ensureDomainDefaults } from './defaults.js'
import { recordChange } from './changes.js'
import { DAY_NAMES } from './labels.js'

export interface HoursDay {
  /** 0 = Sunday. */
  weekday: number
  isOpen: boolean
  openMin: number
  closeMin: number
}

export const SLOT_MINUTES = [15, 30, 60] as const
export const BUFFER_MINUTES = [0, 10, 15, 20] as const
export const CUTOFF_MINUTES = [30, 60, 90] as const

export interface BookingRules {
  slotMinutes: number
  bufferMinutes: number
  cutoffMinutes: number
  onlineLeadMinutes: number
  allowOverrun: boolean
  autoPlanBay: boolean
}

export const DEFAULT_RULES: BookingRules = {
  slotMinutes: 30,
  bufferMinutes: 10,
  cutoffMinutes: 60,
  onlineLeadMinutes: 30,
  allowOverrun: true,
  autoPlanBay: true,
}

export const HOURS_MIN = 300
export const HOURS_MAX = 1410
export const HOURS_STEP = 30

export interface HoursAndRules {
  days: HoursDay[]
  rules: BookingRules
  /** Shared optimistic-concurrency token; 0 when nothing has been stored yet. */
  version: number
  /** Minutes open per week (open days only). */
  weekMinutes: number
}

export interface ValidationIssue {
  path: string
  message: string
}

export const openMinutes = (d: Pick<HoursDay, 'isOpen' | 'openMin' | 'closeMin'>): number =>
  d.isOpen ? Math.max(0, d.closeMin - d.openMin) : 0

export const weekMinutes = (days: readonly HoursDay[]): number => days.reduce((n, d) => n + openMinutes(d), 0)

/** Pure validation of a full week: seven days, closing after opening, 5:00 AM to 11:30 PM, 30-minute grid. */
export function validateHours(days: readonly HoursDay[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const seen = new Set<number>()
  days.forEach((d, i) => {
    const name = DAY_NAMES[d.weekday]
    if (!Number.isInteger(d.weekday) || d.weekday < 0 || d.weekday > 6 || name === undefined) {
      issues.push({ path: `days.${i}.weekday`, message: 'Weekday must be 0 (Sunday) to 6 (Saturday).' })
      return
    }
    if (seen.has(d.weekday)) issues.push({ path: `days.${i}.weekday`, message: `${name} appears twice.` })
    seen.add(d.weekday)
    const path = `days.${i}`
    if (!Number.isInteger(d.openMin) || !Number.isInteger(d.closeMin)) {
      issues.push({ path, message: `${name}: times must be whole minutes.` })
      return
    }
    if (d.openMin % HOURS_STEP !== 0 || d.closeMin % HOURS_STEP !== 0)
      issues.push({ path, message: `${name}: use 30-minute steps.` })
    if (d.openMin < HOURS_MIN || d.closeMin > HOURS_MAX)
      issues.push({
        path,
        message: `${name}: hours must be between ${fmtT(HOURS_MIN)} and ${fmtT(HOURS_MAX)}.`,
      })
    if (d.openMin >= d.closeMin)
      issues.push({ path, message: `${name}: closing time must be after opening time.` })
  })
  if (seen.size !== 7 || days.length !== 7)
    issues.push({ path: 'days', message: 'Send all seven days, Sunday to Saturday.' })
  return issues
}

const inSet = (set: readonly number[], v: unknown): boolean => typeof v === 'number' && set.includes(v)

export function validateRules(rules: Partial<BookingRules>): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (rules.slotMinutes !== undefined && !inSet(SLOT_MINUTES, rules.slotMinutes))
    issues.push({ path: 'rules.slotMinutes', message: 'Slot length must be 15, 30 or 60 minutes.' })
  if (rules.bufferMinutes !== undefined && !inSet(BUFFER_MINUTES, rules.bufferMinutes))
    issues.push({ path: 'rules.bufferMinutes', message: 'Buffer must be 0, 10, 15 or 20 minutes.' })
  if (rules.cutoffMinutes !== undefined && !inSet(CUTOFF_MINUTES, rules.cutoffMinutes))
    issues.push({
      path: 'rules.cutoffMinutes',
      message: 'Last booking before close must be 30, 60 or 90 minutes.',
    })
  if (
    rules.onlineLeadMinutes !== undefined &&
    (!Number.isInteger(rules.onlineLeadMinutes) ||
      rules.onlineLeadMinutes < 0 ||
      rules.onlineLeadMinutes > 240)
  )
    issues.push({ path: 'rules.onlineLeadMinutes', message: 'Online lead time must be 0 to 240 minutes.' })
  return issues
}

export function throwIfInvalid(issues: ValidationIssue[]): void {
  if (issues.length > 0)
    throw new AppError('VALIDATION_FAILED', { detail: issues[0]!.message, errors: issues })
}

export async function getHours(db: Executor, locationId: string): Promise<HoursDay[]> {
  const rows = await db
    .selectFrom('business_hours')
    .select(['weekday', 'is_open', 'open_min', 'close_min'])
    .where('location_id', '=', locationId)
    .orderBy('weekday')
    .execute()
  const byDay = new Map(rows.map((r) => [r.weekday, r]))
  return DEFAULT_HOURS.map((def) => {
    const r = byDay.get(def.weekday)
    return r
      ? { weekday: r.weekday, isOpen: r.is_open, openMin: r.open_min, closeMin: r.close_min }
      : { ...def }
  })
}

export async function getBookingRules(
  db: Executor,
  locationId: string,
): Promise<{ rules: BookingRules; version: number }> {
  const r = await db
    .selectFrom('booking_rules')
    .select([
      'slot_minutes',
      'buffer_minutes',
      'cutoff_minutes',
      'online_lead_minutes',
      'allow_overrun',
      'auto_plan_bay',
      'version',
    ])
    .where('location_id', '=', locationId)
    .executeTakeFirst()
  if (!r) return { rules: { ...DEFAULT_RULES }, version: 0 }
  return {
    rules: {
      slotMinutes: r.slot_minutes,
      bufferMinutes: r.buffer_minutes,
      cutoffMinutes: r.cutoff_minutes,
      onlineLeadMinutes: r.online_lead_minutes,
      allowOverrun: r.allow_overrun,
      autoPlanBay: r.auto_plan_bay,
    },
    version: r.version,
  }
}

export async function getHoursAndRules(db: Executor, locationId: string): Promise<HoursAndRules> {
  const [days, { rules, version }] = await Promise.all([
    getHours(db, locationId),
    getBookingRules(db, locationId),
  ])
  return { days, rules, version, weekMinutes: weekMinutes(days) }
}

export interface EmployeeScheduleConflict {
  employeeId: string
  employeeName: string
  weekday: number
  message: string
}

export interface AppointmentOutsideHours {
  appointmentId: string
  startsAt: Date
  weekday: number
  /** Minutes from local midnight. */
  startMin: number
}

export interface HoursWarnings {
  employeeScheduleConflicts: EmployeeScheduleConflict[]
  appointmentsOutsideHours: AppointmentOutsideHours[]
}

/** The people tables arrive in another branch: the employees vertical plugs its schedule check in here. */
export interface HoursWarningHooks {
  employeeScheduleConflicts?(
    tx: Tx,
    ctx: { locationId: string; days: HoursDay[] },
  ): Promise<EmployeeScheduleConflict[]>
}

/**
 * Upcoming booked, confirmed or arrived appointments whose start falls on a day that is now closed or outside the open
 * window (open <= start < close, in the business time zone). Reported, never moved.
 */
export async function appointmentsOutsideHours(
  db: Executor,
  o: { locationId: string; days: readonly HoursDay[]; now: Date; tz: string; limit?: number },
): Promise<AppointmentOutsideHours[]> {
  const values = sql.join(
    o.days.map((d) => sql`(${d.weekday}::int, ${d.isOpen}::boolean, ${d.openMin}::int, ${d.closeMin}::int)`),
  )
  const r = await sql<{ id: string; scheduled_start: Date; weekday: number; start_min: number }>`
    select a.id, a.scheduled_start, h.weekday, l.start_min
    from appointments a
    cross join lateral (
      select extract(dow from a.scheduled_start at time zone ${o.tz})::int as dow,
             (extract(hour from a.scheduled_start at time zone ${o.tz}) * 60
              + extract(minute from a.scheduled_start at time zone ${o.tz}))::int as start_min
    ) l
    join (values ${values}) as h(weekday, is_open, open_min, close_min) on h.weekday = l.dow
    where a.location_id = ${o.locationId}
      and a.scheduled_start >= ${o.now}
      and a.status in ('booked', 'confirmed', 'arrived')
      and (not h.is_open or l.start_min < h.open_min or l.start_min >= h.close_min)
    order by a.scheduled_start, a.id
    limit ${o.limit ?? 200}`.execute(db)
  return r.rows.map((x) => ({
    appointmentId: x.id,
    startsAt: x.scheduled_start,
    weekday: x.weekday,
    startMin: x.start_min,
  }))
}

export interface SaveHoursInput {
  locationId: string
  days?: readonly HoursDay[]
  rules?: Partial<BookingRules>
  /** The version the editor last saw (0 = never stored). Omit to overwrite. */
  expectedVersion?: number
  updatedBy?: string | null
  now: Date
  tz: string
  audit?: audit.AuditContext
  hooks?: HoursWarningHooks
}

export interface SaveHoursResult extends HoursAndRules {
  changed: boolean
  warnings: HoursWarnings
}

const sameDays = (a: readonly HoursDay[], b: readonly HoursDay[]): boolean =>
  a.length === b.length &&
  a.every((d, i) => {
    const o = b[i]!
    return (
      d.weekday === o.weekday && d.isOpen === o.isOpen && d.openMin === o.openMin && d.closeMin === o.closeMin
    )
  })

/**
 * Validates, then writes hours and rules in one transaction under a row lock with one version bump, and returns the
 * warnings (employee schedules that no longer fit, upcoming appointments outside the new hours).
 */
export async function saveHoursAndRules(tx: Tx, input: SaveHoursInput): Promise<SaveHoursResult> {
  const sorted = input.days ? [...input.days].sort((a, b) => a.weekday - b.weekday) : undefined
  const issues = [
    ...(sorted ? validateHours(sorted) : []),
    ...(input.rules ? validateRules(input.rules) : []),
  ]
  throwIfInvalid(issues)

  await ensureDomainDefaults(tx, input.locationId)
  const locked = await tx
    .selectFrom('booking_rules')
    .select('version')
    .where('location_id', '=', input.locationId)
    .forUpdate()
    .executeTakeFirstOrThrow()
  if (input.expectedVersion !== undefined && input.expectedVersion !== locked.version)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: locked.version } })

  const before = await getHoursAndRules(tx, input.locationId)
  const nextDays = sorted ?? before.days
  const nextRules: BookingRules = { ...before.rules, ...(input.rules ?? {}) }
  const rulesChanged = (Object.keys(nextRules) as (keyof BookingRules)[]).some(
    (k) => nextRules[k] !== before.rules[k],
  )
  const daysChanged = !sameDays(nextDays, before.days)
  const warnings = await collectWarnings(tx, input, nextDays)

  if (!rulesChanged && !daysChanged) return { ...before, changed: false, warnings }

  if (daysChanged) {
    await tx
      .insertInto('business_hours')
      .values(
        nextDays.map((d) => ({
          location_id: input.locationId,
          weekday: d.weekday,
          is_open: d.isOpen,
          open_min: d.openMin,
          close_min: d.closeMin,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['location_id', 'weekday']).doUpdateSet((eb) => ({
          is_open: eb.ref('excluded.is_open'),
          open_min: eb.ref('excluded.open_min'),
          close_min: eb.ref('excluded.close_min'),
        })),
      )
      .execute()
  }
  const updated = await tx
    .updateTable('booking_rules')
    .set((eb) => ({
      slot_minutes: nextRules.slotMinutes,
      buffer_minutes: nextRules.bufferMinutes,
      cutoff_minutes: nextRules.cutoffMinutes,
      online_lead_minutes: nextRules.onlineLeadMinutes,
      allow_overrun: nextRules.allowOverrun,
      auto_plan_bay: nextRules.autoPlanBay,
      version: eb('version', '+', 1),
      updated_by: input.updatedBy ?? null,
      updated_at: eb.fn('app_now', []),
    }))
    .where('location_id', '=', input.locationId)
    .returning('version')
    .executeTakeFirstOrThrow()
  const after: HoursAndRules = {
    days: nextDays,
    rules: nextRules,
    version: updated.version,
    weekMinutes: weekMinutes(nextDays),
  }
  await recordChange(tx, {
    locationId: input.locationId,
    action: 'settings.hours.update',
    entityType: 'business_hours',
    entityId: 'hours',
    before: { days: before.days, rules: before.rules },
    after: { days: after.days, rules: after.rules },
    section: 'hours',
    version: updated.version,
    audit: input.audit,
  })
  return { ...after, changed: true, warnings }
}

async function collectWarnings(
  tx: Tx,
  input: SaveHoursInput,
  days: readonly HoursDay[],
): Promise<HoursWarnings> {
  const [employeeScheduleConflicts, outside] = await Promise.all([
    input.hooks?.employeeScheduleConflicts?.(tx, { locationId: input.locationId, days: [...days] }) ?? [],
    appointmentsOutsideHours(tx, { locationId: input.locationId, days, now: input.now, tz: input.tz }),
  ])
  return { employeeScheduleConflicts, appointmentsOutsideHours: outside }
}
