// Seed profile "parity-pay": the Payments design's 105-invoice fixture set (pay-domain section 6), reproduced exactly: the
// 16 explicit invoices and the 89 generated ones from mulberry32(987654) with the design's RNG call order. The design's id
// collisions (generated ids counted down from 20608 into the explicit ones) are fixed by renumbering the generated invoices
// downward from 20608, skipping ids already used (they end at 20506). Times are relative to the clock the seed runs with
// (the parity clock 2026-06-13T10:36 -04:00): "off" is the day offset from today, "time" the wall-clock time that day.
// Money is integer cents; customers get synthetic phones (+1 954 555 01xx) so nothing can text a stranger.
import { DateTime } from 'luxon'
import { calcInvoice, type CalcEvent } from '../../src/modules/payments/calc.js'
import { allocateFifo, loadCreditLots } from '../../src/modules/payments/credit.js'
import { cardLabel, kindOfMethodLabel } from '../../src/modules/payments/repository.js'
import type { CreditExpiry, MethodKind, RefundDest, RefundStatus } from '../../src/modules/payments/schema.js'
import { mulberry32 } from '../../src/platform/random.js'
import { getSetting } from '../../src/platform/settings.js'
import { addDays, bizDayBounds, parseT, toBizDate, wallToInstant } from '../../src/platform/time.js'
import type { SeedContext, SeedProfile } from './index.js'

const PRICE: Record<string, number> = {
  'Express Hand Wash': 4500,
  'Premium Hand Wash + Interior': 12900,
  'Premium Hand Wash + Interior Refresh': 13900,
  'Executive Detail': 26000,
  'Executive Detail + Ceramic': 42000,
  'Full Detail': 32000,
  'Ceramic Maintenance + Wax': 18000,
  'Exotic Detail Package': 65000,
  'Family Wash + Pet Hair': 9500,
}
const ADD: Record<string, number> = {
  'Interior deep clean': 6000,
  'Pet hair removal': 3500,
  'Leather conditioning': 4500,
  Wax: 4000,
  'Clay bar': 5000,
  'Odor removal': 3000,
  'Engine bay cleaning': 5500,
  'Ceramic maintenance': 12000,
  'Rain repellent': 2500,
  'Wheel deep clean': 4000,
}

export interface SeedEvent {
  type: 'pay' | 'adjust' | 'refund' | 'credit_issue' | 'credit_apply'
  amountCents: number
  /** The design's free-text time ("Yesterday 4:40 PM", "Jun 11 · 9:12 AM", "10:20 AM"); empty = the invoice time. */
  t: string
  by: string
  byRole?: string
  method?: string
  deposit?: boolean
  dest?: RefundDest
  reason?: string
  note?: string
  status?: RefundStatus
  expiry?: 'No expiry' | '90 days' | '30 days'
}

export interface DesignInvoice {
  /** Final invoice number (after the collision fix). */
  no: number
  /** The id the design printed (generated invoices collide with explicit ones there). */
  designId: string
  off: number
  time: string
  client: string
  vehicle: string
  staff: string
  items: { name: string; priceCents: number }[]
  tipCents: number
  canceled: boolean
  events: SeedEvent[]
}

interface MkOpts {
  id?: string
  off: number
  time: string
  client: string
  veh: string
  staff?: string
  svc: string
  add?: string[]
  tip?: number
  canceled?: boolean
  adj?: Array<[number, string]>
  /** 'full' or a deposit in dollars. */
  pay?: 'full' | number
  creditUsed?: number
  method?: string
  pre?: SeedEvent[]
  post?: Array<Partial<SeedEvent> & Pick<SeedEvent, 'type'> & { amt: number }>
}

const dollars = (n: number): number => Math.round(n * 100)

const CALC_TAX_BP = 700

