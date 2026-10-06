// Working hours, booking rules and the federal-holiday toggle.
import type { Executor } from '../../../platform/db.js'
import { access } from '../../../http/access.js'
import { z } from '../../../http/zod.js'
import { AppError } from '../../../platform/errors.js'
import { getSetting, updateSetting } from '../../../platform/settings.js'
import { fmtT, toBizDate, tryParseT } from '../../../platform/time.js'
import { generateFederalHolidays } from '../federal-holidays.js'
import {
  getHoursAndRules,
  saveHoursAndRules,
  openMinutes,
  type AppointmentOutsideHours,
  type BookingRules,
  type EmployeeScheduleConflict,
  type HoursAndRules,
  type HoursDay,
  type HoursWarnings,
} from '../hours.js'
import { DAY_NAMES, hoursLabel } from '../labels.js'
import {
  businessTzOf,
  etag,
  expectedVersion,
  inTx,
  requestContext,
  requiredVersion,
  storedUserId,
  type SettingsRuntime,
} from './runtime.js'

const Time = z.string().max(12)

export const HoursDayView = z.object({
  weekday: z.number().int().min(0).max(6),
  day: z.string(),
  open: z.boolean(),
  from: z.string(),
  to: z.string(),
  fromMin: z.number().int(),
  toMin: z.number().int(),
  len: z.string().describe('"10 hrs"; 0 hrs on a closed day'),
  lenMinutes: z.number().int(),
})

export const RulesView = z.object({
  slot: z.number().int(),
  buffer: z.number().int(),
  cutoff: z.number().int(),
  onlineLeadMinutes: z.number().int(),
  allowOverrun: z.boolean(),
  autoPlanBay: z.boolean(),
})

export const HoursView = z.object({
  days: z.array(HoursDayView),
  rules: RulesView,
  weekHours: z.string().describe('"65 hrs", open hours per week'),
  weekMinutes: z.number().int(),
  federalAuto: z.boolean(),
  version: z.number().int(),
})

const ConflictView = z.object({
  employeeId: z.string(),
  employeeName: z.string(),
  weekday: z.number().int(),
  day: z.string(),
  message: z.string(),
})
const OutsideView = z.object({
  appointmentId: z.string(),
  startsAt: z.string(),
  date: z.string(),
  time: z.string(),
  weekday: z.number().int(),
  startMin: z.number().int(),
})
export const WarningsView = z.object({
  employeeScheduleConflicts: z.array(ConflictView),
  appointmentsOutsideHours: z.array(OutsideView),
})

export const dayView = (d: HoursDay) => ({
  weekday: d.weekday,
  day: DAY_NAMES[d.weekday]!,
  open: d.isOpen,
  from: fmtT(d.openMin),
  to: fmtT(d.closeMin),
  fromMin: d.openMin,
  toMin: d.closeMin,
  len: hoursLabel(openMinutes(d)),
  lenMinutes: openMinutes(d),
})

export const rulesView = (r: BookingRules): z.infer<typeof RulesView> => ({
  slot: r.slotMinutes,
  buffer: r.bufferMinutes,
  cutoff: r.cutoffMinutes,
  onlineLeadMinutes: r.onlineLeadMinutes,
  allowOverrun: r.allowOverrun,
  autoPlanBay: r.autoPlanBay,
})

export async function loadHoursView(db: Executor, locationId: string): Promise<z.infer<typeof HoursView>> {
  const [h, auto] = await Promise.all([
    getHoursAndRules(db, locationId),
    getSetting(db, locationId, 'federal_holidays.auto'),
  ])
  return hoursView(h, auto.value)
}

export const hoursView = (h: HoursAndRules, federalAuto: boolean): z.infer<typeof HoursView> => ({
  days: h.days.map(dayView),
  rules: rulesView(h.rules),
  weekHours: hoursLabel(h.weekMinutes),
  weekMinutes: h.weekMinutes,
  federalAuto,
  version: h.version,
})

function warningsView(w: HoursWarnings, tz: string): z.infer<typeof WarningsView> {
  const conflict = (c: EmployeeScheduleConflict) => ({
    employeeId: c.employeeId,
    employeeName: c.employeeName,
    weekday: c.weekday,
    day: DAY_NAMES[c.weekday]!,
    message: c.message,
  })
  const outside = (a: AppointmentOutsideHours) => ({
    appointmentId: a.appointmentId,
    startsAt: a.startsAt.toISOString(),
    date: toBizDate(a.startsAt, tz),
    time: fmtT(a.startMin),
    weekday: a.weekday,
    startMin: a.startMin,
  })
  return {
    employeeScheduleConflicts: w.employeeScheduleConflicts.map(conflict),
    appointmentsOutsideHours: w.appointmentsOutsideHours.map(outside),
  }
}

