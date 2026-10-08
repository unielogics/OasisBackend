// Seed profile "demo": the Operations design's day re-anchored on TODAY (America/New_York) with the real clock, for a live link
// that someone opens at any time of day. Where `parity-ops` freezes the board at 10:36 AM on 2026-06-13, `demo` asks "what
// would the design's day look like right now":
//
//   - The twelve design appointments a1..a12 at their design times today (a12 tomorrow). Each has a hand-written plan of its
//     day (DEMO_PLAN: when the car arrives, goes into its bay, is finished and collected, and how it pays) that reproduces the
//     design's board exactly at 10:36 AM and never puts two cars in one bay. The status, checklist progress, photos, activity,
//     texts and payments are whatever of that plan has happened by the time the seed runs: at 7 AM everything is still booked
//     or confirmed, at noon the morning jobs are done and paid, after 6 PM the whole day is finished.
//   - One invoice per appointment, numbered like the Payments design where it names the invoice (INV-20601..20608 for Maria,
//     David, Priya, Jonathan, Sofia, Liam, Marcus and Aisha) and from the counter otherwise. Deposits were taken yesterday,
//     prepayments arrive at their design times, and a car paid at the counter is paid when it is finished. The most recent
//     counter card payment is left awaiting Squarespace, so "Payment pending" can be seen; before any counter payment of the
//     day exists, yesterday's last card payment is the one still waiting.
//   - The Payments design's history (the explicit and generated invoices of the last 29 days, pay-domain section 6) relative to
//     today, each with the completed (or canceled) appointment it belongs to, so the calendar and Payments tell the same story.
//     Today's eight design invoices are not duplicated: they are the Operations day's invoices above.
//   - The design's procedural calendar (genDay) for days 30-60 back (completed, paid) and for tomorrow through 60 days ahead
//     (booked or confirmed, invoiced at booking like a real booking), skipping closed days and giving each job a detailer who
//     works that weekday. Past procedural invoices are numbered below the history (20505 down), future ones from the counter.
//   - Members, VIP clients and holds, closures, arrival settings and the simulator SMS device come from the profiles it
//     depends on (memberships, design, geofence).
//
// Idempotent: design appointments are keyed by customer, start and package, invoices by number and appointment, procedural
// days by date (a day that already has generated appointments is left alone). Meant for a fresh schema (`pnpm seed --
// --profile design,demo`); run again the same day it changes nothing, run on a later day it adds that day's board.
// Every phone number is synthetic (555-01xx).
import { sql } from 'kysely'
import { calcInvoice, type CalcEvent } from '../../src/modules/payments/calc.js'
import { nextInvoiceNo } from '../../src/modules/payments/gateway.js'
import { cardLabel, kindOfMethodLabel } from '../../src/modules/payments/repository.js'
import { jobTasksFor, listCatalog, type CatalogService } from '../../src/modules/catalog/service.js'
import { ensureThread, insertMessage } from '../../src/modules/messaging/db/messages.js'
import { TEMPLATES } from '../../src/modules/messaging/templates/registry.js'
import { addAddonChecklist, snapshotPackageChecklist } from '../../src/modules/scheduling/checklist.js'
import type { SchedulingCtx } from '../../src/modules/scheduling/context.js'
import { vehicleLabel } from '../../src/modules/scheduling/appointments.js'
import { listLiveClosures } from '../../src/modules/settings/closures.js'
import { dayInfo } from '../../src/modules/settings/day-info.js'
import { getHours } from '../../src/modules/settings/hours.js'
import { buildPhotoKey } from '../../src/integrations/storage/keys.js'
import { formatPhoneDisplay } from '../../src/platform/phone.js'
import { getSetting } from '../../src/platform/settings.js'
import {
  addDays,
  bizDayBounds,
  bizWeekday,
  fmtT,
  parseT,
  toBizDate,
  wallToInstant,
} from '../../src/platform/time.js'
import type { SeedContext, SeedProfile } from './index.js'
import { designInvoices, seedDesignInvoices, type DesignInvoice, type SeededInvoice } from './payments.js'
import { DESIGN_APPOINTMENTS, POOL_NAMES, designGenDay, type DesignAppointment } from './scheduling.js'

type Staff = DesignAppointment['staff']
type Status = DesignAppointment['status']

/** How a design appointment pays. Minutes are wall-clock minutes of its day. */
export type DemoPay =
  /** Paid in full at the counter when the car is finished (staff record the card; Squarespace confirms it later). */
  | { kind: 'counter'; method: string }
  /** Paid in full online (a Squarespace checkout) at this minute of the day. */
  | { kind: 'prepaid'; at: number; method: string }
  /** A deposit through the booking link yesterday; the balance is paid at the counter when the car is finished. */
  | { kind: 'deposit'; cents: number; method: string }
  /** Paid in full online yesterday (the job is tomorrow). */
  | { kind: 'advance'; method: string }
  /** Nothing yet: the balance is collected in the app (the design's unpaid jobs). */
  | { kind: 'none' }

/** One design appointment's day: minutes after midnight of its day. */
export interface DemoPlan {
  arrive: number
  start: number
  done: number
  /** When the customer drives off; null = still waiting for pickup when the day ends. */
  collect: number | null
  bay: 1 | 2
  /** Who does the job once it is in a bay (a7 is unassigned until then). */
  staff: Exclude<Staff, 'Unassigned'>
  pay: DemoPay
  tipCents?: number
  /** An adjustment made at booking (pre-tax cents, signed). */
  adjust?: { cents: number; reason: string }
  /** The Payments design's invoice number for this job, when it has one. */
  invoiceNo?: number
}

const m = (t: string): number => parseT(t)

/**
 * The design's day as a timeline. At 10:36 AM it gives exactly the design's board: a1-a3 completed (a3 waiting for pickup),
 * a4 cleaning in Bay 1 (started 10:09), a5 arrived (geofence 10:27), a6 12 minutes out, a7 confirmed and late, a8 22 minutes
 * out, a9/a10 confirmed, a11 booked, a12 tomorrow. Later jobs follow the bay that frees first, so a bay never holds two cars:
 * Bay 1 a2, a4, a6, a9, a11; Bay 2 a1, a3, a5, a8, a7, a10. The money matches the Payments design's INV-20601..20608.
 */
