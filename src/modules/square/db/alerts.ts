// What the rest of the app reads about Square (ADR 0171, design 2.5): the "Square payments to match" queue, the Square section of the
// reconciliation, the Operations "Needs attention" alerts, the card hint and the status-row counts. All computed on read, so they
// clear the moment the payment is matched, the refund settled or the connection healthy again.
import { sql } from 'kysely'
import type { Env } from '../../../config/env.js'
import type { Executor } from '../../../platform/db.js'
import { formatUsd } from '../../../platform/money.js'
import { invoiceLabel } from '../../payments/format.js'
import type { CardHintProvider } from '../../payments/ports.js'
import type { ExternalAlert, ExternalAlertSource } from '../../scheduling/ports.js'
import { squareMethod } from '../ledger.js'
import { squareEnv } from '../runtime.js'
import { currentSquareState } from './state.js'
import type { SquareCandidate } from './schema.js'

const MIN = 60_000
const HOUR = 60 * MIN
/** A payment waiting in the queue longer than this is an alert. */
export const UNMATCHED_ALERT_MINUTES = 30
/** A failed card refund and an overpaid invoice stay on the board this long (staff give the money back another way). */
export const SQUARE_ALERT_DAYS = 14

/** A saved-card charge Square has not answered for this long is shown to staff (wave Q3a). */
export const UNANSWERED_CHARGE_ALERT_MINUTES = 10

export interface SquarePaymentToMatch {
  paymentId: string
  matchState: 'pending' | 'unmatched'
  classification: string | null
  amountCents: number
  tipCents: number
  totalCents: number
  refundedCents: number
  method: string
  sourceType: string | null
  brand: string | null
  last4: string | null
  note: string | null
  receiptNumber: string | null
  product: string | null
  createdAt: string
  ageMinutes: number
  candidates: SquareCandidate[]
}

/** The payments a person has to look at: unmatched ones, and counter payments still pending (the matcher runs every minute). */
export async function squarePaymentsToMatch(db: Executor, locationId: string, now: Date): Promise<SquarePaymentToMatch[]> {
  const rows = await db
    .selectFrom('square_payments')
    .selectAll()
    .where('location_id', '=', locationId)
    .where('match_state', 'in', ['unmatched', 'pending'])
    .where('status', '=', 'COMPLETED')
    .orderBy('square_created_at')
    .orderBy('square_payment_id')
    .limit(200)
    .execute()
  return rows.map((r) => ({
    paymentId: r.square_payment_id,
    matchState: r.match_state as 'pending' | 'unmatched',
    classification: r.classification,
    amountCents: r.amount_cents,
    tipCents: r.tip_cents,
    totalCents: r.total_cents,
    refundedCents: r.refunded_cents,
    method: squareMethod({ sourceType: r.source_type, brand: r.card_brand, last4: r.last4 }).method,
    sourceType: r.source_type,
    brand: r.card_brand,
    last4: r.last4,
    note: r.note,
    receiptNumber: r.receipt_number,
    product: r.square_product,
    createdAt: r.square_created_at.toISOString(),
    ageMinutes: Math.max(0, Math.floor((now.getTime() - r.square_created_at.getTime()) / MIN)),
    candidates: r.candidates ?? [],
  }))
}

export interface FailedSquareRefund {
  eventId: string
  invoiceId: string
  label: string
  client: string
  amountCents: number
  occurredAt: string
  /** What Square did give back of it (legs that completed; written as its own confirmed refund once every leg settled). */
  refundedCents: number
  /** What did not go back to the card and is not on its way: the staff give this back another way. */
  uncoveredCents: number
  errors: string[]
}

/**
 * Card refunds through Square that did not (all) go back: failed ones, and ones still waiting with a leg already failed or rejected
 * (another leg on its way), so the staff learn at once.
 */