const DayIn = z
  .object({
    weekday: z.number().int().min(0).max(6),
    open: z.boolean(),
    from: Time.optional(),
    to: Time.optional(),
    fromMin: z.number().int().optional(),
    toMin: z.number().int().optional(),
    // read-only fields of GET /settings/hours, accepted so a loaded day can be sent back as it is
    day: z.string().optional(),
    len: z.string().optional(),
    lenMinutes: z.number().int().optional(),
  })
  .strict()

const RulesIn = z
  .object({
    slot: z.number().int().optional(),
    buffer: z.number().int().optional(),
    cutoff: z.number().int().optional(),
    onlineLeadMinutes: z.number().int().optional(),
    allowOverrun: z.boolean().optional(),
    autoPlanBay: z.boolean().optional(),
  })
  .strict()

function rulesPatch(r: z.infer<typeof RulesIn>): Partial<BookingRules> {
  const out: Partial<BookingRules> = {}
  if (r.slot !== undefined) out.slotMinutes = r.slot
  if (r.buffer !== undefined) out.bufferMinutes = r.buffer
  if (r.cutoff !== undefined) out.cutoffMinutes = r.cutoff
  if (r.onlineLeadMinutes !== undefined) out.onlineLeadMinutes = r.onlineLeadMinutes
  if (r.allowOverrun !== undefined) out.allowOverrun = r.allowOverrun
  if (r.autoPlanBay !== undefined) out.autoPlanBay = r.autoPlanBay
  return out
}

function parseTime(label: string, path: string, text: string): number {
  const m = tryParseT(text)
  if (m === null)
    throw new AppError('VALIDATION_FAILED', {
      detail: `${label}: use a time like 8:00 AM.`,
      errors: [{ path, message: `${label}: use a time like 8:00 AM.` }],
    })
  return m
}

/**
 * Accepts "8:00 AM" strings or minutes; a closed day without times keeps the stored ones. A day that carries both forms
 * (a loaded day sent back after editing only one of them) must agree, otherwise one edit would be silently dropped.
 */
function mergeDays(current: readonly HoursDay[], input: z.infer<typeof DayIn>[]): HoursDay[] {
  const pick = (
    name: string,
    i: number,
    key: 'from' | 'to',
    text: string | undefined,
    min: number | undefined,
  ) => {
    const parsed = text !== undefined ? parseTime(name, `days.${i}.${key}`, text) : undefined
    if (parsed !== undefined && min !== undefined && parsed !== min) {
      const message = `${name}: ${key} and ${key}Min disagree. Send only one of them.`
      throw new AppError('VALIDATION_FAILED', {
        detail: message,
        errors: [{ path: `days.${i}.${key}`, message }],
      })
    }
    return min ?? parsed
  }
  return input.map((d, i) => {
    const cur = current.find((c) => c.weekday === d.weekday)
    const name = DAY_NAMES[d.weekday]!
    return {
      weekday: d.weekday,
      isOpen: d.open,
      openMin: pick(name, i, 'from', d.from, d.fromMin) ?? cur?.openMin ?? 480,
      closeMin: pick(name, i, 'to', d.to, d.toMin) ?? cur?.closeMin ?? 1080,
    }
  })
}

