// In-chat actions (ADR 0160, design sections 0 and 4): what a proposal stores, how it is described to the client, and the checks
// the proposal and the confirmation share. A proposal (propose_booking / propose_reschedule / propose_cancel, trusted numbers only)
// is an assistant_pending_actions row whose 4-digit reply number is texted by the server ("Signature Hand Wash, Sat Jun 20 at
// 10:00 AM. Reply 4821 to confirm.") and stored only hashed; the model never sees it. The payload holds server-side ids (never an
// input of the model) and is validated again when the right number comes back.
import { z } from 'zod/v4'
import type { Executor } from '../../../platform/db.js'
import { getSetting } from '../../../platform/settings.js'
import { sql } from 'kysely'

export const BookPayload = z.strictObject({
  serviceKey: z.string(),
  serviceName: z.string(),
  addonKeys: z.array(z.string()),
  date: z.string(),
  startMin: z.number().int(),
  vehicleId: z.string().nullable(),
})
export type BookPayload = z.infer<typeof BookPayload>

export const ReschedulePayload = z.strictObject({
  appointmentId: z.string(),
  serviceName: z.string(),
  date: z.string(),
  startMin: z.number().int(),
})
export type ReschedulePayload = z.infer<typeof ReschedulePayload>

export const CancelPayload = z.strictObject({
  appointmentId: z.string(),
  serviceName: z.string(),
  reason: z.string(),
})
export type CancelPayload = z.infer<typeof CancelPayload>

/** Why a cancel by text is not allowed (then the assistant hands it to staff). */
export type CancelBlock = 'late' | 'money_held' | null

/**
 * A cancel by text only outside the late window (cancellation.policy freeCancelHours before the start) and with no money held on the
 * visit (paid, awaiting the processor, or store credit applied): anything that would settle money is the staff's.
 */
export async function cancelBlockOf(db: Executor, o: { locationId: string; appointmentId: string; start: Date; now: Date }): Promise<CancelBlock> {
  const policy = (await getSetting(db, o.locationId, 'cancellation.policy')).value
  if (o.start.getTime() - o.now.getTime() < policy.freeCancelHours * 3_600_000) return 'late'
  const r = await sql<{ held: string | number | null }>`
    select coalesce(sum(greatest(c.refundable, 0) + greatest(c.pending_amt, 0) + greatest(c.credit_applied, 0)), 0) as held
    from invoices i cross join lateral invoice_calc_of(i.id) c
    where i.appointment_id = ${o.appointmentId} and i.canceled_at is null`.execute(db)
  return Number(r.rows[0]?.held ?? 0) > 0 ? 'money_held' : null
}

/** "Signature Hand Wash + Tire Shine" (at most two add-ons by name, then "+N more"). */
export function serviceWithAddons(service: string, addons: readonly string[]): string {
  if (addons.length === 0) return service
  const named = addons.slice(0, 2).join(' + ')
  return `${service} + ${named}${addons.length > 2 ? ` +${addons.length - 2} more` : ''}`
}

/** The action_confirm summary (the template adds ". Reply NNNN to confirm."). */
export function actionSummary(
  a: { kind: 'book'; service: string; when: string } | { kind: 'reschedule'; service: string; when: string } | { kind: 'cancel'; service: string; when: string },
): string {
  const s = a.kind === 'book' ? `${a.service}, ${a.when}` : a.kind === 'reschedule' ? `Move your ${a.service} to ${a.when}` : `Cancel your ${a.service} ${a.when.startsWith('today') || a.when.startsWith('tomorrow') ? '' : 'on '}${a.when}`
  return s.length > 140 ? `${s.slice(0, 137)}...` : s
}
