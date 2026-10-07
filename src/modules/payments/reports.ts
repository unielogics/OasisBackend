// Payments read models: the summary (KPIs, chart, by-method, filter counts, pending approvals), the invoice list, the
// approvals queue, reconciliation and the CSV export. Everything is computed in integer cents from invoice_calc_of(); a range
// selects invoices by biz_date (the service day), exactly as the design filters by invoice date.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { divHalfUp, formatDecimal } from '../../platform/money.js'
import { decodeCursor, encodeCursor, type Page } from '../../platform/pagination.js'
import { csvLine, csvCell, CSV_BOM, type CsvKind } from '../../platform/csv.js'
import { addDays, atLabel, clockLabel, minutesOfDay, toBizDate } from '../../platform/time.js'
import type { PayActor } from './actor.js'
import { PAYMENT_PENDING_LABEL, REFUND_PENDING_LABEL, statusLabel } from './calc.js'
import { approvalRights, type ApprovalRules } from './detail.js'
import { invoiceLabel, pendingBannerText } from './format.js'
import type { UnmatchedOrder, UnmatchedSource, UnmatchedTransaction } from './ports.js'
import {
  dayBucketLabel,
  dayBucketTitle,
  dayLabel,
  eachDay,
  hourBucketLabel,
  resolveRange,
  type RangeKey,
  type ResolvedRange,
} from './ranges.js'
import type { InvoiceCalcRow, InvoiceStatus } from './schema.js'
import './problems.js'

export const FILTER_KEYS = ['all', 'unpaid', 'refunds', 'adjusted', 'credits'] as const
export type FilterKey = (typeof FILTER_KEYS)[number]

export const AWAITING_ALERT_MINUTES = 120
export const CSV_MAX_ROWS = 20_000

export interface ReportContext {
  locationId: string
  now: Date
  tz: string
}

interface RangeRow extends InvoiceCalcRow {
  invoice_no: number
  biz_date: string
  occurred_at: Date
  customer_id: string
  client_name: string
  vehicle_label: string
  staff_label: string
  tax_bp: number
  first_item: string | null
  item_count: number
  item_names: string | null
  /** Only the list query selects it. */
  awaiting?: 'payment' | 'refund' | null
}

async function rangeRows(db: Executor, locationId: string, from: string, to: string): Promise<RangeRow[]> {
  const r = await sql<RangeRow>`
    select c.*, i.invoice_no, i.biz_date, i.occurred_at, i.customer_id, i.client_name, i.vehicle_label, i.staff_label, i.tax_bp,
           (select it.name from invoice_items it where it.invoice_id = i.id order by it.position limit 1) as first_item,
           (select count(*)::int from invoice_items it where it.invoice_id = i.id) as item_count,
           (select string_agg(it.name, '; ' order by it.position) from invoice_items it where it.invoice_id = i.id) as item_names
    from invoices i cross join lateral invoice_calc_of(i.id) c
    where i.location_id = ${locationId} and i.biz_date between ${from}::date and ${to}::date`.execute(db)
  return r.rows
}

const matches: Record<FilterKey, (r: RangeRow) => boolean> = {
  all: () => true,
  unpaid: (r) => r.balance > 0,
  refunds: (r) => r.refunded > 0 || r.pending_n > 0,
  adjusted: (r) => r.adj !== 0,
  credits: (r) => r.issued > 0 || r.credit_applied > 0,
}

// --- summary ----------------------------------------------------------------------------------------------------------

export interface ChartBucket {
  key: string | number
  label: string
  title: string
  netCents: number
  lossCents: number
}

export interface PendingApproval {
  eventId: string
  invoiceId: string
  invoiceNo: number
  label: string
  client: string
  amountCents: number
  dest: string | null
  method: string | null
  reason: string | null
  note: string | null
  requestedBy: string | null
  requestedByRole: string | null
  requestedAt: string
  atLabel: string
  bizDate: string
}

