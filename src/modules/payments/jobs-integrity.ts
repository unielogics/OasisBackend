// ledger.integrity_check: a nightly proof that the money tables still mean what the code thinks they mean (ADR 0123).
//
//   1. calc: every invoice's `invoice_calc_of` (the SQL the screens and reports read) equals `calcInvoice` (the TypeScript twin)
//      recomputed from its raw lines and ledger events, field by field;
//   2. guard: the append-only triggers on ledger_events and credit_allocations exist in this schema and are enabled;
//   3. FIFO: every credit_apply is covered by allocations that sum to it, and no store-credit lot is allocated beyond its amount.
//
// The result is recorded per location and business date in ledger_integrity_runs. A problem notifies the managers; a re-run the
// same day that finds the same thing changes nothing and notifies no one again. Nothing in the ledger is written.
import { sql } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Executor } from '../../platform/db.js'
import { createIdGenerator, type NewId } from '../../platform/ids.js'
import type { JobDefinition } from '../../platform/jobs.js'
import { toBizDate } from '../../platform/time.js'
import { notifyManagers } from '../messaging/notify.js'
import { calcInvoice, type CalcEvent, type InvoiceCalc } from './calc.js'
import { invoiceLabel } from './format.js'
import { calcFromRow } from './repository.js'
import type { InvoiceCalcRow, LedgerType, RefundDest, RefundStatus } from './schema.js'

export const LEDGER_INTEGRITY_JOB = 'ledger.integrity_check'
export const LEDGER_GUARDS = [
  { table: 'ledger_events', trigger: 'ledger_events_guard' },
  { table: 'credit_allocations', trigger: 'credit_allocations_guard' },
] as const

export type FindingCode = 'calc_mismatch' | 'guard_missing' | 'allocation_mismatch' | 'lot_overdrawn'

export interface IntegrityFinding {
  code: FindingCode
  detail: string
  invoiceNo?: number
}

export interface IntegrityReport {
  invoicesChecked: number
  findings: IntegrityFinding[]
}

const CALC_FIELDS: readonly (keyof InvoiceCalc)[] = [
  'items',
  'adj',
  'sub',
  'tax',
  'tip',
  'total',
  'paidOrig',
  'creditApplied',
  'paid',
  'refunded',
  'refOrig',
  'pendingAmt',
  'pendingN',
  'issued',
  'balance',
  'refundable',
  'toOrigMax',
  'net',
  'overpaid',
  'status',
]

/** Field-by-field differences between the SQL view and the TypeScript calc of one invoice. */
export function calcDifferences(view: InvoiceCalc, recomputed: InvoiceCalc): string[] {
  const out: string[] = []
  for (const f of CALC_FIELDS) {
    const a = typeof view[f] === 'string' ? view[f] : Number(view[f])
    if (a !== recomputed[f]) out.push(`${f} ${String(a)} != ${String(recomputed[f])}`)
  }
  return out
}

async function checkGuards(db: Executor): Promise<IntegrityFinding[]> {
  const rows = await sql<{ table: string; trigger: string; enabled: string }>`
    select c.relname as table, t.tgname as trigger, t.tgenabled as enabled
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema() and not t.tgisinternal
      and c.relname in ('ledger_events', 'credit_allocations')`.execute(db)
  const out: IntegrityFinding[] = []
  for (const g of LEDGER_GUARDS) {
    const t = rows.rows.find((r) => r.table === g.table && r.trigger === g.trigger)
    if (!t)
      out.push({
        code: 'guard_missing',
        detail: `${g.table}: the append-only trigger ${g.trigger} is missing`,
      })
    else if (t.enabled === 'D')
      out.push({
        code: 'guard_missing',
        detail: `${g.table}: the append-only trigger ${g.trigger} is disabled`,
      })
  }
  return out
}

