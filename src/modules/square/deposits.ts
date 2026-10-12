// The booking deposit by Square link (ADR 0171 D2, plan decision 4, design 3.5). The guest booking fee is a DEPOSIT TOWARD THE VISIT:
// a `pay` with deposit=true on the visit's invoice, settled by the existing cancel and no-show rules (scheduling/settlement.ts keeps
// or refunds it unchanged). When booking.guest_fee.collect is `link` and Square is the processor, every online booking path (the
// website, a personal link, the assistant) asks for a deposit link in its own transaction (requestDepositLink: a `pending` payment_links
// row, nothing at Square yet, so a booking never fails because Square is down); the job square.deposit-link then creates the
// quick-pay link and texts it. The calendar page can also start it at once (POST /public/links/deposit/start).
import type { Env } from '../../config/env.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { maskText } from '../../platform/logging.js'
import type { SquareLogger } from './ingest.js'
import { activateSquareLink, depositOwed, prepareSquareLink, squareProcessor, squareWritesOn, type SquareLinkDeps } from './links.js'
import { squareEnv, squareMessenger } from './runtime.js'

/** booking.guest_fee.collect as a booking answer tells it: `card_hold` (wave Q3a) is collected at the counter until then. */
export function feeHow(collect: 'counter' | 'link' | 'card_hold'): 'counter' | 'link' {
  return collect === 'link' ? 'link' : 'counter'
}

/**
 * Called by an online booking path in its transaction, after the appointment (and its invoice) exist: records the deposit request
 * when the fee is due, collected by link, with Square as the processor. A no-op otherwise (today's behaviour: staff text a link).
 */
export async function requestDepositLink(
  tx: Tx,
  d: { newId: NewId; clock: Clock; env?: Pick<Env, 'PAYMENT_PROCESSOR'> },
  i: { locationId: string; appointmentId: string; cents: number; collect: 'counter' | 'link' | 'card_hold' },
): Promise<string | null> {
  const env = d.env ?? squareEnv()
  if (i.cents <= 0 || i.collect !== 'link' || !squareProcessor(env)) return null
  const inv = await tx
    .selectFrom('invoices')
    .select(['id'])
    .where('appointment_id', '=', i.appointmentId)
    .where('location_id', '=', i.locationId)
    .executeTakeFirst()
  if (!inv) return null
  const id = d.newId()
  await tx
    .insertInto('payment_links')
    .values({
      id,
      location_id: i.locationId,
      invoice_id: inv.id,
      kind: 'square_quick_pay',
      purpose: 'deposit',
      url: null,
      expected_cents: i.cents,
      state: 'pending',
      provider: 'square',
      origin: 'booking',
      created_at: d.clock.now(),
    })
    .execute()
  return id
}

export interface DepositRunReport {
  status: 'ok' | 'skipped'
  reason?: string
  created: number
  texted: number
  dropped: number
  failed: number
}

/** square.deposit-link: every pending deposit request becomes a quick-pay link, texted to the client. Idempotent (keys, states). */
export async function runDepositLinks(d: SquareLinkDeps & { locationId: string; logger: SquareLogger }): Promise<DepositRunReport> {
  const r: DepositRunReport = { status: 'ok', created: 0, texted: 0, dropped: 0, failed: 0 }
  if (!squareProcessor(d.env)) return { ...r, status: 'skipped', reason: 'PAYMENT_PROCESSOR is not square' }
  if (!squareWritesOn(d.env)) return { ...r, status: 'skipped', reason: 'SQUARE_WRITES_ENABLED=false (observe-only)' }
  const rows = await d.db
    .selectFrom('payment_links')
    .select(['id', 'invoice_id', 'expected_cents'])
    .where('location_id', '=', d.locationId)
    .where('provider', '=', 'square')
    .where('origin', '=', 'booking')
    .where('state', '=', 'pending')
    .orderBy('created_at')
    .limit(25)
    .execute()
  for (const row of rows) {
    try {
      const owed = await depositOwed(d.db, row.invoice_id, row.expected_cents)
      const inv = await d.db.selectFrom('invoices').select(['canceled_at']).where('id', '=', row.invoice_id).executeTakeFirstOrThrow()
      if (owed === 0 || inv.canceled_at) {
        await d.db
          .updateTable('payment_links')
          .set({ state: 'canceled', canceled_at: d.clock.now(), cancel_reason: inv.canceled_at ? 'invoice_canceled' : 'deposit_paid' })
          .where('id', '=', row.id)
          .where('state', '=', 'pending')
          .execute()
        r.dropped++
        continue
      }
      const prepared = await prepareSquareLink(d, { locationId: d.locationId, invoiceId: row.invoice_id, purpose: 'deposit', amountCents: row.expected_cents, origin: 'booking', rowId: row.id })
      r.created++
      const sent = await transaction(d.db, async (tx) => {
        const link = await activateSquareLink(tx, { locationId: d.locationId, clock: d.clock }, prepared)
        const inv2 = await tx.selectFrom('invoices').select(['invoice_no', 'customer_id']).where('id', '=', row.invoice_id).executeTakeFirstOrThrow()
        try {
          const s = await squareMessenger(d.db).sendPaymentLink(tx, {
            invoiceId: row.invoice_id,
            invoiceNo: inv2.invoice_no,
            customerId: inv2.customer_id,
            url: link.url,
            dedupeKey: `payment_link:${link.id}`,
          })
          await tx
            .updateTable('payment_links')
            .set({ sent_message_id: s.messageId, sent_at: s.state === 'queued' ? d.clock.now() : null })
            .where('id', '=', link.id)
            .execute()
          return s.state === 'queued'
        } catch (e) {
          // the link stands (the calendar page can open it); the text is what failed
          d.logger.warn({ square: { paymentLink: link.id }, err: maskText(String(e)).slice(0, 200) }, 'deposit link not texted')
          return false
        }
      })
      if (sent) r.texted++
    } catch (e) {
      r.failed++
      if (e instanceof AppError && (e.code === 'PAY_NOTHING_TO_COLLECT' || e.code === 'INVOICE_CANCELED')) continue
      d.logger.warn({ square: { paymentLink: row.id }, err: maskText(String(e)).slice(0, 200) }, 'deposit link not created yet (next run tries again)')
    }
  }
  return r
}
