// Typed settings registry. Values live in settings(location_id, key) as jsonb; the registry is the single source of
// keys, validation and defaults. Writes are optimistic (version) and audited in the caller's transaction.
import { z } from 'zod/v4'
import type { Executor, Tx } from './db.js'
import { AppError } from './errors.js'
import * as audit from './audit.js'
import * as realtime from './realtime.js'
import type { JsonValue } from './schema.js'
import { TAX_ROUNDINGS, type TaxRounding } from './money.js'

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24 hour)')
const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Use an E.164 number such as +12015550142')
const catalogKey = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, 'Use a lowercase key (letters, digits, underscore)')
const label = z.string().trim().min(1).max(40)
const cents = z.number().int().min(0).max(10_000_000)

/**
 * The tint price matrix (ADR 0160): vehicle types x films, each pair with a member and a guest price range, and the VLT (visible
 * light transmission, %) options each film comes in. Seeded from the website in wave 2.
 */
/** The tint films (catalog.tint_films, ADR 0170): key (a tint package's tag), label and VLT shades; keys listed once. */
const tintFilms = z
  .array(z.object({ key: catalogKey, label, vlt: z.array(z.number().int().min(1).max(100)).max(10) }).strict())
  .max(20)
  .superRefine((films, ctx) =>
    films.forEach(
      (f, i) =>
        films.findIndex((x) => x.key === f.key) !== i && ctx.addIssue({ code: 'custom', path: [i, 'key'], message: `"${f.key}" is listed twice` }),
    ),
  )

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
  // Sales tax rate of new invoices in thousandths of a percent (ADR 0173): 7000 = 7%, 6625 = 6.625% (New Jersey). Each invoice keeps
  // the rate (invoices.tax_dbp) and rounding it was made with. Edited in Settings -> Billing & integrations (PUT
  // /settings/billing/sales-tax, a percentage with up to three decimals).
  'tax.rate_dbp': { schema: z.number().int().min(0).max(100_000), default: 7000 },
  // How new invoices round their tax (ADR 0173), written on each invoice as invoices.tax_rounding. half_up (the design's rule) by
  // default, so every 7% invoice is made exactly as before; half_even (Square's rule, sandbox check SQR-18) is set at the rollout
  // together with 6.625%, with PUT /settings/billing/sales-tax {rounding}.
  'tax.rounding': { schema: z.enum(TAX_ROUNDINGS), default: 'half_up' as TaxRounding },
  'tax.label': { schema: z.string().trim().min(1).max(40), default: 'Tax' },
  currency: { schema: z.enum(['USD']), default: 'USD' as const },
  'federal_holidays.auto': { schema: z.boolean(), default: true },
  'ops.late_grace_min': { schema: z.number().int().min(0).max(120), default: 10 },
  'ops.eta_visible_max_min': { schema: z.number().int().min(0).max(240), default: 30 },
  'memberships.auto_apply': { schema: z.boolean(), default: false },
  // Memberships billed by Square (ADR 0171 wave Q3b, plan decision 7): a renewal Square could not charge keeps the perks on for
  // graceDays (the client is texted a card link at once), then the membership is past due (perks off), and after cancelDays it is
  // canceled at Square. Any payment restores it.
  'memberships.billing_policy': {
    schema: z
      .object({ graceDays: z.number().int().min(0).max(60), cancelDays: z.number().int().min(1).max(90) })
      .refine((p) => p.cancelDays > p.graceDays, { message: 'Cancel after the grace days end', path: ['cancelDays'] }),
    default: { graceDays: 7, cancelDays: 21 },
  },
  // "Move members" (plan decision 8): members on an older tier price are told this many days before their price moves.
  // plan decision 8: members hear about a new price at least 30 days before it is billed (review Q4 pricing:F3)
  'memberships.price_change_notice_days': { schema: z.number().int().min(30).max(90), default: 30 },
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
  // The website's guest booking fee (ADR 0150): what a guest (no active membership) owes for an online booking, a deposit toward the
  // visit, and how the shop collects it: at the counter; by a payment link (with PAYMENT_PROCESSOR=square a Square quick-pay link the
  // job square.deposit-link creates and texts after the booking, ADR 0171 D2; before that, a link staff text); or `card_hold` (wave
  // Q3a, a saved card: accepted, not used yet, collected at the counter until then). Members pay none.
  'booking.guest_fee': {
    schema: z.object({
      cents: z.number().int().min(0).max(100_000),
      collect: z.enum(['counter', 'link', 'card_hold']),
    }),
    default: { cents: 2500, collect: 'counter' as const },
  },
  // Square payment links (ADR 0171 D5): whether Square's checkout asks for a tip. Off by default.
  'payments.link_tipping': { schema: z.boolean(), default: false },
  // No-show and late-cancel fees on a saved card (ADR 0171 D7, wave Q3a): off until the owner sets the amounts. When on (and Square is
  // the processor), a no-show or a cancel inside the free window PROPOSES a charge for the fee beyond the deposit kept, on the
  // client's saved card whose consent covers it; a staff member charges or waives it. Nothing is charged on its own.
  'fees.card_on_file': {
    schema: z
      .object({
        enabled: z.boolean(),
        noShowCents: z.number().int().min(0).max(100_000),
        lateCancelCents: z.number().int().min(0).max(100_000),
      })
      .strict(),
    default: { enabled: false, noShowCents: 0, lateCancelCents: 0 },
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
  // ADR 0174 (limits and tone): settings only take abilities away; the defaults are today's behaviour. Edited in Settings → Oasis AI
  // → Limits & tone and applied by the turn (src/modules/assistant/policy.ts).
  'assistant.capabilities': {
    schema: z
      .object({
        availability: z.boolean(),
        bookingLinks: z.boolean(),
        membershipLinks: z.boolean(),
        paymentLinks: z.boolean(),
        accountInfo: z.boolean(),
      })
      .strict(),
    default: { availability: true, bookingLinks: true, membershipLinks: true, paymentLinks: true, accountInfo: true },
  },
  'assistant.behavior': {
    schema: z
      .object({
        tone: z.enum(['friendly', 'professional', 'warm', 'concise']),
        length: z.enum(['short', 'standard']),
        styleNotes: z.string().trim().max(400),
        spanish: z.enum(['on', 'english', 'handoff']),
        avoidWords: z.array(z.string().trim().min(2).max(40)).max(30),
        avoidTopics: z.array(z.string().trim().min(3).max(80)).max(15),
        handoffTopics: z.array(z.string().trim().min(3).max(80)).max(15),
        signOff: z.string().trim().max(24),
      })
      .strict(),
    default: {
      tone: 'friendly' as const,
      length: 'standard' as const,
      styleNotes: '',
      spanish: 'on' as const,
      avoidWords: [] as string[],
      avoidTopics: [] as string[],
      handoffTopics: [] as string[],
      signOff: '',
    },
  },
  // The welcome flow's ceiling (W4c fixes, before stage everyone): at most this many NEW provisional clients from first texts an hour;
  // beyond it a first text is stored for staff without a client, a lead or an AI reply (one notice to the managers an hour).
  'assistant.new_texters_per_hour': { schema: z.number().int().min(1).max(1000), default: 30 },
  // Reminders (plan I): reminders.offsets_min above keeps its shape; the confirmation request ("Reply C") for booked visits, and
  // per-category preparation lines appended to the reminder (e.g. tint: "Plan for 2–3 hours.").
  'reminders.confirm_request': { schema: z.boolean(), default: true },
  'reminders.category_prep': {
    schema: z.record(catalogKey, z.string().trim().min(1).max(160)),
    default: {} as Record<string, string>,
  },
  // Status texts as the car moves (design section 6): checked in (queued checked_in_delay_min after a manual arrival), running
  // late (cleaning past the promised end + late_grace_min, at most late_max per visit), ready, picked up (with the book-again link
  // only when this is on and the client has marketing-grade consent). The three new texts are OFF until the owner turns them on in
  // Settings -> Reminders (wave W3d: nothing switches on by itself in production); ready-for-pickup was sent before and stays on.
  'status_texts.checked_in': { schema: z.boolean(), default: false },
  'status_texts.checked_in_delay_min': { schema: z.number().int().min(0).max(30), default: 3 },
  'status_texts.running_late': { schema: z.boolean(), default: false },
  'status_texts.late_grace_min': { schema: z.number().int().min(0).max(120), default: 10 },
  'status_texts.late_max': { schema: z.number().int().min(0).max(2), default: 2 },
  'status_texts.ready': { schema: z.boolean(), default: true },
  'status_texts.picked_up': { schema: z.boolean(), default: false },
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
  // The tint films (ADR 0170): the film a tint package names by a tag, its label and VLT shades; the packages are priced by size.
  'catalog.tint_films': {
    schema: tintFilms,
    default: [] as z.infer<typeof tintFilms>,
  },
  // Kiosk mode (ADR 0180, amendment 2026-10-14): the sign-in page is the keypad, and an employee's PIN typed on the shop's network
  // unlocks the tablet. On by default (migration 20261017100000 turns the boot-time default row on, never a value somebody set); it
  // does nothing until a Super Admin adds the shop's network and a manager sets PINs. Off (Settings -> Kiosk, PUT /kiosk/settings)
  // revokes every kiosk session and brings back the email sign-in page.
  'kiosk.enabled': { schema: z.boolean(), default: true },
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