export const DEMO_PLAN: Readonly<Record<string, DemoPlan>> = {
  a1: {
    arrive: m('8:25 AM'),
    start: m('8:30 AM'),
    done: m('9:05 AM'),
    collect: m('9:20 AM'),
    bay: 2,
    staff: 'Lena K.',
    pay: { kind: 'counter', method: 'Visa ••4421' },
    tipCents: 800,
    invoiceNo: 20601,
  },
  a2: {
    arrive: m('9:10 AM'),
    start: m('9:15 AM'),
    done: m('10:05 AM'),
    collect: m('10:20 AM'),
    bay: 1,
    staff: 'Marco R.',
    pay: { kind: 'counter', method: 'Mastercard ••1180' },
    tipCents: 2000,
    adjust: { cents: -2500, reason: 'Loyalty' },
    invoiceNo: 20602,
  },
  a3: {
    arrive: m('9:40 AM'),
    start: m('9:45 AM'),
    done: m('10:30 AM'),
    collect: null,
    bay: 2,
    staff: 'Lena K.',
    pay: { kind: 'none' },
    invoiceNo: 20603,
  },
  a4: {
    arrive: m('10:00 AM'),
    start: m('10:09 AM'),
    done: m('11:24 AM'),
    collect: m('11:40 AM'),
    bay: 1,
    staff: 'Marco R.',
    pay: { kind: 'prepaid', at: m('9:40 AM'), method: 'Apple Pay' },
    invoiceNo: 20604,
  },
  a5: {
    arrive: m('10:27 AM'),
    start: m('10:45 AM'),
    done: m('12:15 PM'),
    collect: m('12:30 PM'),
    bay: 2,
    staff: 'Sofia D.',
    pay: { kind: 'deposit', cents: 5000, method: 'Visa ••0092' },
    invoiceNo: 20605,
  },
  a6: {
    arrive: m('10:48 AM'),
    start: m('11:30 AM'),
    done: m('12:30 PM'),
    collect: m('12:45 PM'),
    bay: 1,
    staff: 'Marco R.',
    pay: { kind: 'prepaid', at: m('9:50 AM'), method: 'Visa ••7731' },
    invoiceNo: 20606,
  },
  a7: {
    arrive: m('11:00 AM'),
    start: m('1:00 PM'),
    done: m('1:50 PM'),
    collect: m('2:05 PM'),
    bay: 2,
    staff: 'Sofia D.',
    pay: { kind: 'deposit', cents: 2000, method: 'Visa ••6610' },
    invoiceNo: 20607,
  },
  a8: {
    arrive: m('10:58 AM'),
    start: m('12:20 PM'),
    done: m('12:55 PM'),
    collect: null,
    bay: 2,
    staff: 'Sofia D.',
    pay: { kind: 'none' },
  },
  a9: {
    arrive: m('11:55 AM'),
    start: m('12:35 PM'),
    done: m('2:35 PM'),
    collect: m('2:50 PM'),
    bay: 1,
    staff: 'Marco R.',
    pay: { kind: 'prepaid', at: m('10:05 AM'), method: 'Amex ••3008' },
    invoiceNo: 20608,
  },
  a10: {
    arrive: m('1:25 PM'),
    start: m('1:55 PM'),
    done: m('2:30 PM'),
    collect: null,
    bay: 2,
    staff: 'Sofia D.',
    pay: { kind: 'none' },
  },
  a11: {
    arrive: m('2:55 PM'),
    start: m('3:05 PM'),
    done: m('5:35 PM'),
    collect: null,
    bay: 1,
    staff: 'Marco R.',
    pay: { kind: 'none' },
  },
  a12: {
    arrive: m('8:55 AM'),
    start: m('9:00 AM'),
    done: m('9:50 AM'),
    collect: m('10:05 AM'),
    bay: 2,
    staff: 'Lena K.',
    pay: { kind: 'advance', method: 'Visa ••4421' },
  },
}

/** Booked yesterday afternoon, like the design's "Yesterday 4:02 PM"; the confirmation went out ten minutes later. */
const BOOKED_AT = m('4:02 PM')
const CONFIRMED_AT = m('4:12 PM')
const DEPOSIT_AT = m('4:30 PM')
/** A counter payment is taken two minutes after the car is finished. */
const PAY_AFTER_DONE = 2
/** The design shows an ETA for a6 and a8: shown while the car is at most this far out. */
const ETA_HORIZON_MIN = 30
const ETA_JOBS = new Set(['a6', 'a8'])
const PROCEDURAL_PAST = [-60, -30] as const
const PROCEDURAL_FUTURE = [1, 60] as const
/** Past procedural invoices count down from here (the Payments history ends at INV-20506). */
const PAST_PROCEDURAL_TOP = 20505
const GEN_STAFF = ['Marco R.', 'Lena K.', 'Sofia D.'] as const
const PAST_METHODS = ['Visa ••4421', 'Mastercard ••1180', 'Apple Pay', 'Cash', 'Amex ••3008'] as const

export interface DemoState {
  status: Status
  /** Instants, or null when that step has not happened. */
  arrivedAt: Date | null
  startedAt: Date | null
  doneAt: Date | null
  collectedAt: Date | null
  /** Share of the checklist done (0..1): elapsed share of the job while cleaning, all once finished. */
  progress: number
  /** Minutes until the car arrives, for the design's ETA jobs within the horizon. */
  etaMin: number | null
}

/** Where design appointment `a` stands at `now` according to its plan. Pure. */
export function demoStateAt(a: DesignAppointment, day: string, tz: string, now: Date): DemoState {
  const p = DEMO_PLAN[a.id]!
  const at = (min: number): Date => wallToInstant(day, min, tz)
  const reached = (min: number): boolean => at(min).getTime() <= now.getTime()
  const pre: DemoState = {
    status: a.status === 'booked' ? 'booked' : 'confirmed',
    arrivedAt: null,
    startedAt: null,
    doneAt: null,
    collectedAt: null,
    progress: 0,
    etaMin: null,
  }
  if (!reached(p.arrive)) {
    const away = (at(p.arrive).getTime() - now.getTime()) / 60_000
    return ETA_JOBS.has(a.id) && away <= ETA_HORIZON_MIN
      ? { ...pre, etaMin: Math.max(1, Math.round(away)) }
      : pre
  }
  if (!reached(p.start)) return { ...pre, status: 'arrived', arrivedAt: at(p.arrive) }
  if (!reached(p.done)) {
    const span = at(p.done).getTime() - at(p.start).getTime()
    return {
      ...pre,
      status: 'cleaning',
      arrivedAt: at(p.arrive),
      startedAt: at(p.start),
      progress: (now.getTime() - at(p.start).getTime()) / span,
    }
  }
  return {
    ...pre,
    status: 'completed',
    arrivedAt: at(p.arrive),
    startedAt: at(p.start),
    doneAt: at(p.done),
    collectedAt: p.collect !== null && reached(p.collect) ? at(p.collect) : null,
    progress: 1,
  }
}