function build(): DesignInvoice[] {
  const out: DesignInvoice[] = []
  let seq = 20610
  const mk = (o: MkOpts): void => {
    const items = [
      { name: o.svc, priceCents: PRICE[o.svc]! },
      ...(o.add ?? []).map((n) => ({ name: n, priceCents: ADD[n]! })),
    ]
    const designId = o.id ?? `INV-${seq--}`
    const events: SeedEvent[] = [...(o.pre ?? [])]
    for (const [amt, reason] of o.adj ?? [])
      events.push({ type: 'adjust', amountCents: dollars(amt), reason, by: 'Rafael M.', t: o.time })
    const calcEvents: CalcEvent[] = events.map((e) => ({ type: e.type, amountCents: e.amountCents }))
    const total = calcInvoice({
      itemPrices: items.map((i) => i.priceCents),
      events: calcEvents,
      taxBp: CALC_TAX_BP,
      tipCents: dollars(o.tip ?? 0),
      canceled: !!o.canceled,
    }).total
    const method = o.method ?? 'Visa ••4421'
    if (o.pay === 'full')
      events.push({ type: 'pay', amountCents: total - dollars(o.creditUsed ?? 0), method, by: 'System', t: o.time })
    else if (o.pay && o.pay > 0)
      events.push({ type: 'pay', amountCents: dollars(o.pay), method, by: 'System', t: o.time, deposit: true })
    for (const e of o.post ?? []) {
      const { amt, ...rest } = e
      events.push({ t: o.time, by: 'Rafael M.', ...rest, amountCents: dollars(amt) } as SeedEvent)
    }
    out.push({
      no: 0,
      designId,
      off: o.off,
      time: o.time,
      client: o.client,
      vehicle: o.veh,
      staff: o.staff ?? 'Marco R.',
      items,
      tipCents: dollars(o.tip ?? 0),
      canceled: !!o.canceled,
      events,
    })
  }

  // today
  mk({ id: 'INV-20608', off: 0, time: '10:05 AM', client: 'Aisha Rahman', veh: '2023 Range Rover Sport', svc: 'Executive Detail + Ceramic', add: ['Ceramic maintenance'], pay: 'full', method: 'Amex ••3008' })
  mk({ id: 'INV-20607', off: 0, time: '10:15 AM', client: 'Marcus Webb', veh: '2017 Jeep Wrangler', staff: 'Unassigned', svc: 'Family Wash + Pet Hair', add: ['Odor removal'], pay: 20, method: 'Visa ••6610' })
  mk({ id: 'INV-20606', off: 0, time: '9:50 AM', client: 'Liam Chen', veh: '2020 BMW M340i', svc: 'Ceramic Maintenance + Wax', pay: 'full', method: 'Visa ••7731' })
  mk({ id: 'INV-20605', off: 0, time: '10:30 AM', client: 'Sofia Marchetti', veh: '2024 Porsche Macan', staff: 'Sofia D.', svc: 'Executive Detail', pay: 50, method: 'Visa ••0092' })
  mk({ id: 'INV-20604', off: 0, time: '9:40 AM', client: 'Jonathan Franco', veh: '2023 Mercedes-Benz GLE', svc: 'Premium Hand Wash + Interior Refresh', add: ['Leather conditioning'], pay: 'full', method: 'Apple Pay' })
  mk({ id: 'INV-20603', off: 0, time: '10:31 AM', client: 'Priya Nair', veh: '2022 Tesla Model Y', staff: 'Lena K.', svc: 'Premium Hand Wash + Interior', add: ['Rain repellent'], pay: 0 })
  mk({ id: 'INV-20602', off: 0, time: '9:58 AM', client: 'David Okafor', veh: '2019 Ford F-150', svc: 'Full Detail', add: ['Engine bay cleaning'], tip: 20, adj: [[-25, 'Loyalty']], pay: 'full', method: 'Mastercard ••1180' })
  mk({ id: 'INV-20601', off: 0, time: '8:52 AM', client: 'Maria Delgado', veh: '2021 Audi Q5', staff: 'Lena K.', svc: 'Express Hand Wash', add: ['Wax'], tip: 8, pay: 'full', method: 'Visa ••4421' })
  // specials
  mk({ id: 'INV-20579', off: -1, time: '2:10 PM', client: 'Chloe Bennett', veh: '2022 BMW X5', staff: 'Lena K.', svc: 'Executive Detail', pay: 'full', method: 'Visa ••5521', post: [{ type: 'refund', amt: 80, dest: 'card', method: 'Visa ••5521', reason: 'Service issue', note: 'Interior stain not fully removed', by: 'Sofia D.', byRole: 'Customer Support', status: 'pending', t: 'Yesterday 4:40 PM' }] })
  mk({ id: 'INV-20571', off: -2, time: '11:00 AM', client: 'Omar Haddad', veh: '2023 Porsche 911 Carrera', svc: 'Full Detail', canceled: true, pay: 50, method: 'Visa ••2290', post: [{ type: 'refund', amt: 50, dest: 'card', method: 'Visa ••2290', reason: 'Customer canceled', by: 'Sofia D.', status: 'done', t: 'Jun 11 · 9:12 AM' }] })
  mk({ id: 'INV-20566', off: -3, time: '1:30 PM', client: 'Hannah Kim', veh: '2024 Rivian R1S', svc: 'Premium Hand Wash + Interior', add: ['Pet hair removal'], tip: 10, pay: 'full', post: [{ type: 'refund', amt: 37.45, dest: 'card', method: 'Visa ••4421', reason: 'Add-on not performed', by: 'Rafael M.', status: 'done', t: 'Jun 10 · 3:05 PM' }] })
  mk({ id: 'INV-20560', off: -4, time: '10:20 AM', client: 'Victor Nguyen', veh: '2020 Honda Accord', svc: 'Express Hand Wash', creditUsed: 25, pre: [{ type: 'credit_apply', amountCents: 2500, method: 'Store credit', by: 'Sofia D.', t: '10:20 AM' }], pay: 'full', method: 'Visa ••8812' })
  mk({ id: 'INV-20552', off: -5, time: '3:15 PM', client: 'Mateo Silva', veh: '2022 Ford Bronco', svc: 'Premium Hand Wash + Interior', pay: 'full', method: 'Apple Pay', post: [{ type: 'credit_issue', amt: 25, reason: 'Service recovery', note: 'Waited 40 min past slot', expiry: '90 days', t: 'Jun 8 · 4:02 PM' }] })
  mk({ id: 'INV-20548', off: -6, time: '9:00 AM', client: 'Zoe Laurent', veh: '2023 Audi e-tron GT', svc: 'Exotic Detail Package', adj: [[40, 'Extra soil surcharge']], pay: 'full', method: 'Amex ••1005' })
  mk({ off: -14, time: '11:30 AM', client: 'Priya Nair', veh: '2022 Tesla Model Y', staff: 'Lena K.', svc: 'Express Hand Wash', pay: 'full', post: [{ type: 'credit_issue', amt: 20, reason: 'Referral reward', expiry: 'No expiry', t: 'May 30 · 11:45 AM' }] })
  mk({ off: -20, time: '12:00 PM', client: 'Victor Nguyen', veh: '2020 Honda Accord', svc: 'Express Hand Wash', pay: 'full', post: [{ type: 'credit_issue', amt: 25, reason: 'Weather closure', expiry: '90 days', t: 'May 24 · 12:10 PM' }] })

  // generated history: mulberry32(987654), the design's exact call order
  const rnd = mulberry32(987654)
  const names = ['Olivia Hart', 'Ethan Morales', 'Isaac Patel', 'Andre Thompson', 'Camila Reyes', 'Noah Fischer', 'Leah Goldberg', 'Ruby Castillo', 'Ava Sinclair', 'Diego Ramos', 'Nina Petrova', 'Caleb Owens', 'Mia Torres', 'Julian Brooks', 'Grace Adeyemi', 'Tom Bradley', 'Nathan Brooks']
  const vehs = ['2022 BMW X5', '2021 Toyota 4Runner', '2020 Honda Accord', '2024 Rivian R1S', '2019 Mercedes-Benz C300', '2021 Kia Telluride', '2022 Tesla Model 3', '2024 Lexus GX 550', '2023 Genesis GV80', '2018 Lexus RX 350']
  const svcs = Object.keys(PRICE)
  const adds = Object.keys(ADD)
  const methods = ['Visa ••4421', 'Mastercard ••1180', 'Apple Pay', 'Apple Pay', 'Cash', 'Amex ••3008']
  const generatedFrom = out.length
  for (let o = -1; o >= -29; o--) {
    if (o === -10) continue
    const n = 2 + Math.floor(rnd() * 3)
    for (let i = 0; i < n; i++) {
      const h = 8 + Math.floor(rnd() * 9)
      const r = rnd()
      const time = `${h % 12 || 12}:${rnd() < 0.5 ? '00' : '30'} ${h >= 12 ? 'PM' : 'AM'}`
      const client = names[Math.floor(rnd() * names.length)]!
      const veh = vehs[Math.floor(rnd() * vehs.length)]!
      const svc = svcs[Math.floor(rnd() * svcs.length)]!
      const add = rnd() < 0.4 ? [adds[Math.floor(rnd() * adds.length)]!] : []
      const tip = 5 * Math.floor(rnd() * 4)
      const method = methods[Math.floor(rnd() * methods.length)]!
      mk({
        off: o,
        time,
        client,
        veh,
        staff: ['Marco R.', 'Lena K.', 'Sofia D.'][i % 3],
        svc,
        add,
        tip,
        adj: r < 0.08 ? [[-15, 'Loyalty']] : [],
        pay: 'full',
        method,
        post: r > 0.95 ? [{ type: 'refund', amt: 20, dest: 'credit', method: 'Store credit', reason: 'Goodwill', by: 'Sofia D.', status: 'done', t: '' }] : [],
      })
    }
  }

  // numbering: explicit invoices keep their ids, generated ones count down from 20608 skipping every id in use
  const used = new Set(out.slice(0, generatedFrom).map((x) => Number(x.designId.slice(4))))
  let next = 20608
  for (const [i, inv] of out.entries()) {
    if (i < generatedFrom) inv.no = Number(inv.designId.slice(4))
    else {
      while (used.has(next)) next--
      inv.no = next
      used.add(next--)
    }
  }
  return out
}

