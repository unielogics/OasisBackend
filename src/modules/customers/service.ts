// Customers and vehicles: repository functions plus the rules around them (upsert by E.164 phone, vehicle by plate,
// contact-aware search, VIP flag). Reads accept a Db or Tx; writes take a Tx.
import { sql, type Expression, type SqlBool } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError, registerProblems } from '../../platform/errors.js'
import { isUuid, type NewId } from '../../platform/ids.js'
import { formatPhoneDisplay, normalizePhone } from '../../platform/phone.js'
import './schema.js'
import '../settings/schema.js'
import type { CustomerSource, SmsOptInSource } from './schema.js'

registerProblems({
  CUSTOMER_PHONE_IN_USE: {
    status: 409,
    title: 'Number already in use',
    detail: 'Another customer already has that mobile number',
  },
})

export interface CustomerRecord {
  id: string
  fullName: string
  phoneE164: string | null
  phoneDisplay: string | null
  email: string | null
  notes: string | null
  smsOptedIn: boolean
  smsOptInSource: SmsOptInSource | null
  smsOptInAt: Date | null
  smsOptedOutAt: Date | null
  emailBouncedAt: Date | null
  source: CustomerSource
  synthetic: boolean
  needsDetails: boolean
  mergedInto: string | null
  deletedAt: Date | null
  version: number
  createdAt: Date
}

export interface VehicleRecord {
  id: string
  customerId: string
  year: number | null
  make: string | null
  model: string | null
  color: string | null
  plate: string | null
  deletedAt: Date | null
}

const CUSTOMER_COLUMNS = [
  'id',
  'full_name',
  'phone_e164',
  'phone_display',
  'email',
  'notes',
  'sms_opted_in',
  'sms_opt_in_source',
  'sms_opt_in_at',
  'sms_opted_out_at',
  'email_bounced_at',
  'source',
  'synthetic',
  'needs_details',
  'merged_into',
  'deleted_at',
  'version',
  'created_at',
] as const

type CustomerRow = {
  id: string
  full_name: string
  phone_e164: string | null
  phone_display: string | null
  email: string | null
  notes: string | null
  sms_opted_in: boolean
  sms_opt_in_source: SmsOptInSource | null
  sms_opt_in_at: Date | null
  sms_opted_out_at: Date | null
  email_bounced_at: Date | null
  source: CustomerSource
  synthetic: boolean
  needs_details: boolean
  merged_into: string | null
  deleted_at: Date | null
  version: number
  created_at: Date
}

const toCustomer = (r: CustomerRow): CustomerRecord => ({
  id: r.id,
  fullName: r.full_name,
  phoneE164: r.phone_e164,
  phoneDisplay: r.phone_display,
  email: r.email,
  notes: r.notes,
  smsOptedIn: r.sms_opted_in,
  smsOptInSource: r.sms_opt_in_source,
  smsOptInAt: r.sms_opt_in_at,
  smsOptedOutAt: r.sms_opted_out_at,
  emailBouncedAt: r.email_bounced_at,
  source: r.source,
  synthetic: r.synthetic,
  needsDetails: r.needs_details,
  mergedInto: r.merged_into,
  deletedAt: r.deleted_at,
  version: r.version,
  createdAt: r.created_at,
})

/** Contact fields blanked for callers without cli.contact. */
export type RedactedCustomer = Omit<CustomerRecord, 'phoneE164' | 'phoneDisplay' | 'email'> & {
  phoneE164: null
  phoneDisplay: null
  email: null
  redacted: true
}

export function redactCustomer(c: CustomerRecord): RedactedCustomer {
  return { ...c, phoneE164: null, phoneDisplay: null, email: null, redacted: true }
}

const toVehicle = (r: {
  id: string
  customer_id: string
  year: number | null
  make: string | null
  model: string | null
  color: string | null
  plate: string | null
  deleted_at: Date | null
}): VehicleRecord => ({
  id: r.id,
  customerId: r.customer_id,
  year: r.year,
  make: r.make,
  model: r.model,
  color: r.color,
  plate: r.plate,
  deletedAt: r.deleted_at,
})

const VEHICLE_COLUMNS = [
  'id',
  'customer_id',
  'year',
  'make',
  'model',
  'color',
  'plate',
  'deleted_at',
] as const

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505'

const blank = (s: string | null | undefined): s is null | undefined =>
  s === null || s === undefined || s.trim() === ''