/** The money events of a design appointment that have happened by `now`, in order. */
export interface DemoMoney {
  tipCents: number
  adjust: { cents: number; reason: string; at: Date } | null
  payments: Array<{
    cents: 'total' | 'balance' | number
    method: string
    at: Date
    deposit: boolean
    counter: boolean
  }>
}

export function demoMoneyAt(a: DesignAppointment, day: string, tz: string, now: Date): DemoMoney {
  const p = DEMO_PLAN[a.id]!
  // the design books every job (a12 included) yesterday afternoon
  const yesterday = addDays(day, -a.day - 1)
  const booked = wallToInstant(yesterday, BOOKED_AT, tz)
  const happened = (d: Date): boolean => d.getTime() <= now.getTime()
  const done = wallToInstant(day, p.done + PAY_AFTER_DONE, tz)
  const out: DemoMoney = {
    tipCents: 0,
    adjust: p.adjust ? { ...p.adjust, at: booked } : null,
    payments: [],
  }
  switch (p.pay.kind) {
    case 'counter':
      if (happened(done)) {
        out.payments.push({ cents: 'total', method: p.pay.method, at: done, deposit: false, counter: true })
        out.tipCents = p.tipCents ?? 0
      }
      break
    case 'prepaid': {
      const at = wallToInstant(day, p.pay.at, tz)
      if (happened(at))
        out.payments.push({ cents: 'total', method: p.pay.method, at, deposit: false, counter: false })
      break
    }
    case 'deposit':
      out.payments.push({
        cents: p.pay.cents,
        method: p.pay.method,
        at: wallToInstant(yesterday, DEPOSIT_AT, tz),
        deposit: true,
        counter: false,
      })
      if (happened(done))
        out.payments.push({ cents: 'balance', method: p.pay.method, at: done, deposit: false, counter: true })
      break
    case 'advance':
      out.payments.push({
        cents: 'total',
        method: p.pay.method,
        at: wallToInstant(yesterday, DEPOSIT_AT, tz),
        deposit: false,
        counter: false,
      })
      break
    case 'none':
      break
  }
  return out
}

/** The design appointment whose counter card payment is the latest to have happened by `now` (it stays awaiting Squarespace). */
export function latestCounterPayment(today: string, tz: string, now: Date): string | null {
  let best: { id: string; at: number } | null = null
  for (const a of DESIGN_APPOINTMENTS) {
    const day = addDays(today, a.day)
    for (const pay of demoMoneyAt(a, day, tz, now).payments)
      if (pay.counter && kindOfMethodLabel(pay.method) === 'card' && (!best || pay.at.getTime() >= best.at))
        best = { id: a.id, at: pay.at.getTime() }
  }
  return best?.id ?? null
}

/** Yesterday's last card payment of the Payments history: the one still waiting when no counter payment happened today. */
export function historyAwaitingInvoiceNo(invoices: readonly DesignInvoice[]): number | null {
  const card = invoices
    .filter((i) => i.off === -1 && !i.canceled)
    .filter((i) => i.events.some((e) => e.type === 'pay' && kindOfMethodLabel(e.method) === 'card'))
    .filter((i) => !i.events.some((e) => e.type === 'refund'))
    .sort((x, y) => parseT(y.time) - parseT(x.time) || y.no - x.no)
  return card[0]?.no ?? null
}

// Seeding ---------------------------------------------------------------------------------------------------------------

interface Refs {
  c: SchedulingCtx
  tz: string
  today: string
  now: Date
  taxBp: number
  byName: Map<string, CatalogService>
  bays: Map<number, string>
  employees: Map<string, { id: string; label: string }>
  /** Weekdays each employee (by first name) works. */
  works: Map<string, Set<number>>
}

const firstOf = (s: Staff | string): string => s.split(' ')[0]!

export async function seedDemo(ctx: SeedContext): Promise<void> {
  const { tx, location } = ctx
  const tz = location.timezone
  const now = ctx.clock.now()
  const today = toBizDate(now, tz)
  const catalog = await listCatalog(tx, location.id)
  const refs: Refs = {
    c: { clock: ctx.clock, newId: ctx.newId, locationId: location.id, tz, ports: undefined as never },
    tz,
    today,
    now,
    taxBp: (await getSetting(tx, location.id, 'tax.rate_bp')).value,
    byName: new Map([...catalog.packages, ...catalog.addons].map((s) => [s.name, s])),
    bays: new Map(
      (
        await tx.selectFrom('bays').select(['id', 'number']).where('location_id', '=', location.id).execute()
      ).map((b) => [b.number, b.id]),
    ),
    employees: new Map(),
    works: new Map(),
  }
  for (const e of await tx.selectFrom('employees').select(['id', 'first', 'last']).execute())
    refs.employees.set(e.first, { id: e.id, label: `${e.first} ${e.last.slice(0, 1)}.` })
  for (const s of await tx
    .selectFrom('employee_schedules as s')
    .innerJoin('employees as e', 'e.id', 's.employee_id')
    .select(['e.first', 's.weekday'])
    .where('s.is_on', '=', true)
    .execute())
    refs.works.set(s.first, (refs.works.get(s.first) ?? new Set()).add(s.weekday))

  // the counter must clear the design numbers before anything takes a number from it
  await tx
    .insertInto('invoice_counters')
    .values({ location_id: location.id })
    .onConflict((oc) => oc.doNothing())
    .execute()

  const awaitingToday = latestCounterPayment(today, tz, now)
  const history = designInvoices().filter((i) => i.off < 0)
  const seededHistory = await seedDesignInvoices(ctx, history, {
    awaitingInvoiceNo: awaitingToday ? undefined : (historyAwaitingInvoiceNo(history) ?? undefined),
  })
  const made = await seedDesignDay(ctx, refs, awaitingToday)
  const linked = await linkHistoryAppointments(ctx, refs, seededHistory)
  const generated = await seedProceduralDays(ctx, refs)
  ctx.log(
    `demo: ${made} design appointments for ${today}, ${seededHistory.length} history invoices (${linked} with their appointments), ${generated} procedural appointments`,
  )
}