/** The 105 design invoices in the order the design builds them. Pure: no database, no clock. */
export const designInvoices = (): DesignInvoice[] => build()

// --- time strings -------------------------------------------------------------------------------------------------------

/** The instant behind a design event time ("" / "10:20 AM" = that day; "Yesterday 4:40 PM"; "Jun 11 · 9:12 AM"). */
export function eventInstant(t: string, invoiceInstant: Date, invoiceBizDate: string, today: string, tz: string): Date {
  if (!t) return invoiceInstant
  const m = /^(?:(Today|Yesterday|[A-Z][a-z]{2} \d{1,2})(?: · | ))?(\d{1,2}:\d{2} [AP]M)$/.exec(t)
  if (!m) throw new Error(`Unrecognised design time "${t}"`)
  const [, dayWord, clock] = m
  let day = invoiceBizDate
  if (dayWord === 'Today') day = today
  else if (dayWord === 'Yesterday') day = addDays(today, -1)
  else if (dayWord) {
    const year = DateTime.fromISO(today).year
    const d = DateTime.fromFormat(`${dayWord} ${year}`, 'LLL d yyyy', { locale: 'en-US', zone: 'utc' })
    if (!d.isValid) throw new Error(`Bad design date "${dayWord}"`)
    day = d.toFormat('yyyy-LL-dd')
  }
  return wallToInstant(day, parseT(clock!), tz)
}