async function checkCalc(
  db: Executor,
  locationId: string,
): Promise<{ checked: number; findings: IntegrityFinding[] }> {
  const invoices = await db
    .selectFrom('invoices')
    .select(['id', 'invoice_no', 'tax_bp', 'tip_cents', 'canceled_at'])
    .where('location_id', '=', locationId)
    .execute()
  const items = await sql<{ invoice_id: string; price_cents: number }>`
    select it.invoice_id, it.price_cents from invoice_items it join invoices i on i.id = it.invoice_id
    where i.location_id = ${locationId}`.execute(db)
  const events = await sql<{
    invoice_id: string
    type: LedgerType
    amount_cents: number
    status: RefundStatus
    dest: RefundDest | null
  }>`select invoice_id, type, amount_cents, status, dest from ledger_events where location_id = ${locationId}`.execute(
    db,
  )
  const views = await sql<InvoiceCalcRow & { id: string }>`
    select i.id, c.* from invoices i cross join lateral invoice_calc_of(i.id) c where i.location_id = ${locationId}`.execute(
    db,
  )
  const itemsOf = new Map<string, number[]>()
  for (const r of items.rows)
    itemsOf.set(r.invoice_id, [...(itemsOf.get(r.invoice_id) ?? []), Number(r.price_cents)])
  const eventsOf = new Map<string, CalcEvent[]>()
  for (const e of events.rows)
    eventsOf.set(e.invoice_id, [
      ...(eventsOf.get(e.invoice_id) ?? []),
      { type: e.type, amountCents: Number(e.amount_cents), status: e.status, dest: e.dest },
    ])
  const viewOf = new Map(views.rows.map((v) => [v.id, v]))
  const findings: IntegrityFinding[] = []
  for (const inv of invoices) {
    const view = viewOf.get(inv.id)
    const recomputed = calcInvoice({
      itemPrices: itemsOf.get(inv.id) ?? [],
      events: eventsOf.get(inv.id) ?? [],
      taxBp: inv.tax_bp,
      tipCents: inv.tip_cents,
      canceled: inv.canceled_at !== null,
    })
    const diff = view ? calcDifferences(calcFromRow(view), recomputed) : ['no row from invoice_calc_of']
    if (diff.length > 0)
      findings.push({
        code: 'calc_mismatch',
        invoiceNo: inv.invoice_no,
        detail: `${invoiceLabel(inv.invoice_no)}: the invoice view and the ledger disagree (${diff.slice(0, 4).join('; ')})`,
      })
  }
  return { checked: invoices.length, findings }
}

async function checkCredit(db: Executor, locationId: string): Promise<IntegrityFinding[]> {
  const applies = await sql<{ invoice_no: number; amount: number; allocated: number }>`
    select i.invoice_no, e.amount_cents::int as amount, coalesce(sum(a.cents), 0)::int as allocated
    from ledger_events e
    join invoices i on i.id = e.invoice_id
    left join credit_allocations a on a.apply_event_id = e.id
    where e.location_id = ${locationId} and e.type = 'credit_apply'
    group by e.id, i.invoice_no, e.amount_cents
    having coalesce(sum(a.cents), 0) <> e.amount_cents`.execute(db)
  const lots = await sql<{ invoice_no: number; amount: number; allocated: number }>`
    select i.invoice_no, e.amount_cents::int as amount, sum(a.cents)::int as allocated
    from credit_allocations a
    join ledger_events e on e.id = a.lot_event_id
    join invoices i on i.id = e.invoice_id
    where e.location_id = ${locationId}
    group by e.id, i.invoice_no, e.amount_cents
    having sum(a.cents) > e.amount_cents`.execute(db)
  return [
    ...applies.rows.map((r) => ({
      code: 'allocation_mismatch' as const,
      invoiceNo: r.invoice_no,
      detail: `${invoiceLabel(r.invoice_no)}: store credit applied ${r.amount} cents but its FIFO allocations sum to ${r.allocated}`,
    })),
    ...lots.rows.map((r) => ({
      code: 'lot_overdrawn' as const,
      invoiceNo: r.invoice_no,
      detail: `${invoiceLabel(r.invoice_no)}: a store-credit lot of ${r.amount} cents is allocated ${r.allocated}`,
    })),
  ]
}