const clean = (s: string | null | undefined): string | null => (blank(s) ? null : s.trim())

function invalidPhone(): AppError {
  const message = 'Enter a valid mobile number.'
  return new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path: 'phone', message }] })
}

export function normalizePlate(plate: string | null | undefined): string | null {
  if (blank(plate)) return null
  return plate.trim().replace(/\s+/g, ' ').toUpperCase()
}

export async function getCustomer(db: Executor, id: string): Promise<CustomerRecord | undefined> {
  if (!isUuid(id)) return undefined
  const r = await db
    .selectFrom('customers')
    .select([...CUSTOMER_COLUMNS])
    .where('id', '=', id)
    .executeTakeFirst()
  return r ? toCustomer(r) : undefined
}

export async function requireCustomer(db: Executor, id: string): Promise<CustomerRecord> {
  const c = await getCustomer(db, id)
  if (!c) throw new AppError('NOT_FOUND', { detail: 'That customer does not exist' })
  return c
}

/** The live (not merged, not deleted) customer owning an E.164 number. */
export async function findCustomerByPhone(
  db: Executor,
  phoneE164: string,
): Promise<CustomerRecord | undefined> {
  const r = await db
    .selectFrom('customers')
    .select([...CUSTOMER_COLUMNS])
    .where('phone_e164', '=', phoneE164)
    .where('merged_into', 'is', null)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return r ? toCustomer(r) : undefined
}

export interface UpsertCustomerInput {
  newId: NewId
  /** Injected clock reading, used for opt-in timestamps. */
  now: Date
  fullName?: string | null
  /** Any format libphonenumber accepts for the US; stored as E.164. Omit for a walk-in without a number. */
  phone?: string | null
  email?: string | null
  notes?: string | null
  source?: CustomerSource
  /** Records an SMS opt-in with this source, unless the customer opted out. */
  smsOptIn?: SmsOptInSource | null
  /** Seed and test people only (the database requires a 555-01xx number). */
  synthetic?: boolean
}

export interface UpsertCustomerResult {
  customer: CustomerRecord
  created: boolean
  changed: boolean
}

/**
 * Finds the live customer by E.164 phone and fills what is missing, or creates one. An existing customer's name is only
 * replaced while it is a placeholder (needs_details); everything else goes through updateCustomer.
 */
export async function upsertCustomerByPhone(
  tx: Tx,
  input: UpsertCustomerInput,
): Promise<UpsertCustomerResult> {
  const phone = blank(input.phone) ? null : normalizePhone(input.phone)
  if (!blank(input.phone) && phone === null) throw invalidPhone()
  const name = clean(input.fullName)

  if (phone) {
    const existing = await findCustomerByPhone(tx, phone)
    if (existing) return fillExisting(tx, existing, input, name)
  }

  const id = input.newId()
  const optedIn = input.smsOptIn
    ? { sms_opted_in: true, sms_opt_in_source: input.smsOptIn, sms_opt_in_at: input.now }
    : {}
  const values = {
    id,
    full_name: name ?? 'Walk-in guest',
    phone_e164: phone,
    phone_display: phone ? formatPhoneDisplay(phone) : null,
    email: clean(input.email),
    notes: clean(input.notes),
    source: input.source ?? 'dashboard',
    synthetic: input.synthetic ?? false,
    needs_details: name === null || phone === null,
    ...optedIn,
  }
  const inserted = phone
    ? await tx
        .insertInto('customers')
        .values(values)
        .onConflict((oc) =>
          oc
            .column('phone_e164')
            .where('phone_e164', 'is not', null)
            .where('merged_into', 'is', null)
            .where('deleted_at', 'is', null)
            .doNothing(),
        )
        .returning('id')
        .executeTakeFirst()
    : await tx.insertInto('customers').values(values).returning('id').executeTakeFirst()
  if (!inserted) {
    // Lost a race on the phone number: the winner's row is committed and visible now.
    const winner = await findCustomerByPhone(tx, phone!)
    if (!winner) throw new AppError('CONCURRENT_UPDATE')
    return fillExisting(tx, winner, input, name)
  }
  return { customer: await requireCustomer(tx, id), created: true, changed: true }
}

