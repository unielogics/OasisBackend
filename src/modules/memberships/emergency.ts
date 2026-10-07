// Member credits and an emergency closure (ADR 0084). A credit is held by a visit when a `redeem` event names the appointment (the
// explicit apply or the automatic one). If the shop's closure is why that visit does not happen, the member must not lose it:
//  * at the close, with "Protect member credits" on, every affected appointment that holds a credit gets a `protect` marker
//    (it changes no count: the credit stays attached, so a reschedule keeps it, and the member cannot redeem it twice);
//  * when such an appointment is then canceled or marked no-show, the credit is given back with a `restore` event in the member's
//    current cycle (a bonus when the redeem belonged to an earlier cycle). Retention counts completed visits only, so a closure
//    never produces a missed-visit penalty.
import { sql } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import type { Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import type { ReleasedCredit } from '../scheduling/ports.js'

interface HeldCredit {
  id: string
  membership_id: string
  cycle_start: Date
  qty: number
  rule_id: string | null
  appointment_id: string
  invoice_id: string | null
  rule_label: string | null
}

/** Redeems of these appointments that have not been given back. */
async function heldCredits(tx: Tx, appointmentIds: readonly string[]): Promise<HeldCredit[]> {
  if (appointmentIds.length === 0) return []
  const r = await sql<HeldCredit>`
    select e.id, e.membership_id, e.cycle_start, e.qty::int as qty, e.rule_id, e.appointment_id, e.invoice_id, r.label as rule_label
    from membership_credit_events e
    left join plan_credit_rules r on r.id = e.rule_id
    where e.kind = 'redeem' and e.appointment_id = any(${appointmentIds as string[]}::uuid[])
      and not exists (select 1 from membership_credit_events x where x.idempotency_key = 'restore:' || e.id::text)
    order by e.created_at, e.id`.execute(tx)
  return r.rows
}

/** At the close: mark the credits the affected appointments hold. Returns how many were marked. */
export async function protectMemberCredits(
  tx: Tx,
  d: { clock: Clock; newId: NewId },
  ctx: { emergencyClosureId: string; appointmentIds: readonly string[] },
): Promise<number> {
  const held = await heldCredits(tx, ctx.appointmentIds)
  let n = 0
  for (const h of held) {
    const res = await sql`
      insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, rule_id, appointment_id, invoice_id, note, actor,
        idempotency_key, created_at)
      values (${d.newId()}, ${h.membership_id}, ${h.cycle_start}, 'protect', ${h.qty}, ${h.rule_id}, ${h.appointment_id}, ${h.invoice_id},
        'Emergency closure · credit protected', 'System', ${`protect:${h.appointment_id}:${ctx.emergencyClosureId}`}, ${d.clock.now()})
      on conflict (idempotency_key) do nothing`.execute(tx)
    n += Number(res.numAffectedRows ?? 0)
  }
  return n
}

/**
 * A canceled or no-show appointment that an emergency closure flagged (and whose closure protects credits) gives back the credit
 * it held. Idempotent per redeem. null when nothing was held, the job was not flagged, or the closure left credits unprotected.
 */
export async function restoreClosureCredit(
  tx: Tx,
  d: { clock: Clock; newId: NewId },
  appointmentId: string,
): Promise<ReleasedCredit | null> {
  const flag = await sql<{ credits: boolean }>`
    select c.credits from appointments a join emergency_closures c on c.id = a.emergency_closure_id
    where a.id = ${appointmentId}`.execute(tx)
  if (!flag.rows[0]?.credits) return null
  const held = (await heldCredits(tx, [appointmentId]))[0]
  if (!held) return null
  const m = await sql<{ current_period_start: Date | null }>`
    select current_period_start from memberships where id = ${held.membership_id}`.execute(tx)
  const cycle = m.rows[0]?.current_period_start ?? held.cycle_start
  await sql`
    insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, rule_id, appointment_id, invoice_id, note, actor,
      idempotency_key, created_at)
    values (${d.newId()}, ${held.membership_id}, ${cycle}, 'restore', ${held.qty}, ${held.rule_id}, ${held.appointment_id}, ${held.invoice_id},
      'Emergency closure · credit restored', 'System', ${`restore:${held.id}`}, ${d.clock.now()})
    on conflict (idempotency_key) do nothing`.execute(tx)
  return { ruleLabel: held.rule_label ?? 'Membership credit' }
}