/** All three checks for one location. Read-only. */
export async function checkLedgerIntegrity(db: Executor, locationId: string): Promise<IntegrityReport> {
  const calc = await checkCalc(db, locationId)
  return {
    invoicesChecked: calc.checked,
    findings: [...(await checkGuards(db)), ...calc.findings, ...(await checkCredit(db, locationId))],
  }
}

export interface IntegrityRun extends IntegrityReport {
  locationId: string
  ok: boolean
  /** False when today's row already held this exact result (a re-run). */
  recorded: boolean
  notified: boolean
}

/** Checks every location, records today's result and tells the managers about a new problem. */
export async function runLedgerIntegrity(
  db: Db,
  clock: Clock,
  o: { jobId?: string; newId?: NewId } = {},
): Promise<IntegrityRun[]> {
  const newId = o.newId ?? createIdGenerator(clock)
  const out: IntegrityRun[] = []
  for (const loc of await db
    .selectFrom('locations')
    .select(['id', 'timezone'])
    .orderBy('created_at')
    .execute()) {
    const startedAt = clock.now()
    const report = await checkLedgerIntegrity(db, loc.id)
    const ok = report.findings.length === 0
    const run = await transaction(db, async (tx) => {
      const checkDate = toBizDate(startedAt, loc.timezone)
      const findings = JSON.stringify(report.findings)
      const prior = await tx
        .selectFrom('ledger_integrity_runs')
        .select(['ok', sql<boolean>`findings = ${findings}::jsonb`.as('same')])
        .where('location_id', '=', loc.id)
        .where('check_date', '=', checkDate)
        .forUpdate()
        .executeTakeFirst()
      const r = await sql<{ id: string }>`
        insert into ledger_integrity_runs (id, location_id, check_date, started_at, finished_at, ok, invoices_checked, findings, job_id)
        values (${newId()}, ${loc.id}, ${checkDate}, ${startedAt}, ${clock.now()}, ${ok},
          ${report.invoicesChecked}, ${findings}::jsonb, ${o.jobId ?? null})
        on conflict (location_id, check_date) do update set
          started_at = excluded.started_at, finished_at = excluded.finished_at, ok = excluded.ok,
          invoices_checked = excluded.invoices_checked, findings = excluded.findings, job_id = excluded.job_id
        where ledger_integrity_runs.ok is distinct from excluded.ok
          or ledger_integrity_runs.findings is distinct from excluded.findings
          or ledger_integrity_runs.invoices_checked is distinct from excluded.invoices_checked
        returning id`.execute(tx)
      const recorded = r.rows.length > 0
      // only a new set of problems is announced (a changed invoice count alone is just recorded)
      const sameProblems = prior !== undefined && !prior.ok && prior.same
      const notified = !ok && !sameProblems
      if (notified) {
        const first = report.findings[0]!
        await notifyManagers(
          tx,
          {
            locationId: loc.id,
            kind: 'ledger.integrity_failed',
            title: 'Ledger check found a problem',
            body: `${report.findings.length} problem${report.findings.length === 1 ? '' : 's'} in the nightly ledger check. ${first.detail}.`,
            entityType: null,
            entityId: null,
          },
          { newId, clock },
        )
      }
      return { recorded, notified }
    })
    out.push({ locationId: loc.id, ok, ...report, ...run })
  }
  return out
}

export const ledgerIntegrityJob: JobDefinition = {
  name: LEDGER_INTEGRITY_JOB,
  // 03:45 business time: after membership.cycle (03:00) and sqsp.reconcile (03:30), outside the hours a DST change touches
  cron: '45 3 * * *',
  policy: 'stately',
  retryLimit: 1,
  retryDelaySeconds: 300,
  expireInSeconds: 30 * 60,
  async handler(ctx, _data, job) {
    for (const r of await runLedgerIntegrity(ctx.db, ctx.clock, { jobId: job.id })) {
      if (r.ok) ctx.logger.info({ invoices: r.invoicesChecked }, 'ledger integrity check passed')
      else
        ctx.logger.error(
          { invoices: r.invoicesChecked, findings: r.findings },
          'ledger integrity check found problems',
        )
    }
  },
}
