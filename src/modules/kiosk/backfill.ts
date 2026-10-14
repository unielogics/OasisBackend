// The history of the Team activity report (ADR 0180): staff_events rebuilt from what was recorded before they existed, so the report
// has history from day one. Run once after the release that brings staff events (`pnpm staff-events:backfill`); running it again
// adds nothing (an audit row has at most one event: staff_events.audit_id is unique, and a text at most one `text` event).
//   - audit_log rows of a person with an employee record: the appointment actions (the same map as the live commands,
//     scheduling/audit-helper.ts), the payments commands (payments/staff-events.ts), a client created, a saved-card charge, a text,
//     a kiosk opened with someone's PIN (ADR 0180 amendment; unlocks with the old shop code had no employee);
//   - staff texts in `messages` sent before texts were audited.
// System, automation and AI actions have no employee and are nobody's activity. The event's name is the employee's name today.
import { sql } from 'kysely'
import type { AuditContext } from '../../platform/audit.js'
import { transaction, type Db } from '../../platform/db.js'
import type { JsonValue } from '../../platform/schema.js'
import { recordStaffEvent, type StaffEventInput } from '../../platform/staff-events.js'
import { paymentStaffEventOf, PAYMENT_STAFF_ACTIONS } from '../payments/staff-events.js'
import { isAppointmentAuditAction, staffEventOf } from '../scheduling/audit-helper.js'
import './schema.js'

export interface BackfillResult {
  /** Audit rows and messages looked at. */
  scanned: number
  inserted: number
}

interface AuditRow {
  id: number
  at: Date
  location_id: string
  action: string
  entity_id: string | null
  before: unknown
  after: unknown
  actor_user_id: string | null
  actor_employee_id: string
  actor_name: string | null
  request_id: string | null
  kiosk_device_id: string | null
}

interface StaffText {
  id: string
  location_id: string
  queued_at: Date
  appointment_id: string | null
  customer_id: string | null
  sender_employee_id: string
}

const BATCH = 500
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)

/** The audit actions the backfill reads (besides `appointment.*`). */
const OTHER_ACTIONS = [...PAYMENT_STAFF_ACTIONS, 'customer.create', 'card.charged', 'message.staff_send', 'kiosk.unlock']

/** The staff event of one audit row, as the live command would have recorded it; null when it is nobody's activity. */
async function eventOf(db: Db, r: AuditRow): Promise<Omit<StaffEventInput, 'ctx' | 'locationId'> | null> {
  const after = rec(r.after)
  if (r.action.startsWith('appointment.')) {
    const action = r.action.slice('appointment.'.length)
    if (!isAppointmentAuditAction(action)) return null
    const ev = staffEventOf(action, r.before, r.after)
    return ev ? { kind: ev.kind, appointmentId: r.entity_id, meta: { action, ...ev.meta } } : null
  }
  if ((PAYMENT_STAFF_ACTIONS as readonly string[]).includes(r.action)) {
    const ev = paymentStaffEventOf(r.action, r.after)
    if (!ev || !r.entity_id) return null
    const inv = await db.selectFrom('invoices').select(['appointment_id', 'customer_id']).where('id', '=', r.entity_id).executeTakeFirst()
    return {
      kind: ev.kind,
      appointmentId: inv?.appointment_id ?? null,
      customerId: inv?.customer_id ?? null,
      amountCents: ev.amountCents,
      ledgerEventId: ev.ledgerEventId,
      meta: { action: r.action, invoiceId: r.entity_id, ...ev.meta },
    }
  }
  if (r.action === 'customer.create') return { kind: 'customer_create', customerId: r.entity_id }
  if (r.action === 'card.charged') {
    const charge = r.entity_id
      ? await db.selectFrom('square_charges').select(['appointment_id', 'customer_id', 'purpose']).where('id', '=', r.entity_id).executeTakeFirst()
      : undefined
    return {
      kind: 'payment',
      appointmentId: charge?.appointment_id ?? null,
      customerId: charge?.customer_id ?? null,
      amountCents: int(after.amountCents),
      ledgerEventId: str(after.eventId),
      meta: { action: 'card.charged', method: 'saved_card', purpose: charge?.purpose ?? str(after.purpose) ?? 'balance', invoiceId: str(after.invoiceId) },
    }
  }
  if (r.action === 'message.staff_send')
    return { kind: 'text', appointmentId: str(after.appointmentId), customerId: str(after.customerId), messageId: r.entity_id }
  if (r.action === 'kiosk.unlock') return { kind: 'kiosk_unlock', meta: { locksAt: str(after.locksAt) } }
  return null
}