async function fillExisting(
  tx: Tx,
  existing: CustomerRecord,
  input: UpsertCustomerInput,
  name: string | null,
): Promise<UpsertCustomerResult> {
  const set: Record<string, unknown> = {}
  if (name && existing.needsDetails) set.full_name = name
  const email = clean(input.email)
  if (email && existing.email === null) set.email = email
  const notes = clean(input.notes)
  if (notes && existing.notes === null) set.notes = notes
  if (input.smsOptIn && !existing.smsOptedIn && existing.smsOptedOutAt === null) {
    set.sms_opted_in = true
    set.sms_opt_in_source = input.smsOptIn
    set.sms_opt_in_at = input.now
  }
  if (Object.keys(set).length === 0) return { customer: existing, created: false, changed: false }
  const fullName = (set.full_name as string | undefined) ?? existing.fullName
  set.needs_details = fullName === 'Walk-in guest' || existing.phoneE164 === null
  await tx
    .updateTable('customers')
    .set((eb) => ({ ...set, version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }))
    .where('id', '=', existing.id)
    .execute()
  return { customer: await requireCustomer(tx, existing.id), created: false, changed: true }
}

export interface UpdateCustomerPatch {
  fullName?: string
  phone?: string | null
  email?: string | null
  notes?: string | null
  needsDetails?: boolean
}

export async function updateCustomer(
  tx: Tx,
  input: { id: string; patch: UpdateCustomerPatch; expectedVersion?: number },
): Promise<CustomerRecord> {
  const row = isUuid(input.id)
    ? await tx
        .selectFrom('customers')
        .select([...CUSTOMER_COLUMNS])
        .where('id', '=', input.id)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That customer does not exist' })
  if (input.expectedVersion !== undefined && input.expectedVersion !== row.version)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: row.version } })
  const p = input.patch
  const set: Record<string, unknown> = {}
  if (p.fullName !== undefined) {
    const n = clean(p.fullName)
    if (!n)
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Enter a name.',
        errors: [{ path: 'fullName', message: 'Enter a name.' }],
      })
    set.full_name = n
  }
  if (p.phone !== undefined) {
    const phone = blank(p.phone) ? null : normalizePhone(p.phone)
    if (!blank(p.phone) && phone === null) throw invalidPhone()
    set.phone_e164 = phone
    set.phone_display = phone ? formatPhoneDisplay(phone) : null
  }
  if (p.email !== undefined) set.email = clean(p.email)
  if (p.notes !== undefined) set.notes = clean(p.notes)
  if (p.needsDetails !== undefined) set.needs_details = p.needsDetails
  else if (p.fullName !== undefined || p.phone !== undefined) {
    const name = (set.full_name as string | undefined) ?? row.full_name
    const phone = 'phone_e164' in set ? (set.phone_e164 as string | null) : row.phone_e164
    set.needs_details = name === 'Walk-in guest' || phone === null
  }
  if (Object.keys(set).length === 0) return toCustomer(row)
  try {
    await tx
      .updateTable('customers')
      .set((eb) => ({ ...set, version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }))
      .where('id', '=', row.id)
      .execute()
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('CUSTOMER_PHONE_IN_USE')
    throw e
  }
  return requireCustomer(tx, row.id)
}

export async function recordSmsOptIn(
  tx: Tx,
  customerId: string,
  source: SmsOptInSource,
  now: Date,
): Promise<CustomerRecord> {
  await tx
    .updateTable('customers')
    .set((eb) => ({
      sms_opted_in: true,
      sms_opt_in_source: source,
      sms_opt_in_at: now,
      sms_opted_out_at: null,
      version: eb('version', '+', 1),
      updated_at: eb.fn('app_now', []),
    }))
    .where('id', '=', customerId)
    .execute()
  return requireCustomer(tx, customerId)
}

export async function recordSmsOptOut(tx: Tx, customerId: string, now: Date): Promise<CustomerRecord> {
  await tx
    .updateTable('customers')
    .set((eb) => ({
      sms_opted_in: false,
      sms_opted_out_at: now,
      version: eb('version', '+', 1),
      updated_at: eb.fn('app_now', []),
    }))
    .where('id', '=', customerId)
    .execute()
  return requireCustomer(tx, customerId)
}

// Vehicles ---------------------------------------------------------------------------------------------------------

export interface UpsertVehicleInput {
  newId: NewId
  customerId: string
  year?: number | null
  make?: string | null
  model?: string | null
  color?: string | null
  plate?: string | null
}

export interface UpsertVehicleResult {
  vehicle: VehicleRecord
  created: boolean
}