/** Inserts an invoice for an appointment with this number and its package and add-on lines. */
async function insertInvoice(
  ctx: SeedContext,
  r: Refs,
  o: {
    invoiceNo: number
    appointmentId: string
    customerId: string
    clientName: string
    vehicleLabel: string
    staffLabel: string
    occurredAt: Date
    frozenAt: Date | null
    tipCents: number
    items: Array<{ name: string; priceCents: number; kind: 'package' | 'addon'; addonRowId?: string }>
  },
): Promise<string> {
  const id = ctx.newId()
  await ctx.tx
    .insertInto('invoices')
    .values({
      id,
      location_id: ctx.location.id,
      invoice_no: o.invoiceNo,
      appointment_id: o.appointmentId,
      customer_id: o.customerId,
      client_name: o.clientName,
      vehicle_label: o.vehicleLabel,
      staff_label: o.staffLabel,
      occurred_at: o.occurredAt,
      biz_date: toBizDate(o.occurredAt, r.tz),
      date_frozen_at: o.frozenAt,
      tax_bp: r.taxBp,
      tip_cents: o.tipCents,
      canceled_at: null,
      canceled_by: null,
      canceled_by_name: null,
      cancel_reason: null,
      payment_link_url: null,
      payment_link_sent_at: null,
    })
    .execute()
  await ctx.tx
    .insertInto('invoice_items')
    .values(
      o.items.map((it, position) => ({
        id: ctx.newId(),
        invoice_id: id,
        position,
        kind: it.kind,
        service_id: r.byName.get(it.name)?.id ?? null,
        name: it.name,
        price_cents: it.priceCents,
        appointment_addon_id: it.addonRowId ?? null,
      })),
    )
    .execute()
  return id
}

interface LedgerRow {
  invoiceId: string
  customerId: string
  type: 'pay' | 'adjust'
  cents: number
  method?: string
  deposit?: boolean
  reason?: string
  at: Date
  actor: { name: string; roles: string | null; employeeId: string | null }
  awaiting?: boolean
}

function ledgerValues(ctx: SeedContext, e: LedgerRow): Record<string, unknown> {
  const kind = e.method ? kindOfMethodLabel(e.method) : null
  const card = /^(Visa|Mastercard|Amex)\s+••(\d{4})$/.exec(e.method ?? '')
  const brand = card ? card[1]!.toLowerCase() : null
  return {
    id: ctx.newId(),
    location_id: ctx.location.id,
    invoice_id: e.invoiceId,
    customer_id: e.customerId,
    type: e.type,
    amount_cents: e.cents,
    status: 'done',
    // a card staff took at the counter is labelled by its brand only until Squarespace confirms it
    method: e.awaiting ? cardLabel(brand).label : (e.method ?? null),
    method_kind: kind,
    brand,
    last4: e.awaiting ? null : (card?.[2] ?? null),
    dest: null,
    deposit: e.deposit ?? false,
    reason: e.reason ?? null,
    note: null,
    expiry: null,
    expires_at: null,
    actor_name: e.actor.name,
    actor_roles: e.actor.roles,
    actor_employee_id: e.actor.employeeId,
    occurred_at: e.at,
    resolved_at: null,
    source: 'seed',
    processor_state: e.awaiting
      ? 'awaiting_processor'
      : e.type === 'pay' && (kind === 'card' || kind === 'apple_pay')
        ? 'confirmed'
        : 'na',
  }
}

async function insertLedger(ctx: SeedContext, rows: LedgerRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200)
    await ctx.tx
      .insertInto('ledger_events')
      .values(rows.slice(i, i + 200).map((e) => ledgerValues(ctx, e)) as never)
      .execute()
}

const SYSTEM = { name: 'System', roles: null, employeeId: null }

function staffActor(r: Refs, first: string, roles: string): LedgerRow['actor'] {
  const e = r.employees.get(first)
  return { name: e?.label ?? first, roles, employeeId: e?.id ?? null }
}

const totalOf = (items: number[], events: CalcEvent[], taxBp: number, tipCents: number): number =>
  calcInvoice({ itemPrices: items, events, taxBp, tipCents, canceled: false }).total

/** The texts the activity log's automatic lines stand for (the live templates, no footer: they were delivered long ago). */
function textFor(line: string, first: string, time: string): { key: string; body: string } | null {
  const fill = (body: string): string => body.replace('{first}', first).replace('{time}', time)
  if (line === 'Booking created') return { key: 'booking_thanks', body: fill(TEMPLATES.booking_thanks.body) }
  if (line === 'Confirmation + reminder sent')
    return { key: 'confirmed', body: fill(TEMPLATES.confirmed.body) }
  if (line === 'In-progress message sent') return { key: 'in_progress', body: TEMPLATES.in_progress.body }
  if (line === 'Ready-for-pickup sent') return { key: 'ready', body: TEMPLATES.ready.body }
  return null
}