export interface Summary {
  range: ResolvedRange
  kpis: {
    grossSales: number
    netRevenue: number
    refunds: number
    adjustments: number
    creditsIssued: number
    outstanding: number
    counts: {
      invoices: number
      refunded: number
      adjusted: number
      creditInvoices: number
      creditClients: number
      openBalances: number
    }
  }
  chart: { granularity: 'hour' | 'day'; buckets: ChartBucket[]; maxCents: number }
  byMethod: { card: number; applePay: number; cash: number; storeCredit: number; other: number }
  filterCounts: Record<FilterKey, number>
  /** Global (not range-filtered): refunds waiting for approval. */
  pendingApprovals: { count: number; text: string; first: PendingApproval | null; all: PendingApproval[] }
  /** Global: card money recorded in Oasis that Squarespace has not confirmed yet. Counts in every KPI above. */
  awaitingProcessor: { count: number; cents: number }
}

export async function pendingApprovals(
  db: Executor,
  locationId: string,
  c: { now: Date; tz: string },
): Promise<PendingApproval[]> {
  const r = await sql<{
    id: string
    invoice_id: string
    invoice_no: number
    client_name: string
    amount_cents: number
    dest: string | null
    method: string | null
    reason: string | null
    note: string | null
    actor_name: string | null
    actor_roles: string | null
    occurred_at: Date
    biz_date: string
  }>`
    select e.id, e.invoice_id, i.invoice_no, i.client_name, e.amount_cents, e.dest, e.method, e.reason, e.note,
           e.actor_name, e.actor_roles, e.occurred_at, i.biz_date
    from ledger_events e join invoices i on i.id = e.invoice_id
    where e.location_id = ${locationId} and e.type = 'refund' and e.status = 'pending'
    order by e.occurred_at, e.seq`.execute(db)
  return r.rows.map((x) => ({
    eventId: x.id,
    invoiceId: x.invoice_id,
    invoiceNo: x.invoice_no,
    label: invoiceLabel(x.invoice_no),
    client: x.client_name,
    amountCents: x.amount_cents,
    dest: x.dest,
    method: x.method,
    reason: x.reason,
    note: x.note,
    requestedBy: x.actor_name,
    requestedByRole: x.actor_roles,
    requestedAt: x.occurred_at.toISOString(),
    atLabel: atLabel(x.occurred_at, c.now, c.tz),
    bizDate: x.biz_date,
  }))
}