export async function failedSquareRefunds(db: Executor, locationId: string, since: Date): Promise<FailedSquareRefund[]> {
  const r = await sql<{
    id: string
    invoice_id: string
    invoice_no: number
    client_name: string
    amount_cents: number
    occurred_at: Date
    done: string | number | null
    live: string | number | null
    errors: string[] | null
  }>`
    select e.id, e.invoice_id, i.invoice_no, i.client_name, e.amount_cents, e.occurred_at,
           (select sum(l.amount_cents) from square_refund_legs l where l.ledger_event_id = e.id and l.state = 'completed') as done,
           (select sum(l.amount_cents) from square_refund_legs l
              where l.ledger_event_id = e.id and l.state in ('to_submit', 'pending', 'completed')) as live,
           (select array_agg(l.error) from square_refund_legs l where l.ledger_event_id = e.id and l.error is not null) as errors
    from ledger_events e join invoices i on i.id = e.invoice_id
    where e.location_id = ${locationId} and e.type = 'refund' and e.processor = 'square'
      and (e.processor_state = 'failed'
        or (e.processor_state = 'awaiting_processor'
          and exists (select 1 from square_refund_legs l where l.ledger_event_id = e.id and l.state in ('failed', 'rejected'))))
      and e.occurred_at >= ${since}
    order by e.occurred_at desc, e.seq desc
    limit 50`.execute(db)
  return r.rows.map((x) => ({
    eventId: x.id,
    invoiceId: x.invoice_id,
    label: invoiceLabel(x.invoice_no),
    client: x.client_name,
    amountCents: x.amount_cents,
    occurredAt: x.occurred_at.toISOString(),
    refundedCents: Number(x.done ?? 0),
    uncoveredCents: Math.max(0, x.amount_cents - Number(x.live ?? 0)),
    errors: x.errors ?? [],
  }))
}

export interface SquareReconciliation {
  paymentsToMatch: SquarePaymentToMatch[]
  failedRefunds: FailedSquareRefund[]
  /** Refund legs sent to Square (or about to be) and not settled yet. */
  refundsInFlight: number
}

/** The Square section of GET /payments/reconciliation. */
export async function squareReconciliation(db: Executor, locationId: string, now: Date): Promise<SquareReconciliation> {
  const inFlight = await db
    .selectFrom('square_refund_legs')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('location_id', '=', locationId)
    .where('state', 'in', ['to_submit', 'pending'])
    .executeTakeFirst()
  return {
    paymentsToMatch: await squarePaymentsToMatch(db, locationId, now),
    failedRefunds: await failedSquareRefunds(db, locationId, new Date(now.getTime() - 90 * 24 * HOUR)),
    refundsInFlight: Number(inFlight?.n ?? 0),
  }
}

/** The counts of the status row. */
export async function squareCounts(db: Executor, locationId: string, now: Date): Promise<{ unmatched: number; failedRefunds: number }> {
  const u = await db
    .selectFrom('square_payments')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('location_id', '=', locationId)
    .where('match_state', '=', 'unmatched')
    .executeTakeFirst()
  const f = await failedSquareRefunds(db, locationId, new Date(now.getTime() - SQUARE_ALERT_DAYS * 24 * HOUR))
  return { unmatched: Number(u?.n ?? 0), failedRefunds: f.length }
}

/** Square's health, as the alerts and the status row read it (only meaningful when SQUARE_PROVIDER=live). */
export function squareHealthProblems(
  env: Pick<Env, 'SQUARE_PROVIDER'>,
  state: { last_catchup_at: Date | null; watermark: Date | null; last_catchup_claimed_at: Date | null; last_webhook_at: Date | null; last_error: string | null; last_error_at: Date | null } | undefined,
  now: Date,
): Array<{ key: string; title: string; desc: string }> {
  if (env.SQUARE_PROVIDER !== 'live') return []
  const out: Array<{ key: string; title: string; desc: string }> = []
  const t = now.getTime()
  if (state?.last_error && state.last_error_at && t - state.last_error_at.getTime() < 24 * HOUR && /401|access token|ACCESS_TOKEN|UNAUTHORIZED/i.test(state.last_error))
    out.push({ key: 'square_auth', title: 'Square refused the access token', desc: 'Payments from Square are not coming in · update the token in Settings' })
  if (!state?.last_catchup_at || t - state.last_catchup_at.getTime() > 30 * MIN || (state.watermark && t - state.watermark.getTime() > 27 * 24 * HOUR))
    out.push({ key: 'square_catchup', title: 'Square check-in is behind', desc: 'Oasis has not read Square’s events lately · some payments may be late' })
  if (
    state?.last_catchup_claimed_at &&
    t - state.last_catchup_claimed_at.getTime() < 24 * HOUR &&
    (!state.last_webhook_at || t - state.last_webhook_at.getTime() > 24 * HOUR)
  )
    out.push({ key: 'square_webhook', title: 'Square notifications are not arriving', desc: 'Payments come in only every 10 minutes · check the Square webhook' })
  return out
}

