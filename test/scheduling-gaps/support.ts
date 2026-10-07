// Helpers shared by the b6 gap tests: the membership rig (real app, session authorizer, real payments gateway and messaging
// queue over a frozen clock) plus direct ledger rows, the policy setting and the observable effects of a cancel.
import { sql } from 'kysely'
import { DESIGN_CUSTOMERS } from '../../db/seeds/domain.js'
import { useMemRig, type MemRig } from '../memberships/harness.js'

export type Rig = MemRig
/** The membership rig with the seeded design customers' (synthetic) numbers allowlisted, so texts are really queued. */
export const useRig = (env: Record<string, string> = {}): Rig =>
  useMemRig({ env: { SMS_ALLOWLIST: DESIGN_CUSTOMERS.map((c) => c.phoneE164).join(','), ...env } })

let keyN = 0
export const idemKey = (): string => `gap-key-${++keyN}-${'g'.repeat(10)}`

export interface PolicySetting {
  freeCancelHours: number
  lateRetainBp: number
  noShowRetainBp: number
  refundTo: 'original' | 'credit'
}

export async function setPolicy(rig: Rig, p: Partial<PolicySetting>): Promise<void> {
  const cur = (await rig.get(rig.superS(), '/settings/cancellation-policy')).json() as {
    policy: PolicySetting
    version: number
  }
  const res = await rig.send(
    rig.superS(),
    'PUT',
    '/settings/cancellation-policy',
    { ...cur.policy, ...p, version: cur.version },
    false,
  )
  if (res.statusCode !== 200) throw new Error(`policy save failed ${res.statusCode} ${res.body}`)
}

/** A payment of `cents` against the invoice, written the way the ledger stores one (a deposit or a part payment). */
export async function recordPayment(
  rig: Rig,
  invoiceId: string,
  cents: number,
  o: { kind?: 'card' | 'cash'; deposit?: boolean; state?: 'awaiting_processor' | 'confirmed' | 'na' } = {},
): Promise<string> {
  const db = rig.h.t.db
  const inv = await db
    .selectFrom('invoices')
    .select(['location_id', 'customer_id'])
    .where('id', '=', invoiceId)
    .executeTakeFirstOrThrow()
  const id = rig.h.t.app.newId()
  const kind = o.kind ?? 'card'
  await db
    .insertInto('ledger_events')
    .values({
      id,
      location_id: inv.location_id,
      invoice_id: invoiceId,
      customer_id: inv.customer_id,
      type: 'pay',
      amount_cents: cents,
      method: kind === 'cash' ? 'Cash' : 'Visa',
      method_kind: kind,
      brand: kind === 'card' ? 'Visa' : null,
      deposit: o.deposit ?? true,
      actor_name: 'Test',
      occurred_at: rig.h.clock.now(),
      source: 'oasis',
      processor_state: o.state ?? (kind === 'card' ? 'awaiting_processor' : 'na'),
    })
    .execute()
  return id
}

export interface LedgerRow {
  type: string
  amount_cents: number
  status: string
  dest: string | null
  method_kind: string | null
  processor_state: string
  source: string
  reason: string | null
  note: string | null
  actor_roles: string | null
  idempotency_key: string | null
}

export async function ledgerOf(rig: Rig, invoiceId: string): Promise<LedgerRow[]> {
  return (
    await sql<LedgerRow>`
    select type, amount_cents::int, status, dest, method_kind, processor_state, source, reason, note, actor_roles, idempotency_key
    from ledger_events where invoice_id = ${invoiceId} order by seq`.execute(rig.h.t.db)
  ).rows
}

export interface InvoiceState {
  status: string
  paid: number
  refunded: number
  balance: number
  pending_n: number
}

export async function invoiceState(rig: Rig, invoiceId: string): Promise<InvoiceState> {
  const r = await sql<InvoiceState>`
    select status, paid::int, refunded::int, balance::int, pending_n::int from invoice_calc_of(${invoiceId}::uuid)`.execute(
    rig.h.t.db,
  )
  return r.rows[0]!
}

export async function activityOf(rig: Rig, appointmentId: string): Promise<string[]> {
  return (
    await rig.h.t.db
      .selectFrom('activity_log')
      .select('text')
      .where('appointment_id', '=', appointmentId)
      .orderBy('id')
      .execute()
  ).map((r) => r.text)
}