export async function summary(db: Executor, c: ReportContext, key: RangeKey): Promise<Summary> {
  const range = resolveRange(key, c.now, c.tz)
  const rows = await rangeRows(db, c.locationId, range.from, range.to)
  const sum = (f: (r: RangeRow) => number): number => rows.reduce((a, r) => a + f(r), 0)
  const gross = sum((r) => r.items)
  const adj = sum((r) => r.adj)
  const refunds = sum((r) => r.refunded)
  // net: refunds are tax-inclusive; the tax part is removed once per tax rate on the aggregate (one rate in practice)
  const byRate = new Map<number, number>()
  for (const r of rows) byRate.set(r.tax_bp, (byRate.get(r.tax_bp) ?? 0) + r.refunded)
  let refundNet = 0
  for (const [bp, amt] of byRate) refundNet += divHalfUp(amt * 10_000, 10_000 + bp)
  const credited = rows.filter((r) => r.issued > 0)

  // chart: hourly 8a-5p for today (extended when data falls outside, never dropped), one bucket per day otherwise
  const hourOf = (d: Date): number => Math.floor(minutesOfDay(d, c.tz) / 60)
  const buckets: ChartBucket[] = []
  if (key === 'today') {
    const hours = rows.map((r) => hourOf(r.occurred_at))
    const lo = Math.min(8, ...hours)
    const hi = Math.max(17, ...hours)
    for (let h = lo; h <= hi; h++) {
      const L = rows.filter((r) => hourOf(r.occurred_at) === h)
      buckets.push({ key: h, label: hourBucketLabel(h), title: hourBucketLabel(h), ...bucketSums(L) })
    }
  } else {
    const days = eachDay(range.from, range.to)
    const span = days.length - 1
    for (const d of days) {
      const L = rows.filter((r) => r.biz_date === d)
      buckets.push({ key: d, label: dayBucketLabel(d, span), title: dayBucketTitle(d), ...bucketSums(L) })
    }
  }
  const maxCents = Math.max(1, ...buckets.map((b) => b.netCents + b.lossCents))

  const m = await sql<{ k: string; v: number }>`
    select coalesce(e.method_kind, 'other') as k,
           sum(case when e.type = 'void' then -e.amount_cents else e.amount_cents end)::bigint as v
    from ledger_events e join invoices i on i.id = e.invoice_id
    where i.location_id = ${c.locationId} and i.biz_date between ${range.from}::date and ${range.to}::date
      and e.type in ('pay', 'void', 'credit_apply')
    group by 1`.execute(db)
  const mv = (k: string): number => m.rows.find((x) => x.k === k)?.v ?? 0

  const pend = await pendingApprovals(db, c.locationId, c)
  const aw = await sql<{ n: number; cents: number }>`
    select count(*)::int as n, coalesce(sum(amount_cents), 0)::bigint as cents from ledger_events
    where location_id = ${c.locationId} and processor_state = 'awaiting_processor'`.execute(db)

  return {
    range,
    kpis: {
      grossSales: gross,
      netRevenue: gross + adj - refundNet,
      refunds,
      adjustments: adj,
      creditsIssued: sum((r) => r.issued),
      outstanding: sum((r) => r.balance),
      counts: {
        invoices: rows.length,
        refunded: rows.filter((r) => r.refunded > 0).length,
        adjusted: rows.filter((r) => r.adj !== 0).length,
        creditInvoices: credited.length,
        creditClients: new Set(credited.map((r) => r.customer_id)).size,
        openBalances: rows.filter((r) => r.balance > 0).length,
      },
    },
    chart: { granularity: key === 'today' ? 'hour' : 'day', buckets, maxCents },
    byMethod: {
      card: mv('card'),
      applePay: mv('apple_pay'),
      cash: mv('cash'),
      storeCredit: mv('store_credit'),
      other: mv('other'),
    },
    filterCounts: {
      all: rows.length,
      unpaid: rows.filter(matches.unpaid).length,
      refunds: rows.filter(matches.refunds).length,
      adjusted: rows.filter(matches.adjusted).length,
      credits: rows.filter(matches.credits).length,
    },
    pendingApprovals: {
      count: pend.length,
      text: pend[0]
        ? pendingBannerText(
            pend.length,
            pend[0].amountCents,
            pend[0].client,
            pend[0].requestedBy ?? 'Unknown',
          )
        : '',
      first: pend[0] ?? null,
      all: pend,
    },
    awaitingProcessor: { count: aw.rows[0]?.n ?? 0, cents: aw.rows[0]?.cents ?? 0 },
  }
}

function bucketSums(rows: RangeRow[]): { netCents: number; lossCents: number } {
  return {
    netCents: rows.reduce((a, r) => a + r.net, 0),
    lossCents: rows.reduce((a, r) => a + r.refunded + Math.max(0, -r.adj), 0),
  }
}

// --- list -------------------------------------------------------------------------------------------------------------

export interface InvoiceListRow {
  id: string
  invoiceNo: number
  label: string
  bizDate: string
  /** "Today" / "Yesterday" / "Jun 11". */
  date: string
  /** "10:31 AM". */
  time: string
  client: string
  vehicle: string
  staff: string
  items: { first: string; more: number }
  totalCents: number
  paidCents: number
  balanceCents: number
  status: InvoiceStatus
  statusLabel: string
  refundPending: boolean
  /** Card money recorded by staff and not yet confirmed in Squarespace: a refund wins over a payment. */
  awaiting: 'payment' | 'refund' | null
  adjusted: boolean
}

