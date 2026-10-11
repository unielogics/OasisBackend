// The Reminders section of Settings (ADR 0160, plan I): appointment reminders (offsets, the "Reply C" confirmation request, the
// per-category preparation line, the review request), the status texts as the car moves, and the one automatic lead follow-up.
// Every value is an ordinary registry setting (platform/settings.ts); this section reads and writes them together under one
// version token: the sum of the section's setting versions, which every write to any of them raises. A save names the version
// it was edited from (412 VERSION_CONFLICT otherwise), takes a per-location advisory lock so two saves never both pass the check,
// and writes only the keys whose value changed (each audited and published as settings.changed by updateSetting).
import { sql } from 'kysely'
import { prepareSmsBody } from '../../../integrations/sms/gsm.js'
import type { AuditContext } from '../../../platform/audit.js'
import type { Executor, Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { getSetting, parseSetting, updateSetting, type SettingKey, type SettingValue } from '../../../platform/settings.js'

/** The section's fields and the setting each one is stored in. */
export const REMINDER_FIELDS = {
  reminders: {
    offsetsMin: 'reminders.offsets_min',
    confirmRequest: 'reminders.confirm_request',
    categoryPrep: 'reminders.category_prep',
    reviewRequest: 'reviews.enabled',
  },
  statusTexts: {
    checkedIn: 'status_texts.checked_in',
    checkedInDelayMin: 'status_texts.checked_in_delay_min',
    runningLate: 'status_texts.running_late',
    lateGraceMin: 'status_texts.late_grace_min',
    lateMax: 'status_texts.late_max',
    ready: 'status_texts.ready',
    pickedUp: 'status_texts.picked_up',
    bookAgainLink: 'status_texts.book_again_link',
  },
  leads: {
    followUpEnabled: 'leads.follow_up_enabled',
    followUpDelayMin: 'leads.follow_up_delay_min',
    businessHoursOnly: 'leads.business_hours_only',
    withinHours: 'leads.within_hours',
  },
} as const satisfies Record<string, Record<string, SettingKey>>

export type ReminderGroup = keyof typeof REMINDER_FIELDS

export interface ReminderValues {
  reminders: {
    offsetsMin: number[]
    confirmRequest: boolean
    categoryPrep: Record<string, string>
    reviewRequest: boolean
  }
  statusTexts: {
    checkedIn: boolean
    checkedInDelayMin: number
    runningLate: boolean
    lateGraceMin: number
    lateMax: number
    ready: boolean
    pickedUp: boolean
    bookAgainLink: boolean
  }
  leads: {
    followUpEnabled: boolean
    followUpDelayMin: number
    businessHoursOnly: boolean
    withinHours: number
  }
}
export type ReminderPatch = { [G in ReminderGroup]?: Partial<ReminderValues[G]> }

export const REMINDER_KEYS: SettingKey[] = Object.values(REMINDER_FIELDS).flatMap((g) => Object.values(g))

export interface ReminderCategory {
  key: string
  label: string
  colour: string
  active: boolean
}

export interface ReminderSettings {
  values: ReminderValues
  categories: ReminderCategory[]
  quietHours: SettingValue<'sms.quiet_hours'>
  /** Sum of the section's setting versions (0 when none was ever stored). */
  version: number
}

export async function loadCategories(db: Executor, locationId: string): Promise<ReminderCategory[]> {
  const rows = await db
    .selectFrom('catalog_categories')
    .select(['key', 'label', 'colour', 'active'])
    .where('location_id', '=', locationId)
    .orderBy('sort')
    .orderBy('key')
    .execute()
  return rows
}

export async function loadReminderSettings(db: Executor, locationId: string): Promise<ReminderSettings> {
  const values = {} as Record<string, Record<string, unknown>>
  let version = 0
  for (const [group, fields] of Object.entries(REMINDER_FIELDS)) {
    values[group] = {}
    for (const [field, key] of Object.entries(fields)) {
      const rec = await getSetting(db, locationId, key)
      values[group]![field] = rec.value
      version += rec.version
    }
  }
  return {
    values: values as unknown as ReminderValues,
    categories: await loadCategories(db, locationId),
    quietHours: (await getSetting(db, locationId, 'sms.quiet_hours')).value,
    version,
  }
}

interface Issue {
  path: string
  message: string
}

/**
 * Merges a patch over the stored values and validates the result: each value by its registry schema, then the section's own
 * rules (offsets distinct, kept longest first; preparation lines only for categories that exist, in plain SMS characters; an
 * empty line removes it). Throws VALIDATION_FAILED with every problem; returns the merged values.
 */
export function mergeReminderValues(
  current: ReminderValues,
  patch: ReminderPatch,
  categories: readonly ReminderCategory[],
): ReminderValues {
  const issues: Issue[] = []
  const next = structuredClone(current) as unknown as Record<string, Record<string, unknown>>
  for (const [group, fields] of Object.entries(REMINDER_FIELDS) as [ReminderGroup, Record<string, SettingKey>][]) {
    const p = (patch[group] ?? {}) as Record<string, unknown>
    for (const [field, value] of Object.entries(p)) {
      if (value === undefined) continue
      const key = fields[field]
      if (!key) {
        issues.push({ path: `${group}.${field}`, message: 'Unknown field' })
        continue
      }
      let v = value
      if (key === 'reminders.category_prep' && v && typeof v === 'object') {
        // an emptied line removes the category's preparation text
        v = Object.fromEntries(
          Object.entries(v as Record<string, unknown>).filter(([, t]) => !(typeof t === 'string' && t.trim() === '')),
        )
      }
      try {
        next[group]![field] = parseSetting(key, v)
      } catch (e) {
        if (!(e instanceof AppError)) throw e
        const errs = (e.errors ?? []) as Issue[]
        for (const x of errs.length ? errs : [{ path: 'value', message: e.detail }])
          issues.push({ path: `${group}.${field}${x.path.replace(/^value/, '')}`, message: x.message })
      }
    }
  }
  const out = next as unknown as ReminderValues
  const offsets = out.reminders.offsetsMin
  if (new Set(offsets).size !== offsets.length)
    issues.push({ path: 'reminders.offsetsMin', message: 'Each reminder time can be listed once.' })
  out.reminders.offsetsMin = [...offsets].sort((a, b) => b - a)
  const known = new Set(categories.map((c) => c.key))
  for (const [cat, text] of Object.entries(out.reminders.categoryPrep)) {
    if (!known.has(cat)) issues.push({ path: `reminders.categoryPrep.${cat}`, message: `There is no category "${cat}".` })
    else if (prepareSmsBody(text).encoding !== 'GSM-7')
      issues.push({
        path: `reminders.categoryPrep.${cat}`,
        message: 'Use plain text characters: this one would make every reminder cost double.',
      })
  }
  if (issues.length) throw new AppError('VALIDATION_FAILED', { detail: issues[0]!.message, errors: issues })
  return out
}

export interface SaveReminderInput {
  locationId: string
  patch: ReminderPatch
  expectedVersion: number
  updatedBy: string | null
  audit: AuditContext
}

/** Saves the section: version check under the section lock, then one updateSetting per changed key. */
export async function saveReminderSettings(
  tx: Tx,
  input: SaveReminderInput,
): Promise<ReminderSettings & { changed: SettingKey[] }> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`settings.reminders:${input.locationId}`}, 0))`.execute(tx)
  const current = await loadReminderSettings(tx, input.locationId)
  if (current.version !== input.expectedVersion)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: current.version } })
  const merged = mergeReminderValues(current.values, input.patch, current.categories)
  const changed: SettingKey[] = []
  for (const [group, fields] of Object.entries(REMINDER_FIELDS) as [ReminderGroup, Record<string, SettingKey>][]) {
    for (const [field, key] of Object.entries(fields)) {
      const before = (current.values[group] as Record<string, unknown>)[field]
      const after = (merged[group] as Record<string, unknown>)[field]
      if (JSON.stringify(before) === JSON.stringify(after)) continue
      await updateSetting(tx, {
        locationId: input.locationId,
        key,
        value: after,
        updatedBy: input.updatedBy,
        audit: input.audit,
      })
      changed.push(key)
    }
  }
  const saved = changed.length ? await loadReminderSettings(tx, input.locationId) : current
  return { ...saved, changed }
}