const ctxOf = (r: Pick<AuditRow, 'actor_user_id' | 'actor_employee_id' | 'actor_name' | 'request_id' | 'kiosk_device_id'>): AuditContext => ({
  actor: { userId: r.actor_user_id, employeeId: r.actor_employee_id, name: r.actor_name },
  requestId: r.request_id,
  kioskDeviceId: r.kiosk_device_id,
})

/** Rebuilds the missing staff events of every location (or one). Idempotent; one transaction per batch. */
export async function backfillStaffEvents(db: Db, o: { locationId?: string; log?: (line: string) => void } = {}): Promise<BackfillResult> {
  const out: BackfillResult = { scanned: 0, inserted: 0 }
  let lastId = 0
  for (;;) {
    const rows = (await sql<AuditRow>`
      select a.id, a.at, a.location_id, a.action, a.entity_id, a.before, a.after, a.actor_user_id, a.actor_employee_id, a.actor_name,
        a.request_id, a.kiosk_device_id
      from audit_log a
      where a.id > ${lastId} and a.actor_employee_id is not null
        and (a.action like 'appointment.%' or a.action in (${sql.join(OTHER_ACTIONS)}))
        ${o.locationId ? sql`and a.location_id = ${o.locationId}::uuid` : sql``}
        and not exists (select 1 from staff_events s where s.audit_id = a.id)
      order by a.id
      limit ${BATCH}`.execute(db)).rows
    if (rows.length === 0) break
    lastId = rows[rows.length - 1]!.id
    out.scanned += rows.length
    await transaction(db, async (tx) => {
      for (const r of rows) {
        const ev = await eventOf(db, r)
        if (!ev) continue
        if (await recordStaffEvent(tx, { ...ev, locationId: r.location_id, ctx: ctxOf(r), auditId: r.id, at: r.at })) out.inserted++
      }
    })
  }
  // staff texts from before texts were audited: one `text` event per message
  let after: { at: Date; id: string } | null = null
  for (;;) {
    const msgs: StaffText[] = (await sql<StaffText>`
      select m.id, m.location_id, m.queued_at, m.appointment_id, m.customer_id, m.sender_employee_id
      from messages m
      where m.direction = 'out' and m.sender_kind = 'staff' and m.sender_employee_id is not null
        ${o.locationId ? sql`and m.location_id = ${o.locationId}::uuid` : sql``}
        ${after ? sql`and (m.queued_at, m.id) > (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
        and not exists (select 1 from staff_events s where s.message_id = m.id and s.kind = 'text')
      order by m.queued_at, m.id
      limit ${BATCH}`.execute(db)).rows
    if (msgs.length === 0) break
    out.scanned += msgs.length
    await transaction(db, async (tx) => {
      for (const m of msgs) {
        const ctx: AuditContext = { actor: { employeeId: m.sender_employee_id } }
        const meta: Record<string, JsonValue> = { source: 'messages' }
        if (
          await recordStaffEvent(tx, {
            locationId: m.location_id,
            ctx,
            kind: 'text',
            appointmentId: m.appointment_id,
            customerId: m.customer_id,
            messageId: m.id,
            at: m.queued_at,
            meta,
          })
        )
          out.inserted++
      }
    })
    if (msgs.length < BATCH) break
    const last: StaffText = msgs[msgs.length - 1]!
    after = { at: last.queued_at, id: last.id }
  }
  o.log?.(`staff events: ${out.inserted} added (${out.scanned} rows looked at)`)
  return out
}