const brandOf = (method: string): { brand: string | null; last4: string | null } => {
  const m = /^(Visa|Mastercard|Amex)\s+••(\d{4})$/.exec(method)
  if (m) return { brand: m[1]!.toLowerCase(), last4: m[2]! }
  return { brand: cardLabel(method).brand, last4: null }
}

const EXPIRY: Record<NonNullable<SeedEvent['expiry']>, CreditExpiry> = {
  'No expiry': 'none',
  '90 days': 'd90',
  '30 days': 'd30',
}

// --- the profile --------------------------------------------------------------------------------------------------------

export async function seedParityPay(ctx: SeedContext): Promise<void> {
  const { tx, location } = ctx
  const tz = location.timezone
  const now = ctx.clock.now()
  const today = toBizDate(now, tz)
  const taxBp = (await getSetting(tx, location.id, 'tax.rate_bp')).value
  const invoices = designInvoices()

  const services = new Map(
    (await tx.selectFrom('services').select(['id', 'name', 'kind']).where('location_id', '=', location.id).execute()).map(
      (s) => [`${s.kind}|${s.name.toLowerCase()}`, s.id],
    ),
  )

  // customers: reuse a live customer with the same name (the design customers), else create one with a synthetic phone
  const customerIds = new Map<string, string>()
  let phoneNo = 100
  for (const name of [...new Set(invoices.map((i) => i.client))]) {
    const existing = await tx
      .selectFrom('customers')
      .select('id')
      .where('full_name', '=', name)
      .where('merged_into', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (existing) {
      customerIds.set(name, existing.id)
      continue
    }
    let phone: string
    for (;;) {
      if (phoneNo > 199) throw new Error('parity-pay: out of synthetic phone numbers')
      phone = `+1954555${String(phoneNo++).padStart(4, '0')}`
      const taken = await tx.selectFrom('customers').select('id').where('phone_e164', '=', phone).executeTakeFirst()
      if (!taken) break
    }
    const id = ctx.newId()
    await tx
      .insertInto('customers')
      .values({
        id,
        full_name: name,
        phone_e164: phone,
        phone_display: `(954) 555-${phone.slice(-4)}`,
        email: null,
        notes: null,
        sms_opted_in: true,
        sms_opt_in_source: 'import',
        sms_opt_in_at: now,
        source: 'import',
        synthetic: true,
      })
      .execute()
    customerIds.set(name, id)
  }

  const applies: Array<{ eventId: string; customerId: string; cents: number; at: Date }> = []
  let created = 0
  for (const inv of invoices) {
    const exists = await tx
      .selectFrom('invoices')
      .select('id')
      .where('location_id', '=', location.id)
      .where('invoice_no', '=', inv.no)
      .executeTakeFirst()
    if (exists) continue
    created++
    const bizDate = addDays(today, inv.off)
    const occurredAt = wallToInstant(bizDate, parseT(inv.time), tz)
    const customerId = customerIds.get(inv.client)!
    const invoiceId = ctx.newId()
    await tx
      .insertInto('invoices')
      .values({
        id: invoiceId,
        location_id: location.id,
        invoice_no: inv.no,
        appointment_id: null,
        customer_id: customerId,
        client_name: inv.client,
        vehicle_label: inv.vehicle,
        staff_label: inv.staff,
        occurred_at: occurredAt,
        biz_date: bizDate,
        date_frozen_at: occurredAt,
        tax_bp: taxBp,
        tip_cents: inv.tipCents,
        canceled_at: inv.canceled ? occurredAt : null,
        canceled_by: null,
        canceled_by_name: null,
        cancel_reason: inv.canceled ? 'canceled' : null,
        payment_link_url: null,
        payment_link_sent_at: null,
      })
      .execute()
    for (const [position, it] of inv.items.entries()) {
      await tx
        .insertInto('invoice_items')
        .values({
          id: ctx.newId(),
          invoice_id: invoiceId,
          position,
          kind: position === 0 ? 'package' : 'addon',
          service_id: services.get(`${position === 0 ? 'package' : 'addon'}|${it.name.toLowerCase()}`) ?? null,
          name: it.name,
          price_cents: it.priceCents,
          appointment_addon_id: null,
        })
        .execute()
    }
    for (const e of inv.events) {
      const at = eventInstant(e.t, occurredAt, bizDate, today, tz)
      const method = e.method ?? null
      const kind: MethodKind | null = method ? kindOfMethodLabel(method) : null
      const brand = method && kind === 'card' ? brandOf(method) : { brand: null, last4: null }
      const status: RefundStatus = e.type === 'refund' ? (e.status ?? 'done') : 'done'
      const cardLeg = kind === 'card' || kind === 'apple_pay'
      const eventId = ctx.newId()
      const expiry = e.expiry ? EXPIRY[e.expiry] : null
      const expiresAt =
        expiry === 'none' || expiry === null
          ? null
          : bizDayBounds(addDays(toBizDate(at, tz), expiry === 'd30' ? 30 : 90), tz).end
      await tx
        .insertInto('ledger_events')
        .values({
          id: eventId,
          location_id: location.id,
          invoice_id: invoiceId,
          customer_id: customerId,
          type: e.type,
          amount_cents: e.amountCents,
          status,
          method,
          method_kind: kind,
          brand: brand.brand,
          last4: brand.last4,
          dest: e.type === 'refund' ? (e.dest ?? 'card') : null,
          deposit: e.deposit ?? false,
          reason: e.reason ?? null,
          note: e.note ?? null,
          expiry,
          expires_at: expiresAt,
          actor_name: e.by,
          actor_roles: e.byRole ?? null,
          occurred_at: at,
          resolved_at: e.type === 'refund' && status !== 'pending' ? at : null,
          source: 'seed',
          // the fixtures are history: money that already went through Squarespace reads as confirmed
          processor_state:
            (e.type === 'pay' && cardLeg) || (e.type === 'refund' && status === 'done' && e.dest === 'card')
              ? 'confirmed'
              : 'na',
        })
        .execute()
      if (e.type === 'credit_apply') applies.push({ eventId, customerId, cents: e.amountCents, at })
    }
  }

  // Store-credit allocations, written chronologically once every lot exists (an apply may precede a later invoice's issue).
  applies.sort((a, b) => a.at.getTime() - b.at.getTime())
  for (const a of applies) {
    const lots = await loadCreditLots(tx, a.customerId)
    for (const al of allocateFifo(lots, a.at, a.cents)) {
      await tx
        .insertInto('credit_allocations')
        .values({ id: ctx.newId(), apply_event_id: a.eventId, lot_event_id: al.lotId, customer_id: a.customerId, cents: al.cents })
        .execute()
    }
  }

  // the counter continues after the seeded range (20610 is the highest design id)
  await tx.insertInto('invoice_counters').values({ location_id: location.id }).onConflict((oc) => oc.doNothing()).execute()
  const max = Math.max(...invoices.map((i) => i.no))
  await tx
    .updateTable('invoice_counters')
    .set((eb) => ({ next_no: eb.fn('greatest', ['next_no', eb.val(max + 1)]) }))
    .where('location_id', '=', location.id)
    .execute()
  ctx.log(`parity-pay: ${created} invoices created (${invoices.length - created} already present)`)
}

export const paymentsSeedProfiles: Record<string, SeedProfile> = {
  'parity-pay': {
    description: 'The Payments design fixtures: 105 invoices with ledger events, store credit and the pending refund',
    dependsOn: ['base'],
    run: seedParityPay,
  },
}