export interface ListQuery {
  range: RangeKey
  filter: FilterKey
  q?: string
  limit: number
  cursor?: string
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`)

const FILTER_SQL: Record<FilterKey, ReturnType<typeof sql>> = {
  all: sql`true`,
  unpaid: sql`t.balance > 0`,
  refunds: sql`(t.refunded > 0 or t.pending_n > 0)`,
  adjusted: sql`t.adj <> 0`,
  credits: sql`(t.issued > 0 or t.credit_applied > 0)`,
}

function listSql(
  c: ReportContext,
  range: ResolvedRange,
  q: ListQuery,
  extra: ReturnType<typeof sql>,
  limit: number,
) {
  const needle = q.q?.trim().toLowerCase()
  const search = needle
    ? sql`and lower(concat_ws(' ', 'INV-' || lpad(t.invoice_no::text, 5, '0'), t.client_name, t.vehicle_label,
          (select string_agg(it.name, ' ' order by it.position) from invoice_items it where it.invoice_id = t.id))) like ${`%${escapeLike(needle)}%`}`
    : sql``
  return sql<RangeRow & { id: string }>`
    select * from (
      select c.*, i.id, i.invoice_no, i.biz_date, i.occurred_at, i.customer_id, i.client_name, i.vehicle_label, i.staff_label, i.tax_bp,
             (select it.name from invoice_items it where it.invoice_id = i.id order by it.position limit 1) as first_item,
             (select count(*)::int from invoice_items it where it.invoice_id = i.id) as item_count,
             (select string_agg(it.name, '; ' order by it.position) from invoice_items it where it.invoice_id = i.id) as item_names,
             (select case when bool_or(e.type = 'refund') then 'refund' when count(*) > 0 then 'payment' end
                from ledger_events e where e.invoice_id = i.id and e.processor_state = 'awaiting_processor') as awaiting
      from invoices i cross join lateral invoice_calc_of(i.id) c
      where i.location_id = ${c.locationId} and i.biz_date between ${range.from}::date and ${range.to}::date
    ) t
    where ${FILTER_SQL[q.filter]} ${search} ${extra}
    order by t.biz_date desc, t.invoice_no desc
    limit ${limit}`
}

function toListRow(r: RangeRow & { id: string }, today: string, tz: string): InvoiceListRow {
  const refundPending = r.pending_n > 0
  return {
    id: r.id,
    invoiceNo: r.invoice_no,
    label: invoiceLabel(r.invoice_no),
    bizDate: r.biz_date,
    date: dayLabel(r.biz_date, today),
    time: clockLabel(r.occurred_at, tz),
    client: r.client_name,
    vehicle: r.vehicle_label,
    staff: r.staff_label,
    items: { first: r.first_item ?? '', more: Math.max(0, r.item_count - 1) },
    totalCents: r.total,
    paidCents: r.paid,
    balanceCents: r.balance,
    status: r.status,
    statusLabel: statusLabel(r.status, refundPending),
    refundPending,
    awaiting: r.awaiting ?? null,
    adjusted: r.adj !== 0,
  }
}

export async function invoiceList(
  db: Executor,
  c: ReportContext,
  q: ListQuery,
): Promise<Page<InvoiceListRow>> {
  const range = resolveRange(q.range, c.now, c.tz)
  let extra = sql``
  if (q.cursor) {
    const [bizDate, no] = decodeCursor(q.cursor, 2)
    if (typeof bizDate !== 'string' || typeof no !== 'number') throw new AppError('INVALID_CURSOR')
    extra = sql`and (t.biz_date, t.invoice_no) < (${bizDate}::date, ${no}::int)`
  }
  const r = await listSql(c, range, q, extra, q.limit + 1).execute(db)
  const today = toBizDate(c.now, c.tz)
  const rows = r.rows.map((x) => toListRow(x, today, c.tz))
  if (rows.length <= q.limit) return { items: rows, nextCursor: null }
  const items = rows.slice(0, q.limit)
  const last = items[items.length - 1]!
  return { items, nextCursor: encodeCursor([last.bizDate, last.invoiceNo]) }
}

// --- CSV --------------------------------------------------------------------------------------------------------------

const CSV_COLUMNS: Array<{
  header: string
  kind: CsvKind
  value: (r: RangeRow & { id: string }, c: ReportContext) => string | number
}> = [
  { header: 'Invoice', kind: 'text', value: (r) => invoiceLabel(r.invoice_no) },
  { header: 'Date', kind: 'text', value: (r) => r.biz_date },
  { header: 'Time', kind: 'text', value: (r, c) => clock24(r.occurred_at, c.tz) },
  { header: 'Client', kind: 'text', value: (r) => r.client_name },
  { header: 'Vehicle', kind: 'text', value: (r) => r.vehicle_label },
  { header: 'Staff', kind: 'text', value: (r) => r.staff_label },
  { header: 'Items', kind: 'text', value: (r) => r.item_names ?? '' },
  { header: 'Tip', kind: 'number', value: (r) => formatDecimal(r.tip) },
  { header: 'Adjustments', kind: 'number', value: (r) => formatDecimal(r.adj) },
  { header: 'Subtotal', kind: 'number', value: (r) => formatDecimal(r.sub) },
  { header: 'Tax', kind: 'number', value: (r) => formatDecimal(r.tax) },
  { header: 'Total', kind: 'number', value: (r) => formatDecimal(r.total) },
  { header: 'Paid', kind: 'number', value: (r) => formatDecimal(r.paid) },
  { header: 'Credit applied', kind: 'number', value: (r) => formatDecimal(r.credit_applied) },
  { header: 'Refunded', kind: 'number', value: (r) => formatDecimal(r.refunded) },
  { header: 'Refund pending', kind: 'number', value: (r) => formatDecimal(r.pending_amt) },
  { header: 'Balance', kind: 'number', value: (r) => formatDecimal(r.balance) },
  { header: 'Credits issued', kind: 'number', value: (r) => formatDecimal(r.issued) },
  { header: 'Net revenue', kind: 'number', value: (r) => formatDecimal(r.net) },
  // the table's pill: card money waiting on Squarespace reads "Payment pending" / "Refund pending" (DV-212), not "Paid"
  {
    header: 'Status',
    kind: 'text',
    value: (r) =>
      r.pending_n > 0 || r.awaiting === 'refund'
        ? REFUND_PENDING_LABEL
        : r.awaiting === 'payment'
          ? PAYMENT_PENDING_LABEL
          : statusLabel(r.status, false),
  },
]

function clock24(d: Date, tz: string): string {
  const mins = minutesOfDay(d, tz)
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}

export interface CsvExport {
  filename: string
  body: string
  rows: number
}

/** One row per invoice in the range, narrowed by the filter and the search box (a flagged improvement on the design). */
export async function invoicesCsv(
  db: Executor,
  c: ReportContext,
  q: Omit<ListQuery, 'limit' | 'cursor'>,
): Promise<CsvExport> {
  const range = resolveRange(q.range, c.now, c.tz)
  const r = await listSql(c, range, { ...q, limit: CSV_MAX_ROWS + 1 }, sql``, CSV_MAX_ROWS + 1).execute(db)
  if (r.rows.length > CSV_MAX_ROWS) throw new AppError('EXPORT_TOO_LARGE', { params: { max: CSV_MAX_ROWS } })
  let body = CSV_BOM + csvLine(CSV_COLUMNS.map((col) => csvCell(col.header, 'text')))
  for (const row of r.rows) body += csvLine(CSV_COLUMNS.map((col) => csvCell(col.value(row, c), col.kind)))
  return { filename: `oasis-invoices_${range.from}_${range.to}.csv`, body, rows: r.rows.length }
}

// --- approvals --------------------------------------------------------------------------------------------------------

export interface ApprovalRow extends PendingApproval {
  canApprove: boolean
  approveBlock: 'permission' | 'limit' | 'self' | null
}

export async function approvalsQueue(
  db: Executor,
  c: ReportContext,
  actor: PayActor,
  rules: ApprovalRules,
): Promise<ApprovalRow[]> {
  const pend = await pendingApprovals(db, c.locationId, c)
  const actorIds = await sql<{ id: string; actor_user_id: string | null }>`
    select id, actor_user_id from ledger_events where location_id = ${c.locationId} and type = 'refund' and status = 'pending'`.execute(
    db,
  )
  const byId = new Map(actorIds.rows.map((x) => [x.id, x.actor_user_id]))
  return pend.map((p) => {
    const rights = approvalRights(
      actor,
      {
        type: 'refund',
        status: 'pending',
        amount_cents: p.amountCents,
        actor_user_id: byId.get(p.eventId) ?? null,
      },
      rules,
    )
    return { ...p, canApprove: rights.canApprove, approveBlock: rights.block }
  })
}

// --- reconciliation ---------------------------------------------------------------------------------------------------

export interface ReconciliationReport {
  thresholdMinutes: number
  awaitingProcessor: Array<{
    eventId: string
    invoiceId: string
    label: string
    client: string
    type: 'pay' | 'refund'
    amountCents: number
    method: string | null
    occurredAt: string
    ageMinutes: number
  }>
  unmatchedOrders: Array<Omit<UnmatchedOrder, 'createdAt'> & { createdAt: string }>
  unmatchedTransactions: Array<Omit<UnmatchedTransaction, 'createdAt'> & { createdAt: string }>
  overpaid: Array<{
    invoiceId: string
    label: string
    client: string
    overpaidCents: number
    bizDate: string
  }>
}

export async function reconciliation(
  db: Executor,
  c: ReportContext,
  unmatched: UnmatchedSource,
): Promise<ReconciliationReport> {
  const cutoff = new Date(c.now.getTime() - AWAITING_ALERT_MINUTES * 60_000)
  const aw = await sql<{
    id: string
    invoice_id: string
    invoice_no: number
    client_name: string
    type: 'pay' | 'refund'
    amount_cents: number
    method: string | null
    occurred_at: Date
  }>`
    select e.id, e.invoice_id, i.invoice_no, i.client_name, e.type, e.amount_cents, e.method, e.occurred_at
    from ledger_events e join invoices i on i.id = e.invoice_id
    where e.location_id = ${c.locationId} and e.processor_state = 'awaiting_processor' and e.occurred_at <= ${cutoff}
    order by e.occurred_at, e.seq`.execute(db)
  const since = addDays(toBizDate(c.now, c.tz), -90)
  const over = await sql<{
    id: string
    invoice_no: number
    client_name: string
    overpaid: number
    biz_date: string
  }>`
    select i.id, i.invoice_no, i.client_name, c.overpaid, i.biz_date
    from invoices i cross join lateral invoice_calc_of(i.id) c
    where i.location_id = ${c.locationId} and i.biz_date >= ${since}::date and c.overpaid > 0
    order by i.biz_date desc, i.invoice_no desc`.execute(db)
  return {
    thresholdMinutes: AWAITING_ALERT_MINUTES,
    awaitingProcessor: aw.rows.map((x) => ({
      eventId: x.id,
      invoiceId: x.invoice_id,
      label: invoiceLabel(x.invoice_no),
      client: x.client_name,
      type: x.type,
      amountCents: x.amount_cents,
      method: x.method,
      occurredAt: x.occurred_at.toISOString(),
      ageMinutes: Math.floor((c.now.getTime() - x.occurred_at.getTime()) / 60_000),
    })),
    unmatchedOrders: (await unmatched.unmatchedOrders(db)).map((o) => ({
      ...o,
      createdAt: o.createdAt.toISOString(),
    })),
    unmatchedTransactions: (await unmatched.unmatchedTransactions(db)).map((t) => ({
      ...t,
      createdAt: t.createdAt.toISOString(),
    })),
    overpaid: over.rows.map((x) => ({
      invoiceId: x.id,
      label: invoiceLabel(x.invoice_no),
      client: x.client_name,
      overpaidCents: x.overpaid,
      bizDate: x.biz_date,
    })),
  }
}