/**
 * "Needs attention": payments waiting to be matched, failed card refunds, refunds made directly in the Square app, invoices overpaid
 * through Square, Square's health.
 */
export const squareExternalAlerts: ExternalAlertSource = {
  async list(db, ctx): Promise<ExternalAlert[]> {
    const out: ExternalAlert[] = []
    const now = ctx.now
    const since = new Date(now.getTime() - SQUARE_ALERT_DAYS * 24 * HOUR)
    for (const f of await failedSquareRefunds(db, ctx.locationId, since)) {
      const inv = await db.selectFrom('invoices').select('appointment_id').where('id', '=', f.invoiceId).executeTakeFirst()
      out.push({
        key: `square_refund_failed:${f.eventId}`,
        kind: 'square_refund_failed',
        tone: 'red',
        title: `Card refund failed · ${f.client}`,
        // only what did not go back (and is not on its way): the part Square gave back stays counted as refunded
        desc: `${f.uncoveredCents < f.amountCents ? `${formatUsd(f.uncoveredCents)} of a ${formatUsd(f.amountCents)} card refund` : formatUsd(f.amountCents)} on ${f.label} did not go back to the card · refund it in cash or store credit`,
        actionLabel: 'Review',
        appointmentId: inv?.appointment_id ?? null,
        priority: 0,
      })
    }
    // a saved-card charge Square has not confirmed (wave Q3a): the job re-sends it for 23 hours; after 10 minutes staff should know
    const unanswered = await sql<{ id: string; amount_cents: number; reason: string | null; client: string; appointment_id: string | null }>`
      select q.id, q.amount_cents, q.reason, c.full_name as client, q.appointment_id
      from square_charges q join customers c on c.id = q.customer_id
      where q.location_id = ${ctx.locationId}
        and (q.state = 'unknown' or (q.state = 'charging' and q.attempted_at < ${new Date(now.getTime() - 5 * MIN)}))
        and q.attempted_at < ${new Date(now.getTime() - UNANSWERED_CHARGE_ALERT_MINUTES * MIN)}
      order by q.attempted_at limit 20`.execute(db)
    for (const q of unanswered.rows)
      out.push({
        key: `square_charge_unknown:${q.id}`,
        kind: 'square_charge_unknown',
        tone: 'amber',
        title: `Saved-card charge not confirmed · ${q.client}`,
        desc: `${q.reason ?? 'Charge'} of ${formatUsd(q.amount_cents)}: Square has not answered yet · check the Square dashboard before charging again`,
        actionLabel: 'Review',
        appointmentId: q.appointment_id,
        priority: 0,
      })
    // a refund made directly in the Square app, outside Oasis limits and approvals
    const external = await sql<{ id: string; amount_cents: number; invoice_no: number; client_name: string; appointment_id: string | null }>`
      select e.id, e.amount_cents, i.invoice_no, i.client_name, i.appointment_id
      from ledger_events e join invoices i on i.id = e.invoice_id
      where e.location_id = ${ctx.locationId} and e.type = 'refund' and e.source = 'square' and e.needs_review
        and e.occurred_at >= ${since}
      order by e.occurred_at desc, e.seq desc limit 20`.execute(db)
    for (const x of external.rows)
      out.push({
        key: `square_external_refund:${x.id}`,
        kind: 'square_external_refund',
        tone: 'amber',
        title: `Refunded in the Square app · ${x.client_name}`,
        desc: `${formatUsd(x.amount_cents)} on ${invoiceLabel(x.invoice_no)}, outside Oasis limits and approvals · review it`,
        actionLabel: 'Review',
        appointmentId: x.appointment_id,
        priority: 0,
      })
    // only the invoices Square paid lately are computed (the board reads this on every refresh); a no-show or late-cancel fee charged
    // on a saved card (wave Q3a) sits on the canceled invoice on top of what the visit cost: it is not an overpayment
    const over = await sql<{ id: string; invoice_no: number; client_name: string; overpaid: string | number; appointment_id: string | null; waiting: boolean }>`
      with sq as (
        select distinct e.invoice_id from ledger_events e
        where e.location_id = ${ctx.locationId} and e.processor = 'square' and e.type = 'pay' and e.occurred_at >= ${since}
      ), o as (
        select i.id, i.invoice_no, i.client_name, i.appointment_id,
          c.overpaid - coalesce((select sum(q.amount_cents) from square_charges q
            where q.invoice_id = i.id and q.state = 'charged' and q.purpose in ('no_show_fee', 'late_cancel_fee')), 0) as overpaid
        from sq join invoices i on i.id = sq.invoice_id cross join lateral invoice_calc_of(i.id) c
        where c.overpaid > 0
      )
      select id, invoice_no, client_name, overpaid, appointment_id,
        exists (select 1 from ledger_events w where w.invoice_id = o.id and w.type = 'pay' and w.processor_state = 'awaiting_processor'
          and not exists (select 1 from ledger_events v where v.voids_event_id = w.id)) as waiting
      from o
      where overpaid > 0
      order by invoice_no desc limit 20`.execute(db)
    for (const o of over.rows)
      out.push({
        key: `square_overpaid:${o.id}`,
        kind: 'square_overpaid',
        tone: 'amber',
        title: `Overpaid via Square · ${o.client_name}`,
        // a staff card entry still waiting may be this very money entered twice (review Q4 M1): check it before giving money back
        desc: o.waiting
          ? `${formatUsd(Number(o.overpaid))} more than ${invoiceLabel(o.invoice_no)} · a staff card entry is still waiting: check it before refunding`
          : `${formatUsd(Number(o.overpaid))} more than ${invoiceLabel(o.invoice_no)} · refund the difference`,
        actionLabel: 'Refund',
        appointmentId: o.appointment_id,
        priority: 0,
      })
    if (ctx.manager) {
      const waiting = await db
        .selectFrom('square_payments')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('location_id', '=', ctx.locationId)
        .where('status', '=', 'COMPLETED')
        .where('match_state', 'in', ['unmatched', 'pending'])
        .where('first_seen_at', '<=', new Date(now.getTime() - UNMATCHED_ALERT_MINUTES * MIN))
        .executeTakeFirst()
      const n = Number(waiting?.n ?? 0)
      if (n > 0)
        out.push({
          key: 'square_unmatched',
          kind: 'square_unmatched',
          tone: 'violet',
          title: `${n} Square ${n === 1 ? 'payment needs' : 'payments need'} matching`,
          desc: 'Match each to an invoice or set it aside in Payments',
          actionLabel: 'Review',
          appointmentId: null,
          priority: 0,
        })
      const env = squareEnv()
      const state = await currentSquareState(db, ctx.locationId, env)
      for (const p of squareHealthProblems(env, state, now))
        out.push({ key: p.key, kind: 'square_problem', tone: 'red', title: p.title, desc: p.desc, actionLabel: 'Review', appointmentId: null, priority: 0 })
    }
    return out
  },
}

/** The card hint with Square: the brand of the client's latest Square card payment. */
export const squareCardHints: CardHintProvider = {
  async hintFor(db, customerId) {
    const r = await db
      .selectFrom('ledger_events')
      .select('brand')
      .where('customer_id', '=', customerId)
      .where('type', '=', 'pay')
      .where('processor', '=', 'square')
      .where('brand', 'is not', null)
      .orderBy('occurred_at', 'desc')
      .orderBy('seq', 'desc')
      .executeTakeFirst()
    return r?.brand ? { brand: r.brand } : null
  },
}

/** Square's hint once Square is the processor, the given one (Squarespace's) before. */
export function processorCardHints(before: CardHintProvider): CardHintProvider {
  return {
    hintFor: (db, customerId) => (squareEnv().PAYMENT_PROCESSOR === 'square' ? squareCardHints : before).hintFor(db, customerId),
  }
}