export async function outboundTexts(rig: Rig, appointmentId: string): Promise<string[]> {
  return (
    await rig.h.t.db
      .selectFrom('messages')
      .select('body')
      .where('appointment_id', '=', appointmentId)
      .where('direction', '=', 'out')
      .orderBy('queued_at')
      .orderBy('id')
      .execute()
  ).map((r) => r.body)
}

export async function opsEvents(
  rig: Rig,
  type?: string,
): Promise<{ type: string; payload: Record<string, unknown> }[]> {
  let q = rig.h.t.db
    .selectFrom('realtime_events')
    .select(['type', 'payload'])
    .where('channel', '=', 'ops')
    .orderBy('id')
  if (type) q = q.where('type', '=', type)
  return (await q.execute()) as { type: string; payload: Record<string, unknown> }[]
}

export interface CreditEventRow {
  kind: string
  qty: number | null
  appointment_id: string | null
  ledger_event_id: string | null
  note: string | null
  actor: string | null
}

export async function creditEvents(
  rig: Rig,
  membershipId: string,
  kinds?: string[],
): Promise<CreditEventRow[]> {
  const rows = (
    await sql<CreditEventRow>`
      select kind, qty, appointment_id, ledger_event_id, note, actor
      from membership_credit_events where membership_id = ${membershipId} order by created_at, id`.execute(
      rig.h.t.db,
    )
  ).rows
  return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows
}

export interface CreditView {
  left: number | null
  used: number
  rules: { label: string; left: number | null; used: number; unlimited: boolean; autoApply?: boolean }[]
}

export async function creditsOf(rig: Rig, customerId: string): Promise<CreditView> {
  const r = await rig.get(rig.superS(), `/customers/${customerId}/membership`)
  return (r.json() as { membership: { credits: CreditView } }).membership.credits
}

/** advance from booked to completed as `s` (default the Super Admin), the way the dashboard's one button does. */
export async function completeAs(rig: Rig, appointmentId: string, s = rig.superS()): Promise<void> {
  for (const from of ['booked', 'confirmed', 'arrived', 'cleaning'] as const) {
    const r = await rig.send(
      s,
      'POST',
      `/appointments/${appointmentId}/advance`,
      { expectedStatus: from },
      false,
    )
    if (r.statusCode !== 200) throw new Error(`advance from ${from}: ${r.statusCode} ${r.body}`)
  }
}

export async function setRuleAutoApply(
  rig: Rig,
  planKey: string,
  label: string,
  autoApply: boolean,
): Promise<void> {
  const plans = (await rig.get(rig.superS(), '/membership-plans')).json() as {
    plans: { key: string; rules: { id: string; label: string }[] }[]
  }
  const rule = plans.plans.find((p) => p.key === planKey)!.rules.find((x) => x.label === label)!
  const res = await rig.send(
    rig.superS(),
    'PATCH',
    `/membership-plans/rules/${rule.id}`,
    { autoApply },
    false,
  )
  if (res.statusCode !== 200) throw new Error(`rule patch failed ${res.statusCode} ${res.body}`)
}

/** A completed visit `daysAgo` days before the frozen clock, written directly (the booking API refuses the past). */
export async function completedVisit(
  rig: Rig,
  customerId: string,
  daysAgo: number,
  status = 'completed',
): Promise<string> {
  const db = rig.h.t.db
  const svc = await db
    .selectFrom('services')
    .select(['id', 'name', 'price_cents', 'duration_min'])
    .where('name', '=', 'Express Hand Wash')
    .executeTakeFirstOrThrow()
  const loc = await db.selectFrom('locations').select('id').executeTakeFirstOrThrow()
  const at = new Date(rig.h.clock.now().getTime() - daysAgo * 86_400_000)
  const id = rig.h.t.app.newId()
  await db
    .insertInto('appointments')
    .values({
      id,
      location_id: loc.id,
      customer_id: customerId,
      vehicle_id: null,
      service_id: svc.id,
      package_name: svc.name,
      price_cents: svc.price_cents,
      duration_min: svc.duration_min,
      status: status as never,
      scheduled_start: at,
      scheduled_end: new Date(at.getTime() + svc.duration_min * 60_000),
      completed_at: status === 'completed' ? at : null,
      pickup_state: status === 'completed' ? 'collected' : null,
    })
    .execute()
  return id
}