async function seedDesignDay(ctx: SeedContext, r: Refs, awaitingId: string | null): Promise<number> {
  const { tx, location } = ctx
  const svc = (name: string): CatalogService => {
    const s = r.byName.get(name)
    if (!s) throw new Error(`demo needs the catalog entry "${name}" (seed the design profile first)`)
    return s
  }
  const customers = new Map(
    (
      await tx
        .selectFrom('customers')
        .select(['id', 'full_name', 'phone_e164'])
        .where('merged_into', 'is', null)
        .where('deleted_at', 'is', null)
        .execute()
    ).map((c) => [c.full_name, c]),
  )
  let made = 0
  for (const [idx, a] of DESIGN_APPOINTMENTS.entries()) {
    const customer = customers.get(a.customer)
    if (!customer)
      throw new Error(`demo needs the design customer ${a.customer} (seed the design profile first)`)
    const p = DEMO_PLAN[a.id]!
    const pkg = svc(a.svc)
    const day = addDays(r.today, a.day)
    const start = wallToInstant(day, parseT(a.time), r.tz)
    const existing = await tx
      .selectFrom('appointments')
      .select('id')
      .where('location_id', '=', location.id)
      .where('customer_id', '=', customer.id)
      .where('scheduled_start', '=', start)
      .where('package_name', '=', pkg.name)
      .executeTakeFirst()
    if (existing) continue
    const s = demoStateAt(a, day, r.tz, r.now)
    const money = demoMoneyAt(a, day, r.tz, r.now)
    const inBay = s.status === 'cleaning' || s.status === 'completed'
    const staff: Staff = a.staff === 'Unassigned' && inBay ? p.staff : a.staff
    const vehicle = await tx
      .selectFrom('vehicles')
      .select(['id', 'year', 'make', 'model'])
      .where('customer_id', '=', customer.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    const bookedAt = wallToInstant(addDays(r.today, -1), BOOKED_AT, r.tz)
    const id = ctx.newId()
    const geo = a.geoIn && s.arrivedAt ? s.arrivedAt : null
    await tx
      .insertInto('appointments')
      .values({
        id,
        location_id: location.id,
        customer_id: customer.id,
        vehicle_id: vehicle?.id ?? null,
        service_id: pkg.id,
        package_name: pkg.name,
        price_cents: pkg.priceCents,
        duration_min: pkg.durationMin,
        status: s.status,
        scheduled_start: start,
        scheduled_end: new Date(start.getTime() + pkg.durationMin * 60_000),
        assigned_employee_id: staff === 'Unassigned' ? null : (r.employees.get(firstOf(staff))?.id ?? null),
        planned_bay_id: a.bay !== null || inBay ? r.bays.get(p.bay)! : null,
        bay_id: inBay ? r.bays.get(p.bay)! : null,
        source: 'dashboard',
        eta_minutes: s.etaMin,
        eta_at: s.etaMin !== null ? new Date(r.now.getTime() + s.etaMin * 60_000) : null,
        geo_checked_in_at: geo,
        arrived_at: s.arrivedAt,
        cleaning_started_at: s.startedAt,
        completed_at: s.doneAt,
        pickup_state: s.status === 'completed' ? (s.collectedAt ? 'collected' : 'pending') : null,
        picked_up_at: s.collectedAt,
        ready_notified_at: s.doneAt,
        notes: a.notes ?? null,
        special_instructions: a.special ?? null,
        created_at: bookedAt,
      })
      .execute()
    const addonRows: Array<{ id: string; svc: CatalogService }> = []
    for (const name of a.addons) {
      const addon = svc(name)
      const rowId = ctx.newId()
      await tx
        .insertInto('appointment_addons')
        .values({
          id: rowId,
          appointment_id: id,
          service_id: addon.id,
          name: addon.name,
          price_cents: addon.priceCents,
          added_at: bookedAt,
        })
        .execute()
      addonRows.push({ id: rowId, svc: addon })
    }
    await snapshotPackageChecklist(tx, r.c, id, pkg)
    for (const row of addonRows) await addAddonChecklist(tx, r.c, id, row.id, row.svc)
    const items = await tx
      .selectFrom('job_checklist_items')
      .select('id')
      .where('appointment_id', '=', id)
      .orderBy('position')
      .orderBy('id')
      .execute()
    const marked = Math.min(items.length, Math.floor(items.length * s.progress))
    for (const [k, item] of items.slice(0, marked).entries()) {
      // spread the ticks over the time the job has been in its bay
      const span = (s.doneAt ?? r.now).getTime() - s.startedAt!.getTime()
      await tx
        .updateTable('job_checklist_items')
        .set({
          done: true,
          done_at: new Date(s.startedAt!.getTime() + Math.round((span * (k + 1)) / (marked + 1))),
          done_by_employee_id: r.employees.get(firstOf(p.staff))?.id ?? null,
        })
        .where('id', '=', item.id)
        .execute()
    }
    // photo rows (no objects behind them, as parity-ops): arrival once the car is here, before once it is in a bay, after
    // once it is finished, and an issue note on every fourth job that has started
    const photos: Array<{ category: 'arrival' | 'before' | 'after'; n: number; at: Date | null }> = [
      { category: 'arrival', n: s.arrivedAt ? 2 : 0, at: s.arrivedAt },
      { category: 'before', n: s.startedAt ? 3 : 0, at: s.startedAt },
      { category: 'after', n: s.doneAt ? 2 : 0, at: s.doneAt },
    ]
    for (const ph of photos)
      for (let k = 0; k < ph.n; k++) {
        const photoId = ctx.newId()
        await tx
          .insertInto('appointment_photos')
          .values({
            id: photoId,
            appointment_id: id,
            category: ph.category,
            s3_key: buildPhotoKey({
              locationId: location.id,
              apptId: id,
              category: ph.category,
              photoId,
              contentType: 'image/jpeg',
            }),
            content_type: 'image/jpeg',
            bytes: 120_000,
            status: 'ready',
            taken_at: ph.at!,
          })
          .execute()
      }
    if (idx % 4 === 0 && s.startedAt)
      await tx
        .insertInto('appointment_photos')
        .values({
          id: ctx.newId(),
          appointment_id: id,
          category: 'issue',
          note: 'Light scratch on the rear bumper',
          status: 'ready',
          taken_at: s.startedAt,
        })
        .execute()

    // activity: what has happened, when it happened
    const log: Array<{ at: Date; text: string; channels: ('sms' | 'internal' | 'automation' | 'system')[] }> =
      [{ at: bookedAt, text: 'Booking created', channels: ['system'] }]
    if (a.status !== 'booked')
      log.push({
        at: wallToInstant(addDays(r.today, -1), CONFIRMED_AT, r.tz),
        text: 'Confirmation + reminder sent',
        channels: ['sms'],
      })
    if (s.arrivedAt) log.push({ at: s.arrivedAt, text: 'Arrival logged', channels: ['internal'] })
    if (s.startedAt) log.push({ at: s.startedAt, text: 'In-progress message sent', channels: ['sms'] })
    if (s.doneAt) log.push({ at: s.doneAt, text: 'Ready-for-pickup sent', channels: ['sms'] })
    if (s.collectedAt)
      log.push({ at: s.collectedAt, text: 'Vehicle released to customer', channels: ['internal'] })
    await tx
      .insertInto('activity_log')
      .values(
        log.map((l) => ({
          appointment_id: id,
          at: l.at,
          text: l.text,
          channels: l.channels,
          actor_type: 'system' as const,
        })),
      )
      .execute()

    // the invoice, numbered as the Payments design numbers it when that number is free
    const free =
      p.invoiceNo !== undefined &&
      !(await tx
        .selectFrom('invoices')
        .select('id')
        .where('location_id', '=', location.id)
        .where('invoice_no', '=', p.invoiceNo)
        .executeTakeFirst())
    const invoiceNo = free ? p.invoiceNo! : await nextInvoiceNo(tx, location.id)
    const lines = [
      { name: pkg.name, priceCents: pkg.priceCents, kind: 'package' as const },
      ...addonRows.map((x) => ({
        name: x.svc.name,
        priceCents: x.svc.priceCents,
        kind: 'addon' as const,
        addonRowId: x.id,
      })),
    ]
    const invoiceId = await insertInvoice(ctx, r, {
      invoiceNo,
      appointmentId: id,
      customerId: customer.id,
      clientName: customer.full_name,
      vehicleLabel: vehicleLabel(vehicle ?? null),
      staffLabel: staff === 'Unassigned' ? 'Unassigned' : (r.employees.get(firstOf(staff))?.label ?? staff),
      occurredAt: start,
      frozenAt: s.doneAt,
      tipCents: money.tipCents,
      items: lines,
    })
    const events: LedgerRow[] = []
    const calc: CalcEvent[] = []
    if (money.adjust) {
      events.push({
        invoiceId,
        customerId: customer.id,
        type: 'adjust',
        cents: money.adjust.cents,
        reason: money.adjust.reason,
        at: money.adjust.at,
        actor: staffActor(r, 'Rafael', 'Management, Accounting'),
      })
      calc.push({ type: 'adjust', amountCents: money.adjust.cents })
    }
    const total = totalOf(
      lines.map((l) => l.priceCents),
      calc,
      r.taxBp,
      money.tipCents,
    )
    let paid = 0
    for (const pay of money.payments) {
      const cents = pay.cents === 'total' ? total : pay.cents === 'balance' ? total - paid : pay.cents
      if (cents <= 0) continue
      paid += cents
      events.push({
        invoiceId,
        customerId: customer.id,
        type: 'pay',
        cents,
        method: pay.method,
        deposit: pay.deposit,
        at: pay.at,
        actor: pay.counter ? staffActor(r, 'Sofia', 'Customer Support, Crew') : SYSTEM,
        awaiting: pay.counter && a.id === awaitingId,
      })
    }
    await insertLedger(ctx, events)

    // the texts behind the automatic lines of the activity log
    if (customer.phone_e164) {
      const threadId = await ensureThread(tx, {
        locationId: location.id,
        customerId: customer.id,
        newId: ctx.newId,
      })
      let last: Date | null = null
      for (const l of log) {
        const text = textFor(l.text, a.customer.split(' ')[0]!, fmtT(parseT(a.time)))
        if (!text) continue
        await insertMessage(tx, {
          id: ctx.newId(),
          location_id: location.id,
          thread_id: threadId,
          customer_id: customer.id,
          employee_id: null,
          appointment_id: id,
          direction: 'out',
          sender_kind: 'system',
          sender_employee_id: null,
          channel: 'sms',
          body: text.body,
          template_key: text.key,
          purpose: 'transactional',
          klass: text.key,
          status: 'delivered',
          peer_e164: customer.phone_e164,
          provider_message_id: null,
          device_id: null,
          error: null,
          segments: 1,
          encoding: 'GSM-7',
          idempotency_key: null,
          queued_at: l.at,
          sent_at: new Date(l.at.getTime() + 2_000),
          delivered_at: new Date(l.at.getTime() + 6_000),
          received_at: null,
          read_at: null,
        } as never)
        last = l.at
      }
      if (last)
        await sql`update message_threads set last_message_at = greatest(coalesce(last_message_at, ${last}), ${last})
          where id = ${threadId}`.execute(tx)
    }
    made++
  }
  return made
}

// Vehicles and checklists for generated jobs ----------------------------------------------------------------------------

/** "2023 Range Rover Sport" -> year, make, model (the two makes of the fixtures that are two words are kept together). */
export function parseVehicleLabel(label: string): { year: number | null; make: string; model: string } {
  const parts = label.split(' ')
  const year = /^\d{4}$/.test(parts[0] ?? '') ? Number(parts.shift()) : null
  const twoWord = ['Range Rover', 'Land Rover', 'Aston Martin', 'Alfa Romeo']
  const pair = `${parts[0] ?? ''} ${parts[1] ?? ''}`
  const make = twoWord.includes(pair) ? pair : (parts[0] ?? '')
  const model = parts.slice(twoWord.includes(pair) ? 2 : 1).join(' ')
  return { year, make, model }
}

async function vehicleFor(ctx: SeedContext, customerId: string, label: string): Promise<string> {
  const rows = await ctx.tx
    .selectFrom('vehicles')
    .select(['id', 'year', 'make', 'model'])
    .where('customer_id', '=', customerId)
    .where('deleted_at', 'is', null)
    .execute()
  const same = rows.find((v) => vehicleLabel(v) === label)
  if (same) return same.id
  const v = parseVehicleLabel(label)
  let h = 0
  for (const ch of `${customerId}|${label}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const plate = `${v.make
    .replace(/[^A-Za-z]/g, '')
    .slice(0, 3)
    .toUpperCase()}-${1000 + (h % 8999)}`
  const id = ctx.newId()
  await ctx.tx
    .insertInto('vehicles')
    .values({ id, customer_id: customerId, year: v.year, make: v.make, model: v.model, color: null, plate })
    .onConflict((oc) => oc.expression(sql`customer_id, upper(plate)`).doNothing())
    .execute()
  const row = await ctx.tx
    .selectFrom('vehicles')
    .select('id')
    .where('customer_id', '=', customerId)
    .where(sql`upper(plate)`, '=', plate)
    .executeTakeFirstOrThrow()
  return row.id
}

/** Checklist rows for a job (package tasks, then each add-on's), all ticked when `doneAt` is given. */
function checklistRows(
  ctx: SeedContext,
  appointmentId: string,
  pkg: CatalogService,
  addons: Array<{ rowId: string; svc: CatalogService }>,
  done: { at: Date; by: string | null } | null,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  const push = (
    label: string,
    kind: 'package' | 'addon',
    title: string,
    taskId: string | null,
    addonRowId: string | null,
  ): void =>
    void rows.push({
      id: ctx.newId(),
      appointment_id: appointmentId,
      section_kind: kind,
      section_title: title,
      source_task_id: taskId,
      appointment_addon_id: addonRowId,
      label,
      position: rows.length,
      done: done !== null,
      done_at: done?.at ?? null,
      done_by_employee_id: done?.by ?? null,
    })
  for (const t of pkg.tasks) push(t.label, 'package', pkg.name, t.id, null)
  for (const a of addons) {
    const ids = new Map(a.svc.tasks.map((t) => [t.label, t.id]))
    for (const label of jobTasksFor(a.svc)) push(label, 'addon', a.svc.name, ids.get(label) ?? null, a.rowId)
  }
  return rows
}

async function insertChunks(ctx: SeedContext, table: string, rows: Record<string, unknown>[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 250)
    await ctx.tx
      .insertInto(table as never)
      .values(rows.slice(i, i + 250) as never)
      .execute()
}

// The Payments history as appointments ----------------------------------------------------------------------------------

/** Gives each history invoice the appointment it was for (completed, or canceled for a canceled invoice). */
async function linkHistoryAppointments(
  ctx: SeedContext,
  r: Refs,
  seeded: readonly SeededInvoice[],
): Promise<number> {
  const appts: Record<string, unknown>[] = []
  const addons: Record<string, unknown>[] = []
  const checklists: Record<string, unknown>[] = []
  const activity: Record<string, unknown>[] = []
  const links: Array<{ invoiceId: string; appointmentId: string }> = []
  for (const [i, s] of seeded.entries()) {
    const pkg = r.byName.get(s.inv.items[0]!.name)
    if (!pkg) continue
    const vehicleId = await vehicleFor(ctx, s.customerId, s.inv.vehicle)
    const staff = s.inv.staff === 'Unassigned' ? null : (r.employees.get(firstOf(s.inv.staff))?.id ?? null)
    const id = ctx.newId()
    const start = s.occurredAt
    const end = new Date(start.getTime() + pkg.durationMin * 60_000)
    const bay = r.bays.get((i % 2) + 1)!
    const booked = new Date(start.getTime() - 2 * 86_400_000)
    appts.push({
      id,
      location_id: ctx.location.id,
      customer_id: s.customerId,
      vehicle_id: vehicleId,
      service_id: pkg.id,
      package_name: pkg.name,
      price_cents: s.inv.items[0]!.priceCents,
      duration_min: pkg.durationMin,
      status: s.inv.canceled ? 'canceled' : 'completed',
      scheduled_start: start,
      scheduled_end: end,
      assigned_employee_id: staff,
      planned_bay_id: bay,
      bay_id: s.inv.canceled ? null : bay,
      source: 'dashboard',
      arrived_at: s.inv.canceled ? null : start,
      cleaning_started_at: s.inv.canceled ? null : start,
      completed_at: s.inv.canceled ? null : end,
      pickup_state: s.inv.canceled ? null : 'collected',
      picked_up_at: s.inv.canceled ? null : end,
      ready_notified_at: s.inv.canceled ? null : end,
      canceled_at: s.inv.canceled ? new Date(start.getTime() - 86_400_000) : null,
      cancel_reason: s.inv.canceled ? 'Customer canceled' : null,
      created_at: booked,
    })
    const rows: Array<{ rowId: string; svc: CatalogService }> = []
    for (const it of s.inv.items.slice(1)) {
      const svc = r.byName.get(it.name)
      if (!svc) continue
      const rowId = ctx.newId()
      rows.push({ rowId, svc })
      addons.push({
        id: rowId,
        appointment_id: id,
        service_id: svc.id,
        name: it.name,
        price_cents: it.priceCents,
        added_at: booked,
      })
    }
    checklists.push(...checklistRows(ctx, id, pkg, rows, s.inv.canceled ? null : { at: end, by: staff }))
    activity.push({
      appointment_id: id,
      at: booked,
      text: 'Booking created',
      channels: ['system'],
      actor_type: 'system',
    })
    links.push({ invoiceId: s.invoiceId, appointmentId: id })
  }
  await insertChunks(ctx, 'appointments', appts)
  await insertChunks(ctx, 'appointment_addons', addons)
  await insertChunks(ctx, 'job_checklist_items', checklists)
  await insertChunks(ctx, 'activity_log', activity)
  for (const l of links)
    await ctx.tx
      .updateTable('invoices')
      .set({ appointment_id: l.appointmentId })
      .where('id', '=', l.invoiceId)
      .execute()
  return links.length
}

// The procedural calendar -----------------------------------------------------------------------------------------------

async function poolCustomers(ctx: SeedContext): Promise<string[]> {
  const ids: string[] = []
  for (const [i, name] of POOL_NAMES.entries()) {
    const phone = `+1${i % 2 === 0 ? '305' : '786'}5550${String(114 + i)}`
    const found = await ctx.tx
      .selectFrom('customers')
      .select('id')
      .where('phone_e164', '=', phone)
      .where('merged_into', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (found) {
      ids.push(found.id)
      continue
    }
    const id = ctx.newId()
    await ctx.tx
      .insertInto('customers')
      .values({
        id,
        full_name: name,
        phone_e164: phone,
        phone_display: formatPhoneDisplay(phone),
        sms_opted_in: true,
        sms_opt_in_source: 'import',
        sms_opt_in_at: ctx.clock.now(),
        source: 'import',
        synthetic: true,
      })
      .execute()
    ids.push(id)
  }
  return ids
}

/** The detailer for the i-th job of a day: the design's rotation, moved on to the next one who works that weekday. */
function staffFor(
  r: Refs,
  index: number,
  weekday: number,
): { first: string; label: string; id: string } | null {
  for (let k = 0; k < GEN_STAFF.length; k++) {
    const first = firstOf(GEN_STAFF[(index + k) % GEN_STAFF.length]!)
    const e = r.employees.get(first)
    if (e && r.works.get(first)?.has(weekday)) return { first, ...e }
  }
  return null
}

async function seedProceduralDays(ctx: SeedContext, r: Refs): Promise<number> {
  const { tx, location } = ctx
  const pool = await poolCustomers(ctx)
  const hours = await getHours(tx, location.id)
  const closures = await listLiveClosures(tx, location.id)
  const offsets = [
    ...Array.from({ length: PROCEDURAL_PAST[1] - PROCEDURAL_PAST[0] + 1 }, (_, k) => PROCEDURAL_PAST[0] + k),
    ...Array.from(
      { length: PROCEDURAL_FUTURE[1] - PROCEDURAL_FUTURE[0] + 1 },
      (_, k) => PROCEDURAL_FUTURE[0] + k,
    ),
  ]
  const { start: rangeFrom } = bizDayBounds(addDays(r.today, PROCEDURAL_PAST[0]), r.tz)
  const { end: rangeTo } = bizDayBounds(addDays(r.today, PROCEDURAL_FUTURE[1]), r.tz)
  const seededDates = new Set(
    (
      await tx
        .selectFrom('appointments')
        .select('scheduled_start')
        .where('location_id', '=', location.id)
        .where('customer_id', 'in', pool)
        .where('scheduled_start', '>=', rangeFrom)
        .where('scheduled_start', '<', rangeTo)
        .execute()
    ).map((a) => toBizDate(a.scheduled_start, r.tz)),
  )
  // past invoices count down from PAST_PROCEDURAL_TOP, newest first, skipping numbers in use
  const used = new Set(
    (
      await tx
        .selectFrom('invoices')
        .select('invoice_no')
        .where('location_id', '=', location.id)
        .where('invoice_no', '<=', PAST_PROCEDURAL_TOP)
        .execute()
    ).map((x) => x.invoice_no),
  )
  let pastNo = PAST_PROCEDURAL_TOP

  interface Job {
    date: string
    weekday: number
    past: boolean
    g: ReturnType<typeof designGenDay>[number]
  }
  const jobs: Job[] = []
  for (const o of offsets) {
    const date = addDays(r.today, o)
    if (seededDates.has(date)) continue
    const info = dayInfo({ date, hours, closures })
    if (info.closed) continue
    for (const g of designGenDay(o, info.weekday, info.h0!, info.h1!, info.reduced))
      jobs.push({ date, weekday: bizWeekday(date), past: o < 0, g })
  }
  // numbers: the past newest-first below the history, the future in date order from the counter
  const past = jobs.filter((j) => j.past).reverse()
  const future = jobs.filter((j) => !j.past)
  const numbers = new Map<Job, number>()
  for (const j of past) {
    while (used.has(pastNo)) pastNo--
    numbers.set(j, pastNo--)
  }
  if (future.length > 0) {
    const first = await sql<{ no: number }>`
      update invoice_counters set next_no = next_no + ${future.length}
      where location_id = ${location.id} returning next_no - ${future.length} as no`.execute(tx)
    future.forEach((j, k) => numbers.set(j, first.rows[0]!.no + k))
  }

  const vehicles: Record<string, unknown>[] = []
  const appts: Record<string, unknown>[] = []
  const invoices: Record<string, unknown>[] = []
  const items: Record<string, unknown>[] = []
  const checklists: Record<string, unknown>[] = []
  const activity: Record<string, unknown>[] = []
  const ledger: LedgerRow[] = []
  const plates = new Map<string, string>()
  for (const j of jobs) {
    const pkg = r.byName.get(j.g.svc)!
    const customerId = pool[j.g.customerIdx]!
    const start = wallToInstant(j.date, j.g.startMin, r.tz)
    const end = new Date(start.getTime() + pkg.durationMin * 60_000)
    const staff = staffFor(r, j.g.index, j.weekday)
    const bay = r.bays.get(j.g.bayNumber)!
    const plateKey = `${customerId}|${j.g.plate}`
    let vehicleId = plates.get(plateKey)
    if (!vehicleId) {
      vehicleId = ctx.newId()
      plates.set(plateKey, vehicleId)
      vehicles.push({
        id: vehicleId,
        customer_id: customerId,
        year: j.g.vehicle[0],
        make: j.g.vehicle[1],
        model: j.g.vehicle[2],
        color: j.g.vehicle[3],
        plate: j.g.plate,
      })
    }
    const id = ctx.newId()
    const booked = j.past
      ? new Date(start.getTime() - 3 * 86_400_000)
      : new Date(Math.min(start.getTime() - 86_400_000, r.now.getTime() - ((j.g.index % 5) + 1) * 3_600_000))
    appts.push({
      id,
      location_id: location.id,
      customer_id: customerId,
      vehicle_id: vehicleId,
      service_id: pkg.id,
      package_name: pkg.name,
      price_cents: pkg.priceCents,
      duration_min: pkg.durationMin,
      status: j.g.status,
      scheduled_start: start,
      scheduled_end: end,
      assigned_employee_id: staff?.id ?? null,
      planned_bay_id: bay,
      bay_id: j.past ? bay : null,
      source: 'dashboard',
      arrived_at: j.past ? start : null,
      cleaning_started_at: j.past ? start : null,
      completed_at: j.past ? end : null,
      pickup_state: j.past ? 'collected' : null,
      picked_up_at: j.past ? end : null,
      ready_notified_at: j.past ? end : null,
      created_at: booked,
    })
    checklists.push(...checklistRows(ctx, id, pkg, [], j.past ? { at: end, by: staff?.id ?? null } : null))
    activity.push({
      appointment_id: id,
      at: booked,
      text: 'Booking created',
      channels: ['system'],
      actor_type: 'system',
    })
    const invoiceId = ctx.newId()
    const vehicle = { year: j.g.vehicle[0], make: j.g.vehicle[1], model: j.g.vehicle[2] }
    invoices.push({
      id: invoiceId,
      location_id: location.id,
      invoice_no: numbers.get(j)!,
      appointment_id: id,
      customer_id: customerId,
      client_name: POOL_NAMES[j.g.customerIdx]!,
      vehicle_label: vehicleLabel(vehicle),
      staff_label: staff?.label ?? 'Unassigned',
      occurred_at: start,
      biz_date: j.date,
      date_frozen_at: j.past ? end : null,
      tax_bp: r.taxBp,
      tip_cents: 0,
    })
    items.push({
      id: ctx.newId(),
      invoice_id: invoiceId,
      position: 0,
      kind: 'package',
      service_id: pkg.id,
      name: pkg.name,
      price_cents: pkg.priceCents,
    })
    if (j.past)
      ledger.push({
        invoiceId,
        customerId,
        type: 'pay',
        cents: totalOf([pkg.priceCents], [], r.taxBp, 0),
        method: PAST_METHODS[(j.g.index + j.g.customerIdx) % PAST_METHODS.length]!,
        at: new Date(end.getTime() + PAY_AFTER_DONE * 60_000),
        actor: staffActor(r, 'Sofia', 'Customer Support, Crew'),
      })
  }
  for (let i = 0; i < vehicles.length; i += 250)
    await tx
      .insertInto('vehicles')
      .values(vehicles.slice(i, i + 250) as never)
      .onConflict((oc) => oc.expression(sql`customer_id, upper(plate)`).doNothing())
      .execute()
  // a plate that already belonged to the customer keeps that vehicle
  const known = new Map<string, string>()
  for (const v of await tx
    .selectFrom('vehicles')
    .select(['id', 'customer_id', 'plate'])
    .where('customer_id', 'in', pool)
    .execute())
    known.set(`${v.customer_id}|${(v.plate ?? '').toUpperCase()}`, v.id)
  for (const a of appts) {
    const v = vehicles.find((x) => x.id === a.vehicle_id)
    if (v)
      a.vehicle_id =
        known.get(`${v.customer_id as string}|${(v.plate as string).toUpperCase()}`) ?? a.vehicle_id
  }
  await insertChunks(ctx, 'appointments', appts)
  await insertChunks(ctx, 'job_checklist_items', checklists)
  await insertChunks(ctx, 'activity_log', activity)
  await insertChunks(ctx, 'invoices', invoices)
  await insertChunks(ctx, 'invoice_items', items)
  await insertLedger(ctx, ledger)
  return appts.length
}

export const demoSeedProfiles: Record<string, SeedProfile> = {
  demo: {
    description:
      'The Operations design day re-anchored on today with the real clock (statuses as of the time it runs), its invoices and texts, the Payments history and the design calendar around today',
    dependsOn: ['design', 'memberships', 'geofence'],
    run: seedDemo,
  },
}