export function registerHoursRoutes(rt: SettingsRuntime): void {
  const { app } = rt

  app.get(
    '/settings/hours',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['settings'],
        operationId: 'getSettingsHours',
        summary: 'Weekly hours, booking rules, week total and the federal-holiday toggle (ETag = version)',
        response: { 200: HoursView },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const v = await loadHoursView(app.db, c.locationId)
      etag(reply, v.version)
      return v
    },
  )

  app.put(
    '/settings/hours',
    {
      config: { access: access.perm('set.hours') },
      schema: {
        tags: ['settings'],
        operationId: 'putSettingsHours',
        summary: 'Save the weekly hours (the dirty-tracked save of the Working hours screen)',
        description:
          'Send all seven days; times as "8:00 AM" (`from`/`to`) or minutes (`fromMin`/`toMin`). `version` (or If-Match) is required and must match: 412 VERSION_CONFLICT otherwise. ' +
          '`rules` may ride along but the design saves booking rules immediately through PUT /settings/rules. ' +
          'Employee schedules and appointments that no longer fit are returned as warnings and never moved. Publishes `settings.changed {section: "hours"}`.',
        body: z
          .object({
            days: z.array(DayIn).max(7),
            rules: RulesIn.optional(),
            version: z.number().int().min(0).optional(),
            // read-only fields of GET /settings/hours
            weekHours: z.string().optional(),
            weekMinutes: z.number().int().optional(),
            federalAuto: z.boolean().optional(),
          })
          .strict(),
        response: {
          200: HoursView.extend({ changed: z.boolean(), warnings: WarningsView }),
        },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const version = requiredVersion(req, req.body.version)
      const tz = await businessTzOf(app.db, c.locationId, app.env.BUSINESS_TZ)
      const out = await inTx(app.db, async (tx) => {
        const current = await getHoursAndRules(tx, c.locationId)
        const r = await saveHoursAndRules(tx, {
          locationId: c.locationId,
          days: mergeDays(current.days, req.body.days),
          rules: req.body.rules ? rulesPatch(req.body.rules) : undefined,
          expectedVersion: version,
          updatedBy: await storedUserId(tx, c.userId),
          now: app.clock.now(),
          tz,
          audit: c.audit,
          hooks: rt.ports().hoursHooks,
        })
        const auto = await getSetting(tx, c.locationId, 'federal_holidays.auto')
        return { ...hoursView(r, auto.value), changed: r.changed, warnings: warningsView(r.warnings, tz) }
      })
      etag(reply, out.version)
      return out
    },
  )

  app.get(
    '/settings/rules',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: ['settings'],
        operationId: 'getSettingsRules',
        summary: 'Booking rules (slot length, buffer, last booking cutoff) and the federal-holiday toggle',
        response: {
          200: z.object({ rules: RulesView, federalAuto: z.boolean(), version: z.number().int() }),
        },
      },
    },
    async (req, reply) => {
      const v = await loadHoursView(app.db, requestContext(req).locationId)
      etag(reply, v.version)
      return { rules: v.rules, federalAuto: v.federalAuto, version: v.version }
    },
  )

  app.put(
    '/settings/rules',
    {
      config: { access: access.perm('set.hours') },
      schema: {
        tags: ['settings'],
        operationId: 'putSettingsRules',
        summary: 'Save booking rules immediately (not part of the dirty-tracked hours save)',
        description:
          'Partial update; each chip click in the design saves right away. `version` (or If-Match) is optional and enforced when sent. ' +
          'Rules share the hours version token, so the response carries the new version for the next hours save. Publishes `settings.changed {section: "hours"}`.',
        body: RulesIn.extend({ version: z.number().int().min(0).optional() }).strict(),
        response: {
          200: z.object({ rules: RulesView, version: z.number().int(), changed: z.boolean() }),
        },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const { version: bodyVersion, ...rules } = req.body
      const tz = await businessTzOf(app.db, c.locationId, app.env.BUSINESS_TZ)
      const r = await inTx(app.db, async (tx) =>
        saveHoursAndRules(tx, {
          locationId: c.locationId,
          rules: rulesPatch(rules),
          expectedVersion: expectedVersion(req, bodyVersion),
          updatedBy: await storedUserId(tx, c.userId),
          now: app.clock.now(),
          tz,
          audit: c.audit,
          hooks: { employeeScheduleConflicts: async () => [] },
        }),
      )
      etag(reply, r.version)
      return { rules: rulesView(r.rules), version: r.version, changed: r.changed }
    },
  )

  app.put(
    '/settings/auto-federal-holidays',
    {
      config: { access: access.perm('set.hours') },
      schema: {
        tags: ['settings'],
        operationId: 'putAutoFederalHolidays',
        summary: 'Turn "Auto-add US federal holidays" on or off; turning it on generates this year and next',
        description:
          'Generated closures are closed days with notify off, skip past dates and any holiday that already has a closure (by date or name) or was generated and removed before. Idempotent. Publishes `settings.changed {section: "federal_holidays"}` and `{section: "closures"}`.',
        body: z.object({ enabled: z.boolean(), version: z.number().int().min(0).optional() }).strict(),
        response: {
          200: z.object({
            enabled: z.boolean(),
            created: z.array(
              z.object({ year: z.number().int(), key: z.string(), date: z.string(), closureId: z.string() }),
            ),
            version: z.number().int(),
          }),
        },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const tz = await businessTzOf(app.db, c.locationId, app.env.BUSINESS_TZ)
      const newId = app.newId
      return inTx(app.db, async (tx) => {
        const rec = await updateSetting(tx, {
          locationId: c.locationId,
          key: 'federal_holidays.auto',
          value: req.body.enabled,
          expectedVersion: expectedVersion(req, req.body.version),
          updatedBy: await storedUserId(tx, c.userId),
          audit: c.audit,
        })
        let created: { year: number; key: string; date: string; closureId: string }[] = []
        if (req.body.enabled) {
          const today = toBizDate(app.clock.now(), tz)
          const year = Number(today.slice(0, 4))
          const r = await generateFederalHolidays(tx, {
            locationId: c.locationId,
            years: [year, year + 1],
            today,
            tz,
            newId,
            ignoreToggle: true,
            audit: c.audit,
          })
          created = r.created
        }
        return { enabled: rec.value, created, version: rec.version }
      })
    },
  )
}
