import { DateTime } from 'luxon'
import { sql } from 'kysely'
import type { Executor } from '../../../platform/db.js'
import { encodeReceiptItems, formatCents, type ReceiptItem } from '../../../integrations/email/templates.js'
import type { EmailVars } from './service.js'
import '../schema.js'

const invoiceLabel = (no: number): string => `INV-${String(no).padStart(5, '0')}`

/** Variables of the `receipt` email template for an invoice, read from the invoice and its ledger calc (no fabricated lines). */
export async function receiptEmailVars(db: Executor, invoiceId: string): Promise<EmailVars | null> {
  const inv = await db
    .selectFrom('invoices')
    .select(['invoice_no', 'client_name', 'vehicle_label', 'biz_date'])
    .where('id', '=', invoiceId)
    .executeTakeFirst()
  if (!inv) return null
  const items = await db.selectFrom('invoice_items').select(['name', 'price_cents']).where('invoice_id', '=', invoiceId).orderBy('position').execute()
  const calc = (
    await sql<{ adj: number; sub: number; tax: number; tip: number; total: number; paid: number; refunded: number; balance: number }>`
      select adj, sub, tax, tip, total, paid, refunded, balance from invoice_calc_of(${invoiceId})`.execute(db)
  ).rows[0]
  if (!calc) return null
  const lines: ReceiptItem[] = items.map((i) => ({ description: i.name, cents: i.price_cents }))
  if (calc.adj !== 0) lines.push({ description: 'Adjustments', cents: Number(calc.adj) })
  const net = Number(calc.paid) - Number(calc.refunded)
  const vars: EmailVars = {
    customerName: inv.client_name,
    invoiceNumber: invoiceLabel(inv.invoice_no),
    dateLabel: DateTime.fromISO(inv.biz_date, { zone: 'utc' }).toFormat('LLL d, yyyy'),
    items: encodeReceiptItems(lines),
    subtotalCents: Number(calc.sub),
    taxCents: Number(calc.tax),
    totalCents: Number(calc.total),
    paidCents: net,
    balanceCents: Number(calc.balance),
  }
  if (inv.vehicle_label) vars.vehicle = inv.vehicle_label
  if (Number(calc.tip) > 0) vars.tipCents = Number(calc.tip)
  if (Number(calc.refunded) > 0) vars.paymentSummary = `${formatCents(Number(calc.refunded))} refunded`
  return vars
}