/**
 * Finds the customer's vehicle by plate (case-insensitive, including a soft-deleted one, which is revived) and fills
 * the details that were provided; with no plate it reuses an identical year/make/model/color or adds a new row.
 */
export async function upsertVehicleByPlate(tx: Tx, input: UpsertVehicleInput): Promise<UpsertVehicleResult> {
  const plate = normalizePlate(input.plate)
  const details = {
    year: input.year ?? null,
    make: clean(input.make),
    model: clean(input.model),
    color: clean(input.color),
  }
  if (
    details.year !== null &&
    (!Number.isInteger(details.year) || details.year < 1900 || details.year > 2100)
  )
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Enter a valid model year.',
      errors: [{ path: 'year', message: 'Enter a valid model year.' }],
    })

  let existing = plate
    ? await tx
        .selectFrom('vehicles')
        .select([...VEHICLE_COLUMNS])
        .where('customer_id', '=', input.customerId)
        .where(sql<boolean>`upper(plate) = ${plate}`)
        .forUpdate()
        .executeTakeFirst()
    : await tx
        .selectFrom('vehicles')
        .select([...VEHICLE_COLUMNS])
        .where('customer_id', '=', input.customerId)
        .where('plate', 'is', null)
        .where('deleted_at', 'is', null)
        .where(sql<boolean>`year is not distinct from ${details.year}`)
        .where(sql<boolean>`make is not distinct from ${details.make}`)
        .where(sql<boolean>`model is not distinct from ${details.model}`)
        .where(sql<boolean>`color is not distinct from ${details.color}`)
        .executeTakeFirst()

  if (existing) {
    const set: Record<string, unknown> = {}
    if (details.year !== null && existing.year !== details.year) set.year = details.year
    if (details.make && existing.make !== details.make) set.make = details.make
    if (details.model && existing.model !== details.model) set.model = details.model
    if (details.color && existing.color !== details.color) set.color = details.color
    if (existing.deleted_at !== null) set.deleted_at = null
    if (Object.keys(set).length > 0) {
      await tx.updateTable('vehicles').set(set).where('id', '=', existing.id).execute()
      existing = await tx
        .selectFrom('vehicles')
        .select([...VEHICLE_COLUMNS])
        .where('id', '=', existing.id)
        .executeTakeFirstOrThrow()
    }
    return { vehicle: toVehicle(existing), created: false }
  }
  const id = input.newId()
  await tx
    .insertInto('vehicles')
    .values({ id, customer_id: input.customerId, plate, deleted_at: null, ...details })
    .execute()
  const row = await tx
    .selectFrom('vehicles')
    .select([...VEHICLE_COLUMNS])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return { vehicle: toVehicle(row), created: true }
}

