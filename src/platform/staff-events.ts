// Per-employee activity (ADR 0180, wave K1b): one staff_events row per car step, booking, add-on, checklist tick, photo, payment, tip,
// receipt, payment link, text and check-in link, in the name of the employee who did it: the employee tapped on the kiosk, or the
// signed-in person's own employee record. The source of the Team activity report (src/modules/kiosk/report.ts).
//
// Written in the command's own transaction, only when the request has an acting employee (system, automation, geofence and AI
// actions have none and are not anyone's activity). The name is the employee's display name ("Marco R.") at the time; `via` says
// whether it came from a kiosk (with its device) or a signed-in session (with its user). `auditId` links the audit row the command
// wrote, at most one event per audit row (a unique index), so the history backfill never doubles a live event.
import { sql } from 'kysely'
import type { StaffEventKind } from '../modules/kiosk/schema.js'
import type { AuditContext } from './audit.js'
import type { Tx } from './db.js'
import { isUuid } from './ids.js'
import type { JsonValue } from './schema.js'

export interface StaffEventInput {
  locationId: string
  /** Who did it: the request's audit context (acting employee, user, kiosk device, request id). No employee: nothing is written. */
  ctx: AuditContext | null | undefined
  kind: StaffEventKind
  appointmentId?: string | null
  /** The client; defaults to the appointment's client. */
  customerId?: string | null
  amountCents?: number | null
  ledgerEventId?: string | null
  messageId?: string | null
  /** The audit_log row written by the same command. */
  auditId?: number | null
  meta?: Record<string, JsonValue>
  /** When it happened; default app_now() (the command's own time). The history backfill passes the audit row's time. */
  at?: Date
}

const uuidOrNull = (v: string | null | undefined): string | null => (isUuid(v) ? v : null)

/** The SQL of an employee's display name ("Marco R."), the same as auth/context.ts displayName. */
export const employeeDisplayNameSql = (alias: string) =>
  sql<string>`(btrim(${sql.ref(`${alias}.first`)}) || case when btrim(${sql.ref(`${alias}.last`)}) <> ''
    then ' ' || upper(left(btrim(${sql.ref(`${alias}.last`)}), 1)) || '.' else '' end)`

/**
 * Records one staff event; false when there is no acting employee (or the employee row is gone) or the audit row already has its
 * event. Ids that name no row (a test's made-up user, an appointment deleted meanwhile) are stored as null rather than failing the
 * command.
 */
export async function recordStaffEvent(tx: Tx, e: StaffEventInput): Promise<boolean> {
  const employeeId = uuidOrNull(e.ctx?.actor?.employeeId)
  if (!employeeId) return false
  const appointmentId = uuidOrNull(e.appointmentId)
  const customerId = uuidOrNull(e.customerId)
  const userId = uuidOrNull(e.ctx?.actor?.userId)
  const deviceId = uuidOrNull(e.ctx?.kioskDeviceId)
  const r = await sql`
    insert into staff_events (location_id, at, employee_id, employee_name, kind, appointment_id, customer_id, amount_cents,
      ledger_event_id, message_id, via, kiosk_device_id, user_id, request_id, meta, audit_id)
    select ${e.locationId}::uuid, coalesce(${e.at ?? null}::timestamptz, app_now()), e.id, ${employeeDisplayNameSql('e')}, ${e.kind},
      (select a.id from appointments a where a.id = ${appointmentId}::uuid),
      coalesce((select c.id from customers c where c.id = ${customerId}::uuid),
        (select a.customer_id from appointments a where a.id = ${appointmentId}::uuid)),
      ${e.amountCents ?? null}::integer,
      (select l.id from ledger_events l where l.id = ${uuidOrNull(e.ledgerEventId)}::uuid),
      (select m.id from messages m where m.id = ${uuidOrNull(e.messageId)}::uuid),
      ${deviceId ? 'kiosk' : 'signed_in'},
      (select d.id from kiosk_devices d where d.id = ${deviceId}::uuid),
      (select u.id from users u where u.id = ${userId}::uuid),
      ${e.ctx?.requestId ?? null}::text,
      ${JSON.stringify(e.meta ?? {})}::jsonb,
      ${e.auditId ?? null}::bigint
    from employees e
    where e.id = ${employeeId}::uuid
    on conflict do nothing`.execute(tx)
  return Number(r.numAffectedRows ?? 0) > 0
}
