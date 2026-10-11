// Typed settings registry. Values live in settings(location_id, key) as jsonb; the registry is the single source of
// keys, validation and defaults. Writes are optimistic (version) and audited in the caller's transaction.
import { z } from 'zod/v4'
import type { Executor, Tx } from './db.js'
import { AppError } from './errors.js'
import * as audit from './audit.js'
import * as realtime from './realtime.js'
import type { JsonValue } from './schema.js'

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24 hour)')
const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Use an E.164 number such as +12015550142')
const catalogKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'Use a lowercase key (letters, digits, underscore)')
const label = z.string().trim().min(1).max(40)
const cents = z.number().int().min(0).max(10_000_000)

/**
 * The tint price matrix (ADR 0160): vehicle types x films, each pair with a member and a guest price range, and the VLT (visible
 * light transmission, %) options each film comes in. Seeded from the website in wave 2.
 */
const tintMatrix = z
  .object({
    vehicleTypes: z.array(z.object({ key: catalogKey, label }).strict()).max(20),
    films: z.array(z.object({ key: catalogKey, label, vlt: z.array(z.number().int().min(1).max(100)).max(10) }).strict()).max(20),
    prices: z
      .array(
        z
          .object({
            vehicle: catalogKey,
            film: catalogKey,
            memberMinCents: cents,
            memberMaxCents: cents,
            guestMinCents: cents,
            guestMaxCents: cents,
          })
          .strict(),
      )
      .max(400),
  })
  .strict()
  .superRefine((m, ctx) => {
    const issue = (path: (string | number)[], message: string): void => ctx.addIssue({ code: 'custom', path, message })
    const dupes = (keys: string[], path: string): void =>
      keys.forEach((k, i) => keys.indexOf(k) !== i && issue([path, i, 'key'], `"${k}" is listed twice`))
    dupes(m.vehicleTypes.map((v) => v.key), 'vehicleTypes')
    dupes(m.films.map((f) => f.key), 'films')
    const vehicles = new Set(m.vehicleTypes.map((v) => v.key))
    const films = new Set(m.films.map((f) => f.key))
    const pairs = new Set<string>()
    m.prices.forEach((p, i) => {
      if (!vehicles.has(p.vehicle)) issue(['prices', i, 'vehicle'], `Unknown vehicle type "${p.vehicle}"`)
      if (!films.has(p.film)) issue(['prices', i, 'film'], `Unknown film "${p.film}"`)
      if (p.memberMinCents > p.memberMaxCents) issue(['prices', i, 'memberMaxCents'], 'The range ends below its start')
      if (p.guestMinCents > p.guestMaxCents) issue(['prices', i, 'guestMaxCents'], 'The range ends below its start')
      const pair = `${p.vehicle}/${p.film}`
      if (pairs.has(pair)) issue(['prices', i], `${pair} is priced twice`)
      pairs.add(pair)
    })
  })

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
  // What cancel and no-show do with the money held on the invoice (ADR 0082). Cancelling at least freeCancelHours before the
  // start refunds it in full; later, lateRetainBp of it is kept (10000 = all, 0 = none); a no-show keeps noShowRetainBp.
  'cancellation.policy': {
    schema: z.object({
      freeCancelHours: z.number().int().min(0).max(720),
      lateRetainBp: z.number().int().min(0).max(10_000),
      noShowRetainBp: z.number().int().min(0).max(10_000),
      refundTo: z.enum(['original', 'credit']),
    }),
    default: {
      freeCancelHours: 24,
      lateRetainBp: 10_000,
      noShowRetainBp: 10_000,
      refundTo: 'original' as const,
    },
  },
  // The website's guest booking fee (ADR 0150): what a guest (no active membership) owes for an online booking and how the
  // shop collects it, at the counter or through a Squarespace payment link staff text after the booking. Members pay none.
  // The site shows the fee as a deposit due; nothing is charged online (no card capture anywhere).
  'booking.guest_fee': {
    schema: z.object({
      cents: z.number().int().min(0).max(100_000),
      collect: z.enum(['counter', 'link']),
    }),
    default: { cents: 2500, collect: 'counter' as const },
  },
  // Standing (recurring) appointments and the waitlist: schema, endpoints and jobs exist, nothing runs until this is turned on
  // (and the matching VIP toggle in Settings is on). No UI yet (ADR 0086).
  'features.standing_waitlist': { schema: z.boolean(), default: false },
  'sms.quiet_hours': {
    schema: z.object({ enabled: z.boolean(), start: hhmm, end: hhmm }),
    default: { enabled: false, start: '21:00', end: '08:00' },
  },

  // The AI text assistant (ADR 0160). Off until the owner turns it on; the stage widens who it answers: the allowlisted numbers
  // (owner and staff), then known clients, then everyone. A staff reply pauses it on the thread for staff_pause_hours.
  'assistant.enabled': { schema: z.boolean(), default: false },
  'assistant.stage': { schema: z.enum(['allowlist', 'customers', 'everyone']), default: 'allowlist' as const },
  'assistant.allowlist': { schema: z.array(e164).max(50), default: [] as string[] },
  'assistant.staff_pause_hours': { schema: z.number().int().min(1).max(72), default: 12 },
  'assistant.faq': {
    schema: z.array(z.object({ q: z.string().trim().min(1).max(500), a: z.string().trim().min(1).max(500) }).strict()).max(40),
    default: [] as { q: string; a: string }[],
  },
  'assistant.actions_enabled': { schema: z.boolean(), default: false },
  // Reminders (plan I): reminders.offsets_min above keeps its shape; the confirmation request ("Reply C") for booked visits, and
  // per-category preparation lines appended to the reminder (e.g. tint: "Plan for 2–3 hours.").
  'reminders.confirm_request': { schema: z.boolean(), default: true },
  'reminders.category_prep': {
    schema: z.record(catalogKey, z.string().trim().min(1).max(160)),
    default: {} as Record<string, string>,
  },
  // Status texts as the car moves (design section 6): checked in (queued checked_in_delay_min after a manual arrival), running
  // late (cleaning past the promised end + late_grace_min, at most late_max per visit), ready, picked up (with the book-again link
  // only when this is on and the client has marketing-grade consent).
  'status_texts.checked_in': { schema: z.boolean(), default: true },
  'status_texts.checked_in_delay_min': { schema: z.number().int().min(0).max(30), default: 3 },
  'status_texts.running_late': { schema: z.boolean(), default: true },
  'status_texts.late_grace_min': { schema: z.number().int().min(0).max(120), default: 10 },
  'status_texts.late_max': { schema: z.number().int().min(0).max(2), default: 2 },
  'status_texts.ready': { schema: z.boolean(), default: true },
  'status_texts.picked_up': { schema: z.boolean(), default: true },
  'status_texts.book_again_link': { schema: z.boolean(), default: false },
  // The one automatic follow-up text to a lead who did not book (plan J).
  'leads.follow_up_enabled': { schema: z.boolean(), default: true },
  'leads.follow_up_delay_min': { schema: z.number().int().min(15).max(1440), default: 180 },
  'leads.business_hours_only': { schema: z.boolean(), default: true },
  // at most the lead_follow_up class's reply window (24 hours): a longer setting could never be honoured
  'leads.within_hours': { schema: z.number().int().min(1).max(24), default: 24 },
  // The catalog (plan A): the guest price is the member price plus this markup unless a service sets its own; the tint matrix.
  'catalog.guest_markup_pct': { schema: z.number().int().min(0).max(200), default: 20 },
  'catalog.tint_matrix': {
    schema: tintMatrix,
    default: { vehicleTypes: [], films: [], prices: [] } as z.infer<typeof tintMatrix>,
  },
  // Personal links carry the epoch they were issued in; bumping it kills every link and session at once (incident switch).
  'links.epoch': { schema: z.number().int().min(1).max(1_000_000), default: 1 },
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