export async function listVehicles(db: Executor, customerId: string): Promise<VehicleRecord[]> {
  const rows = await db
    .selectFrom('vehicles')
    .select([...VEHICLE_COLUMNS])
    .where('customer_id', '=', customerId)
    .where('deleted_at', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  return rows.map(toVehicle)
}

/** Live vehicles carrying a plate (case-insensitive), across customers. */
export async function findVehiclesByPlate(db: Executor, plate: string): Promise<VehicleRecord[]> {
  const p = normalizePlate(plate)
  if (!p) return []
  const rows = await db
    .selectFrom('vehicles')
    .select([...VEHICLE_COLUMNS])
    .where(sql<boolean>`upper(plate) = ${p}`)
    .where('deleted_at', 'is', null)
    .orderBy('created_at')
    .execute()
  return rows.map(toVehicle)
}

export async function softDeleteVehicle(tx: Tx, vehicleId: string): Promise<void> {
  await tx
    .updateTable('vehicles')
    .set({ deleted_at: sql`app_now()` })
    .where('id', '=', vehicleId)
    .where('deleted_at', 'is', null)
    .execute()
}

// VIP flag ---------------------------------------------------------------------------------------------------------

/** VIP is membership of vip_clients for the location, never a per-appointment flag. */
export async function vipCustomerIds(
  db: Executor,
  locationId: string,
  customerIds: string[],
): Promise<Set<string>> {
  if (customerIds.length === 0) return new Set()
  const rows = await db
    .selectFrom('vip_clients')
    .select('customer_id')
    .where('location_id', '=', locationId)
    .where('customer_id', 'in', customerIds)
    .execute()
  return new Set(rows.map((r) => r.customer_id))
}

export async function isVipCustomer(db: Executor, locationId: string, customerId: string): Promise<boolean> {
  return (await vipCustomerIds(db, locationId, [customerId])).has(customerId)
}

// Search -----------------------------------------------------------------------------------------------------------

export interface CustomerSearchHit {
  id: string
  fullName: string
  /** null when the caller lacks cli.contact. */
  phoneDisplay: string | null
  /** null when the caller lacks cli.contact. */
  email: string | null
  vip: boolean
  needsDetails: boolean
  vehicles: VehicleRecord[]
}

export interface SearchCustomersInput {
  locationId: string
  q: string
  /** Effective cli.contact. Without it phone and email are neither searched nor returned. */
  canContact: boolean
  limit?: number
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`)

/**
 * Every whitespace-separated token must match the name or a vehicle (plate, make, model, color); callers with
 * cli.contact also match the E.164 number (3+ digits) and the email. Without cli.contact a phone or email token can only
 * match a name or plate, so a number typed into the box never reveals who owns it.
 */
export async function searchCustomers(
  db: Executor,
  input: SearchCustomersInput,
): Promise<CustomerSearchHit[]> {
  const tokens = input.q.trim().split(/\s+/).filter(Boolean).slice(0, 6)
  if (tokens.length === 0) return []
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50)
  let q = db
    .selectFrom('customers as c')
    .select([...CUSTOMER_COLUMNS.map((c) => `c.${c}` as const)])
    .where('c.deleted_at', 'is', null)
    .where('c.merged_into', 'is', null)
  for (const token of tokens) {
    const pat = `%${escapeLike(token)}%`
    const digits = token.replace(/\D/g, '')
    q = q.where((eb) => {
      const parts: Expression<SqlBool>[] = [
        sql<boolean>`c.full_name ilike ${pat}`,
        eb.exists(
          eb
            .selectFrom('vehicles as v')
            .select(sql<number>`1`.as('one'))
            .whereRef('v.customer_id', '=', 'c.id')
            .where('v.deleted_at', 'is', null)
            .where(
              sql<boolean>`(v.plate ilike ${pat} or v.make ilike ${pat} or v.model ilike ${pat} or v.color ilike ${pat})`,
            ),
        ),
      ]
      if (input.canContact) {
        parts.push(sql<boolean>`c.email::text ilike ${pat}`)
        if (digits.length >= 3) parts.push(sql<boolean>`c.phone_e164 like ${`%${digits}%`}`)
      }
      return eb.or(parts)
    })
  }
  const rows = await q.orderBy('c.full_name').orderBy('c.id').limit(limit).execute()
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const vehicleRows = await db
    .selectFrom('vehicles')
    .select([...VEHICLE_COLUMNS])
    .where('customer_id', 'in', ids)
    .where('deleted_at', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  const byCustomer = new Map<string, VehicleRecord[]>()
  for (const v of vehicleRows) {
    const list = byCustomer.get(v.customer_id) ?? []
    list.push(toVehicle(v))
    byCustomer.set(v.customer_id, list)
  }
  const vips = await vipCustomerIds(db, input.locationId, ids)
  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    phoneDisplay: input.canContact ? r.phone_display : null,
    email: input.canContact ? r.email : null,
    vip: vips.has(r.id),
    needsDetails: r.needs_details,
    vehicles: byCustomer.get(r.id) ?? [],
  }))
}

/** Live customers whose trimmed name equals the text (case-insensitive), then those containing it. */
export async function findCustomersByName(
  db: Executor,
  name: string,
  limit = 8,
): Promise<{ exact: CustomerRecord[]; partial: CustomerRecord[] }> {
  const n = name.trim()
  if (n === '') return { exact: [], partial: [] }
  const base = () =>
    db
      .selectFrom('customers')
      .select([...CUSTOMER_COLUMNS])
      .where('deleted_at', 'is', null)
      .where('merged_into', 'is', null)
  const exact = await base()
    .where(sql<boolean>`lower(btrim(full_name)) = lower(${n})`)
    .orderBy('full_name')
    .orderBy('id')
    .limit(limit)
    .execute()
  const partial =
    exact.length > 0
      ? []
      : await base()
          .where(sql<boolean>`full_name ilike ${`%${escapeLike(n)}%`}`)
          .orderBy('full_name')
          .orderBy('id')
          .limit(limit)
          .execute()
  return { exact: exact.map(toCustomer), partial: partial.map(toCustomer) }
}
