// Direct-to-table factories for the payments tests (the commands under test are exercised through HTTP or the service).
import type { Db, Executor } from '../../src/platform/db.js'
import { createIdGenerator, type NewId } from '../../src/platform/ids.js'
import { ensureLocation, type Location } from '../../src/platform/locations.js'
import type { TestDb } from '../helpers/db.js'

export interface Env {
  location: Location
  locationId: string
  newId: NewId
}

export async function setupEnv(t: Pick<TestDb, 'db' | 'clock'>): Promise<Env> {
  const newId = createIdGenerator(t.clock)
  const location = await ensureLocation(t.db, newId)
  return { location, locationId: location.id, newId }
}

let n = 0

export async function makeCustomer(
  db: Executor,
  env: Env,
  o: { name?: string; optedIn?: boolean; email?: string | null; phone?: string | null } = {},
): Promise<string> {
  const id = env.newId()
  const i = ++n
  await db
    .insertInto('customers')
    .values({
      id,
      full_name: o.name ?? `Test Client ${i}`,
      phone_e164: o.phone === undefined ? `+1305555${String(1000 + (i % 9000)).padStart(4, '0')}` : o.phone,
      email: o.email === undefined ? null : o.email,
      sms_opted_in: o.optedIn ?? true,
      source: 'import',
    })
    .execute()
  return id
}

export interface MadeInvoice {
  id: string
  no: number
  customerId: string
  itemIds: string[]
}

let invNo = 30000

/** An invoice with items (cents) and optional pre-existing ledger rows; no appointment. */
export async function makeInvoice(
  db: Db,
  env: Env,
  o: {
    customerId?: string
    client?: string
    items?: { name: string; priceCents: number; kind?: 'package' | 'addon' }[]
    taxBp?: number
    tipCents?: number
    bizDate?: string
    occurredAt?: Date
    no?: number
  } = {},
): Promise<MadeInvoice> {
  const customerId = o.customerId ?? (await makeCustomer(db, env, { name: o.client }))
  const customer = await db.selectFrom('customers').select('full_name').where('id', '=', customerId).executeTakeFirstOrThrow()
  const id = env.newId()
  const no = o.no ?? ++invNo
  const at = o.occurredAt ?? new Date('2026-06-13T10:31:00-04:00')
  await db
    .insertInto('invoices')
    .values({
      id,
      location_id: env.locationId,
      invoice_no: no,
      appointment_id: null,
      customer_id: customerId,
      client_name: customer.full_name,
      vehicle_label: '2022 Tesla Model Y',
      staff_label: 'Lena K.',
      occurred_at: at,
      biz_date: o.bizDate ?? '2026-06-13',
      date_frozen_at: null,
      tax_bp: o.taxBp ?? 700,
      tip_cents: o.tipCents ?? 0,
      canceled_at: null,
      canceled_by: null,
      canceled_by_name: null,
      cancel_reason: null,
      payment_link_url: null,
      payment_link_sent_at: null,
    })
    .execute()
  const items = o.items ?? [
    { name: 'Premium Hand Wash + Interior', priceCents: 12900 },
    { name: 'Rain repellent', priceCents: 2500, kind: 'addon' as const },
  ]
  const itemIds: string[] = []
  for (const [position, it] of items.entries()) {
    const itemId = env.newId()
    itemIds.push(itemId)
    await db
      .insertInto('invoice_items')
      .values({
        id: itemId,
        invoice_id: id,
        position,
        kind: it.kind ?? (position === 0 ? 'package' : 'addon'),
        service_id: null,
        name: it.name,
        price_cents: it.priceCents,
        appointment_addon_id: null,
      })
      .execute()
  }
  return { id, no, customerId, itemIds }
}

export interface RawEvent {
  type: 'pay' | 'adjust' | 'refund' | 'credit_issue' | 'credit_apply' | 'void'
  amountCents: number
  status?: 'pending' | 'done' | 'denied'
  dest?: 'card' | 'credit' | 'cash'
  method?: string
  methodKind?: 'card' | 'apple_pay' | 'cash' | 'store_credit' | 'other'
  at?: Date
  expiry?: 'none' | 'd30' | 'd90'
  expiresAt?: Date | null
  processorState?: 'na' | 'awaiting_processor' | 'confirmed' | 'failed'
  actorUserId?: string | null
  reason?: string
  voidsEventId?: string
}

/** Writes a ledger row directly (bypassing the commands), for guard, calc and credit tests. */
export async function addEvent(db: Executor, env: Env, inv: Pick<MadeInvoice, 'id' | 'customerId'>, e: RawEvent): Promise<string> {
  const id = env.newId()
  const at = e.at ?? new Date('2026-06-13T10:36:00-04:00')
  const status = e.status ?? 'done'
  await db
    .insertInto('ledger_events')
    .values({
      id,
      location_id: env.locationId,
      invoice_id: inv.id,
      customer_id: inv.customerId,
      type: e.type,
      amount_cents: e.amountCents,
      status,
      method: e.method ?? null,
      method_kind: e.methodKind ?? null,
      dest: e.type === 'refund' ? (e.dest ?? 'card') : null,
      reason: e.reason ?? null,
      expiry: e.type === 'credit_issue' ? (e.expiry ?? 'none') : null,
      expires_at: e.type === 'credit_issue' ? (e.expiresAt ?? null) : null,
      actor_name: 'Test',
      actor_user_id: e.actorUserId ?? null,
      occurred_at: at,
      resolved_at: e.type === 'refund' && status !== 'pending' ? at : null,
      voids_event_id: e.voidsEventId ?? null,
      processor_state: e.processorState ?? 'na',
    })
    .execute()
  return id
}
