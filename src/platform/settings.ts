// Typed settings registry. Values live in settings(location_id, key) as jsonb; the registry is the single source of
// keys, validation and defaults. Writes are optimistic (version) and audited in the caller's transaction.
import { z } from 'zod/v4'
import type { Executor, Tx } from './db.js'
import { AppError } from './errors.js'
import * as audit from './audit.js'
import * as realtime from './realtime.js'
import type { JsonValue } from './schema.js'

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24 hour)')

export const settingDefs = {
  'tax.rate_bp': { schema: z.number().int().min(0).max(10_000), default: 700 },
  'tax.label': { schema: z.string().trim().min(1).max(40), default: 'Tax' },
  currency: { schema: z.enum(['USD']), default: 'USD' as const },
  'federal_holidays.auto': { schema: z.boolean(), default: true },
  'ops.late_grace_min': { schema: z.number().int().min(0).max(120), default: 10 },
  'ops.eta_visible_max_min': { schema: z.number().int().min(0).max(240), default: 30 },
  'memberships.auto_apply': { schema: z.boolean(), default: false },
  'approvals.allow_self': { schema: z.boolean(), default: false },
  'reminders.offsets_min': {
    schema: z.array(z.number().int().min(1).max(10_080)).max(5),
    default: [1440, 120],
  },
  'reviews.enabled': { schema: z.boolean(), default: false },
  'credit.default_expiry': { schema: z.enum(['none', '30d', '90d']), default: '90d' as const },
  'sms.quiet_hours': {
    schema: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }),
    default: { enabled: false, start: '21:00', end: '08:00' },
  },
} as const

export type SettingDefs = typeof settingDefs
export type SettingKey = keyof SettingDefs
export type SettingValue<K extends SettingKey> = z.infer<SettingDefs[K]['schema']>

export const settingKeys = Object.keys(settingDefs) as SettingKey[]
export const isSettingKey = (k: string): k is SettingKey => Object.hasOwn(settingDefs, k)

export function defaultSetting<K extends SettingKey>(key: K): SettingValue<K> {
  return structuredClone(settingDefs[key].default) as SettingValue<K>
}

export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  const r = settingDefs[key].schema.safeParse(value)
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', {
      detail: r.error.issues[0]?.message ?? 'Invalid value',
      errors: r.error.issues.map((i) => ({ path: ['value', ...i.path].join('.'), message: i.message })),
    })
  }
  return r.data as SettingValue<K>
}

export function requireSettingKey(key: string): SettingKey {
  if (!isSettingKey(key)) throw new AppError('NOT_FOUND', { detail: `Unknown setting "${key}"` })
  return key
}

export interface SettingRecord<K extends SettingKey = SettingKey> {
  key: K
  value: SettingValue<K>
  version: number
  updatedAt: Date | null
  updatedBy: string | null
}

export async function getSetting<K extends SettingKey>(
  db: Executor,
  locationId: string,
  key: K,
): Promise<SettingRecord<K>> {
  const row = await db
    .selectFrom('settings')
    .select(['value', 'version', 'updated_at', 'updated_by'])
    .where('location_id', '=', locationId)
    .where('key', '=', key)
    .executeTakeFirst()
  if (!row) return { key, value: defaultSetting(key), version: 0, updatedAt: null, updatedBy: null }
  return {
    key,
    value: parseSetting(key, row.value),
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

export async function listSettings(db: Executor, locationId: string): Promise<SettingRecord[]> {
  const rows = await db
    .selectFrom('settings')
    .select(['key', 'value', 'version', 'updated_at', 'updated_by'])
    .where('location_id', '=', locationId)
    .execute()
  const stored = new Map(rows.map((r) => [r.key, r]))
  return settingKeys.map((key) => {
    const r = stored.get(key)
    if (!r)
      return {
        key,
        value: defaultSetting(key),
        version: 0,
        updatedAt: null,
        updatedBy: null,
      } as SettingRecord
    return {
      key,
      value: parseSetting(key, r.value),
      version: r.version,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    } as SettingRecord
  })
}

/** Inserts any registry key that has no row yet (idempotent; never overwrites). */
export async function ensureSettingDefaults(db: Executor, locationId: string): Promise<void> {
  await db
    .insertInto('settings')
    .values(
      settingKeys.map((key) => ({
        location_id: locationId,
        key,
        value: JSON.stringify(settingDefs[key].default),
      })),
    )
    .onConflict((oc) => oc.columns(['location_id', 'key']).doNothing())
    .execute()
}

export interface SetSettingInput<K extends SettingKey> {
  locationId: string
  key: K
  value: unknown
  /** Optimistic concurrency: the version the editor last saw (0 = never stored). Omit to overwrite. */
  expectedVersion?: number
  updatedBy?: string | null
  audit?: audit.AuditContext
}

/** Validates, writes with a row lock and version check, audits and publishes settings.changed, all in the caller's tx. */
export async function updateSetting<K extends SettingKey>(
  tx: Tx,
  input: SetSettingInput<K>,
): Promise<SettingRecord<K>> {
  const value = parseSetting(input.key, input.value)
  const json = JSON.stringify(value)
  const current = await tx
    .selectFrom('settings')
    .select(['value', 'version'])
    .where('location_id', '=', input.locationId)
    .where('key', '=', input.key)
    .forUpdate()
    .executeTakeFirst()
  const beforeVersion = current?.version ?? 0
  if (input.expectedVersion !== undefined && input.expectedVersion !== beforeVersion) {
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: beforeVersion } })
  }
  const beforeValue = current ? parseSetting(input.key, current.value) : defaultSetting(input.key)

  const row = current
    ? await tx
        .updateTable('settings')
        .set((eb) => ({
          value: json,
          version: eb('version', '+', 1),
          updated_by: input.updatedBy ?? null,
          updated_at: eb.fn('app_now', []),
        }))
        .where('location_id', '=', input.locationId)
        .where('key', '=', input.key)
        .returning(['version', 'updated_at', 'updated_by'])
        .executeTakeFirstOrThrow()
    : await tx
        .insertInto('settings')
        .values({
          location_id: input.locationId,
          key: input.key,
          value: json,
          updated_by: input.updatedBy ?? null,
        })
        .onConflict((oc) => oc.columns(['location_id', 'key']).doNothing())
        .returning(['version', 'updated_at', 'updated_by'])
        .executeTakeFirst()
  // Lost an insert race with another writer: the client retries against the new row.
  if (!row) throw new AppError('CONCURRENT_UPDATE')

  await audit.record(tx, {
    locationId: input.locationId,
    action: 'settings.update',
    entityType: 'setting',
    entityId: input.key,
    before: beforeValue as JsonValue,
    after: value as JsonValue,
    ctx: input.audit,
  })
  await realtime.publish(tx, {
    locationId: input.locationId,
    channel: 'settings',
    type: 'settings.changed',
    payload: { section: input.key.split('.')[0]!, key: input.key, version: row.version },
  })
  return { key: input.key, value, version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by }
}
