// tsx scripts/e2e-square/driver.ts --env <stack env file> --dir <state dir> <step>
//
// The Square SANDBOX end to end of the plan's "Verification" (ADR 0170, ADR 0171) against a disposable stack started by
// scripts/e2e-square/stack.ts (same --env and --dir). Steps, in order; each prints what it saw and "S<n> PASS|FAIL: ..." lines
// (also appended to <dir>/results.txt) and keeps what later steps need in <dir>/state.json:
//   setup    Test connection; the Events API watermark at the run's start; Settings: the size grid of two washes
//            (PUT /catalog/prices), the Gold and VIP tiers renamed q4-..., 10% / 15% off, Gold's included wash covering Express
//            Hand Wash with auto-apply on (PUT /catalog/tiers), their prices by size (PUT /catalog/tier-prices); a Gold member on the
//            Compact car plan and a household member
//   s1       a Large SUV visit of the household member: covered up to the Compact car price, the size difference due
//   s2       staff "Send link" -> the personal pay page -> a Square link for the balance, paid in the sandbox through its order
//            (the DRAFT order opened, CreatePayment with cnon:card-nonce-ok); recorded by the Events API catch-up
//   s3       a partial card refund through the API (square.refunds.submit), completed, counted once after a reconcile
//   s4       a #/m join (POST /public/links/membership/subscribe) with a sandbox nonce: active with credits once the first invoice
//            is paid
//   s5       sandbox payments made like counter payments: the invoice number in the note (R1), the amount of a staff "Square
//            reader" entry (R3), nothing to go on (the "to match" queue)
//   s6       a tier price edit: a new Square plan variation, the existing member left on theirs
//   s7       a card saved on #/k, a balance charged from the staff route, a declined nonce
//   s8       (ADR 0172, the item library; needs SQUARE_ITEMS_SYNC_ENABLED=true in the stack) the sales tax set to 6.625% with
//            Square's rounding and Oasis's own Square tax; the item sync makes the items; an Oasis price edit appears at Square in
//            place (same variation); a guest basket (a package at a size and an add-on) priced by Square's CalculateOrder from the
//            catalog lines with the tax auto-applied equals the Oasis invoice to the cent
//   cleanup  subscriptions canceled, cards disabled, links and the run's Square customers deleted (plans stay, named q4-...); the
//            item library objects the run made deleted (items, Oasis's categories and tax; the code itself never deletes)
// The personal links are issued in this process with the backend's own issueClientLink (the texted link is stored masked), with a
// PIN set for the client under the run's pepper (<dir>/pepper.txt), and opened through the real link API. Jobs run in the stack's
// worker: this script queues them (pg-boss) instead of waiting for their cron. The sandbox token is read here from Secrets Manager
// (SANDBOX_SECRET_ID, default oasis/sandbox/square) and never printed; Square ids print as their last four characters.
/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON of the API and of Square */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { sql } from 'kysely'
import { issueClientLink } from '../../src/modules/identity/links.js'
import { pinHasherFromEnv } from '../../src/modules/identity/pin.js'
import { transaction } from '../../src/platform/db.js'
import {
  clock,
  context,
  linkCall,
  loadState,
  must,
  newId,
  red,
  runJob,
  saveState,
  sleep,
  sq,
  sqErr,
  Staff,
  waitFor,
  type Ctx,
} from './lib.js'

const args = process.argv.slice(2)
const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
const step = args[args.length - 1]!
const ctx: Ctx = context(flag('--env')!, flag('--dir')!)
const st = loadState(ctx.dir)
const staff = new Staff(ctx.api, ctx.dir)
const results: string[] = []
const say = (s: string): void => console.log(s)
function verdict(id: string, ok: boolean, text: string): void {
  const line = `${id} ${ok ? 'PASS' : 'FAIL'}: ${text}`
  results.push(line)
  say(line)
}
const $ = (c: number): string => `$${(c / 100).toFixed(2)}`

const PRICES: Record<string, Record<string, number>> = {
  'Express Hand Wash': {
    compact_car: 4000,
    large_car: 4500,
    compact_suv: 5000,
    large_suv: 6000,
    truck: 6500,
  },
  'Premium Hand Wash + Interior': {
    compact_car: 7000,
    large_car: 7500,
    compact_suv: 8000,
    large_suv: 9000,
    truck: 9500,
  },
}
const TIER_PRICES: Record<string, Record<string, number>> = {
  gold: { compact_car: 12900, large_suv: 15900 },
  vip: { compact_car: 19900, large_suv: 22900 },
}
const PHONES = {
  holder: '+12015550171',
  household: '+12015550172',
  guest: '+12015550173',
  joiner: '+12015550174',
  carder: '+12015550175',
}

async function serviceRow(name: string) {
  return ctx.db
    .selectFrom('services')
    .select(['id', 'version', 'name'])
    .where('name', '=', name)
    .executeTakeFirstOrThrow()
}

async function customer(name: string, phone: string): Promise<string> {
  const r = must(
    await staff.post('/customers', { name, phone, smsOptIn: true }, { key: false }),
    [200, 201],
    `customer ${name}`,
  )
  return r.customer.id as string
}

async function invoiceOf(appointmentId: string) {
  return ctx.db
    .selectFrom('invoices')
    .selectAll()
    .where('appointment_id', '=', appointmentId)
    .executeTakeFirstOrThrow()
}

/** A walk-in visit of one service at a size, for a client. */
async function book(
  customerId: string,
  serviceName: string,
  vehicleClass: string,
  plate: string,
): Promise<any> {
  const svc = await serviceRow(serviceName)
  return must(
    await staff.post('/appointments', {
      customer: { id: customerId },
      vehicle: { make: 'Test', model: vehicleClass, plate },
      vehicleClass,
      serviceId: svc.id,
      addonIds: [],
      walkIn: true,
      source: 'walk_in',
      override: { reason: 'Sandbox end-to-end run after hours' },
    }),
    201,
    'book',
  )
}

/** Issues a personal link as staff would, sets a PIN for the client, opens the link and enters the PIN (fresh step-up). */
async function linkSession(
  customerId: string,
  kind: 'pay' | 'membership' | 'card',
  extra: { invoiceId?: string; planKey?: string } = {},
): Promise<string> {
  const locationId = (await ctx.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id
  const pepper = fs.readFileSync(path.join(ctx.dir, 'pepper.txt'), 'utf8')
  const hasher = pinHasherFromEnv({ PIN_PEPPER: pepper })
  const pin = '7391'
  const prev = await ctx.db
    .selectFrom('customer_pins')
    .select('version')
    .where('customer_id', '=', customerId)
    .executeTakeFirst()
  if (!prev)
    await ctx.db
      .insertInto('customer_pins')
      .values({
        customer_id: customerId,
        pin_hash: await hasher.hash(customerId, pin),
        version: 1,
        failed_attempts: 0,
        lock_level: 0,
        locked_until: null,
        set_at: new Date(clock.now().getTime() - 2 * 86_400_000),
        reset_hold_until: null,
        cleared_at: null,
      } as never)
      .execute()
  const link = await transaction(ctx.db, (tx) =>
    issueClientLink(tx, { newId, now: clock.now(), siteUrl: ctx.env.PUBLIC_SITE_URL }, {
      locationId,
      kind,
      customerId,
      issuedBy: 'staff',
      ...extra,
    } as never),
  )
  const ex = await linkCall(ctx.api, 'POST', '/exchange', { body: { token: link.token } })
  if (ex.status !== 200) throw new Error(`exchange ${ex.status} ${JSON.stringify(ex.body).slice(0, 300)}`)
  const session = ex.body.session as string
  const v = await linkCall(ctx.api, 'POST', '/verify/pin', { session, body: { pin } })
  if (v.status !== 200) throw new Error(`verify/pin ${v.status} ${JSON.stringify(v.body).slice(0, 300)}`)
  return session
}

/** The square_payments mirror row of a payment id. */
async function mirror(paymentId: string) {
  return ctx.db
    .selectFrom('square_payments')
    .selectAll()
    .where('square_payment_id', '=', paymentId)
    .executeTakeFirst()
}

async function catchup(): Promise<void> {
  await runJob(ctx, 'square.events.catchup')
}

// ------------------------------------------------------------------------------------------------ steps

async function setup(): Promise<void> {
  const t = must(await staff.post('/integrations/square/test', {}, { key: false }), 200, 'test connection')
  say(
    `test connection: ok=${t.ok} env=${t.environment} location=${red(t.locationId)} merchant=${red(t.merchantId)} checks=${t.checks.map((c: any) => `${c.key}:${c.ok ? 'ok' : 'no'}`).join(',')}`,
  )
  // the catch-up starts at this run (the sandbox location holds other runs' payments of the last day)
  const startedAt = new Date(clock.now().getTime() - 60_000)
  await ctx.db
    .updateTable('square_state')
    .set({ watermark: startedAt } as never)
    .execute()
  st.startedAt = startedAt.toISOString()

  // prices by size through Settings (PUT /catalog/prices)
  const rows = []
  for (const [name, cells] of Object.entries(PRICES)) {
    const s = await serviceRow(name)
    rows.push({
      serviceId: s.id,
      version: s.version,
      cells: Object.entries(cells).map(([cls, cents]) => ({ class: cls, cents })),
    })
  }
  const pr = must(await staff.put('/catalog/prices', { rows }), 200, 'PUT /catalog/prices')
  say(
    `prices saved: ${pr.rows.map((r: any) => `${r.serviceId.slice(-4)} from ${$(r.fromCents)} changed=${r.changed}`).join('; ')}`,
  )

  // tiers: named q4-..., Gold 10% off with Express Hand Wash in its included wash, VIP priced
  const express = await serviceRow('Express Hand Wash')
  let tiers = must(await staff.get('/catalog/tiers'), 200, 'tiers').tiers as any[]
  for (const key of ['gold', 'vip']) {
    const tier = tiers.find((x) => x.key === key)
    const inclusions = tier.inclusions.map((i: any) => ({
      id: i.id,
      label: i.label,
      mode: i.mode,
      perCycle: i.perCycle,
      autoApply: key === 'gold' && i.label === 'Premium wash' ? true : i.autoApply,
      active: i.active,
      serviceIds:
        key === 'gold' && i.label === 'Premium wash'
          ? [...new Set([...i.serviceIds, express.id])]
          : i.serviceIds,
    }))
    const body = {
      name: `q4-${tier.name.replace(/^q4-/, '')}`,
      colour: tier.colour,
      bgColour: tier.bgColour,
      sort: tier.sort,
      active: true,
      public: true,
      vipBooking: tier.vipBooking,
      memberDiscountBp: key === 'gold' ? 1000 : 1500,
      maxVehicles: tier.maxVehicles,
      perks: tier.perks,
      checkoutUrl: null,
      inclusions,
      version: tier.version,
    }
    must(await staff.put(`/catalog/tiers/${key}`, body), 200, `PUT tier ${key}`)
  }
  tiers = must(await staff.get('/catalog/tiers'), 200, 'tiers').tiers as any[]
  const tp = must(
    await staff.put('/catalog/tier-prices', {
      rows: Object.entries(TIER_PRICES).map(([tierKey, cells]) => ({
        tierKey,
        priceVersion: tiers.find((x) => x.key === tierKey).priceVersion,
        cells: Object.entries(cells).map(([cls, monthlyCents]) => ({ class: cls, monthlyCents })),
      })),
    }),
    200,
    'PUT /catalog/tier-prices',
  )
  say(
    `tier prices: ${tp.tiers.map((x: any) => `${x.key} ${x.prices.map((p: any) => `${p.class} ${$(p.monthlyCents)} v${p.priceVersion} ${p.squareState}`).join(', ')}`).join(' | ')}`,
  )

  // the Gold member on the Compact car plan, and a household member
  st.holder = await customer('Hana Holder', PHONES.holder)
  st.household = await customer('Hugo Household', PHONES.household)
  const m = must(
    await staff.post('/memberships', {
      customerId: st.holder,
      planKey: 'gold',
      planClass: 'compact_car',
      planLabel: 'Gold',
    }),
    [200, 201],
    'membership',
  )
  st.goldMembership = m.membership?.id ?? m.id
  const h = must(
    await staff.post(`/memberships/${st.goldMembership}/household`, { customerId: st.household }),
    200,
    'household',
  )
  // a plan the sync made before the tiers were renamed takes the new name (the nightly drift check does this in production)
  await runJob(ctx, 'square.catalog.drift')
  say(
    `gold member: plan ${h.membership.planKey} at ${h.membership.planClass}, household ${h.membership.household.map((x: any) => x.name).join(', ')}`,
  )
  saveState(ctx.dir, st)
}

async function s1(): Promise<void> {
  // a Large SUV visit for the household member of the Gold (Compact car plan) membership; setup turned the included wash's
  // auto-apply on (a Settings choice), so completing the visit settles it by itself
  const express = await serviceRow('Express Hand Wash')
  const q = must(
    await staff.post(
      '/appointments/quote',
      { customerId: st.household, serviceId: express.id, vehicleClass: 'large_suv' },
      { key: false },
    ),
    200,
    'quote',
  )
  const line = q.lines[0]
  say(
    `quote: list ${$(line.listCents)} charge ${$(line.chargeCents)} covered ${line.coverage ? $(line.coverage.coveredCents) : '-'} difference ${line.coverage ? $(line.coverage.differenceCents) : '-'} due ${$(line.dueCents)} basis ${line.basis}`,
  )
  const b = await book(
    st.household,
    'Express Hand Wash',
    'large_suv',
    `Q4L${Date.now().toString(36).slice(-4)}`,
  )
  const id = b.appointment.id as string
  const booked = await ctx.db
    .selectFrom('invoice_items')
    .select(['price_cents', 'list_cents', 'discount_bp'])
    .where('invoice_id', '=', (await invoiceOf(id)).id)
    .executeTakeFirstOrThrow()
  say(
    `booked: line ${$(booked.price_cents)} (list ${$(booked.list_cents ?? 0)}, ${(booked.discount_bp ?? 0) / 100}% off); pricing totals ${JSON.stringify(b.pricing?.totals)}`,
  )
  for (const step of ['arrive', 'start', 'complete'])
    must(await staff.post(`/appointments/${id}/${step}`, {}), [200, 201], step)
  await sleep(2000)
  const inv = await invoiceOf(id)
  const calc = await calcOf(inv.id)
  const adj = await ctx.db
    .selectFrom('ledger_events')
    .select(['type', 'amount_cents', 'reason', 'note'])
    .where('invoice_id', '=', inv.id)
    .execute()
  say(
    `completed INV-${inv.invoice_no}: items ${$(calc.items)} adj ${$(calc.adj)} tax ${$(calc.tax)} balance ${$(calc.balance)}; ledger ${JSON.stringify(adj)}`,
  )
  st.s1Appointment = id
  st.s1Invoice = inv.id
  verdict(
    'S1',
    line.coverage?.coveredCents === 4000 &&
      line.dueCents === 2000 &&
      calc.items === 6000 &&
      calc.adj === -4000 &&
      calc.balance === 2140,
    `Express Hand Wash at Large SUV ($60.00) for the household member of Gold (Compact car plan, 10% off): covered $40.00 (the Compact car price), size difference $20.00 due with no % off; completed invoice ${$(calc.items)} - ${$(-calc.adj)} + tax ${$(calc.tax)} = ${$(calc.balance)} due`,
  )
}

async function calcOf(invoiceId: string): Promise<any> {
  return (await sql<any>`select * from invoice_calc_of(${invoiceId})`.execute(ctx.db)).rows[0]
}

/** Pays a Square payment link's order as Square's checkout page does: the DRAFT order opened, then a card payment on it. */
async function payOrder(
  orderId: string,
  key: string,
): Promise<{ paymentId: string; amount: number; state: string }> {
  const o = await sq('GET', `/orders/${orderId}`)
  if (o.status !== 200) throw new Error(`RetrieveOrder: ${sqErr(o)}`)
  const order = o.body.order
  say(
    `link order ${red(orderId)}: state ${order.state}, total ${$(order.total_money.amount)}, lines ${order.line_items.map((l: any) => `${l.name} ${$(l.total_money.amount)}`).join(' + ')}`,
  )
  if (order.state === 'DRAFT') {
    const u = await sq('PUT', `/orders/${orderId}`, {
      idempotency_key: `${key}-open`,
      order: { location_id: order.location_id, version: order.version, state: 'OPEN' },
    })
    if (u.status !== 200) throw new Error(`UpdateOrder OPEN: ${sqErr(u)}`)
  }
  const p = await sq('POST', '/payments', {
    idempotency_key: `${key}-pay`,
    source_id: 'cnon:card-nonce-ok',
    amount_money: order.total_money,
    order_id: orderId,
    location_id: order.location_id,
    autocomplete: true,
  })
  if (p.status !== 200) throw new Error(`CreatePayment on the order: ${sqErr(p)}`)
  return {
    paymentId: p.body.payment.id,
    amount: p.body.payment.amount_money.amount,
    state: p.body.payment.status,
  }
}

/** Runs the Events API catch-up until check() holds (Square's events show up in SearchEvents a little after the fact). */
async function catchupUntil<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 240_000,
): Promise<T> {
  const t0 = Date.now()
  let runs = 0
  for (;;) {
    await catchup()
    runs++
    const v = await check()
    if (v) {
      say(`  (${what}: after ${runs} catch-up run(s), ${Math.round((Date.now() - t0) / 1000)} s)`)
      return v
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what} (${runs} catch-up runs)`)
    await sleep(8000)
  }
}

async function s2(): Promise<void> {
  const inv = st.s1Invoice as string
  const before = await calcOf(inv)
  const pl = await staff.post(`/invoices/${inv}/payment-links`, { kind: 'balance' })
  say(
    `staff Send link: HTTP ${pl.status} provider=${pl.body?.paymentLink?.provider} url=${pl.body?.paymentLink?.url ?? 'null'} expected ${$(pl.body?.paymentLink?.expectedCents ?? 0)} sms=${JSON.stringify(pl.body?.paymentLink?.sms ?? null).slice(0, 120)}`,
  )
  const staffOk = [200, 201].includes(pl.status)
  // the client opens the personal pay page from the text and pays
  const session = await linkSession(st.household, 'pay', { invoiceId: inv })
  const ps = await linkCall(ctx.api, 'POST', '/pay/start', { session, body: {} })
  say(
    `pay/start: HTTP ${ps.status} status=${ps.body?.status} host=${ps.body?.redirectUrl ? new URL(ps.body.redirectUrl).host : '-'}`,
  )
  const link = await ctx.db
    .selectFrom('payment_links')
    .selectAll()
    .where('invoice_id', '=', inv)
    .where('provider', '=', 'square')
    .orderBy('created_at', 'desc')
    .executeTakeFirstOrThrow()
  say(
    `link row: state ${link.state}, purpose ${link.purpose}, expected ${$(link.expected_cents)}, Square link ${red(link.square_payment_link_id)} order ${red(link.square_order_id)}`,
  )
  const paid = await payOrder(link.square_order_id!, `q4s2-${inv.slice(-8)}`)
  st.s2Payment = paid.paymentId
  say(`sandbox payment ${red(paid.paymentId)}: ${paid.state} ${$(paid.amount)}`)
  const done = await catchupUntil('the invoice paid', async () => {
    const c = await calcOf(inv)
    return c.status === 'paid' ? c : null
  })
  const m = await mirror(paid.paymentId)
  const ev = await ctx.db
    .selectFrom('ledger_events')
    .select(['type', 'amount_cents', 'source', 'processor', 'processor_state', 'processor_ref'])
    .where('invoice_id', '=', inv)
    .where('type', '=', 'pay')
    .execute()
  const linkAfter = await ctx.db
    .selectFrom('payment_links')
    .select(['state', 'paid_square_payment_id'])
    .where('id', '=', link.id)
    .executeTakeFirstOrThrow()
  say(
    `mirror: classification ${m?.classification} match ${m?.match_state} rule ${m?.rule}; pay events ${JSON.stringify(ev.map((e) => ({ ...e, processor_ref: red(e.processor_ref) })))}; link ${linkAfter.state}`,
  )
  verdict(
    'S2',
    staffOk &&
      ps.body?.status === 'redirect' &&
      done.status === 'paid' &&
      ev.length === 1 &&
      ev[0]!.amount_cents === before.balance &&
      linkAfter.state === 'paid',
    `staff link (${pl.body?.paymentLink?.provider}) -> pay page -> Square link for exactly ${$(before.balance)} paid in the sandbox through its order; the catch-up recorded one pay of ${$(ev[0]?.amount_cents ?? 0)} (${ev[0]?.processor}/${ev[0]?.processor_state}), invoice ${done.status}, link ${linkAfter.state}`,
  )
}

async function s3(): Promise<void> {
  const inv = st.s1Invoice as string
  const r = must(
    await staff.post(`/invoices/${inv}/refunds`, {
      mode: 'custom',
      amountCents: 1000,
      dest: 'card',
      reason: 'Sandbox end-to-end partial refund',
    }),
    [200, 201],
    'refund',
  )
  const evId = r.event?.id as string
  say(
    `refund requested: ${r.event?.status} ${$(-(r.event?.amountCents ?? 0))} processor=${r.event?.processor} state=${r.event?.processorState}`,
  )
  await runJob(ctx, 'square.refunds.submit')
  const legs = await waitFor(
    'a refund leg sent',
    async () => {
      const l = await ctx.db
        .selectFrom('square_refund_legs')
        .selectAll()
        .where('ledger_event_id', '=', evId)
        .execute()
      return l.length && l.every((x) => x.square_refund_id) ? l : null
    },
    60_000,
  )
  say(
    `legs: ${legs.map((l) => `${$(l.amount_cents)} on ${red(l.square_payment_id)} refund ${red(l.square_refund_id)} ${l.state}`).join('; ')}`,
  )
  const done = await catchupUntil('the refund leg completed', async () => {
    const e = await ctx.db
      .selectFrom('ledger_events')
      .select(['processor_state', 'processor_ref'])
      .where('id', '=', evId)
      .executeTakeFirstOrThrow()
    return e.processor_state === 'confirmed' ? e : null
  })
  const legsAfter = await ctx.db
    .selectFrom('square_refund_legs')
    .select(['state', 'square_refund_id'])
    .where('ledger_event_id', '=', evId)
    .execute()
  // the nightly reconcile reads the same refund again: nothing more may count
  await runJob(ctx, 'square.reconcile')
  await catchup()
  const c = await calcOf(inv)
  const refunds = await ctx.db
    .selectFrom('ledger_events')
    .select(['id', 'amount_cents', 'processor_state', 'processor_ref'])
    .where('invoice_id', '=', inv)
    .where('type', '=', 'refund')
    .execute()
  const sqPay = await sq('GET', `/payments/${st.s2Payment}`)
  const atSquare = sqPay.body?.payment?.refunded_money?.amount ?? 0
  say(
    `after: legs ${legsAfter.map((l) => l.state).join(',')}; refund rows ${refunds.length} (${refunds.map((x) => `${$(Math.abs(x.amount_cents))} ${x.processor_state} ${red(x.processor_ref)}`).join('; ')}); calc refunded ${$(c.refunded)} status ${c.status}; Square says refunded ${$(atSquare)}`,
  )
  verdict(
    'S3',
    done.processor_state === 'confirmed' &&
      legsAfter.every((l) => l.state === 'completed') &&
      refunds.length === 1 &&
      c.refunded === 1000 &&
      atSquare === 1000,
    `a $10.00 card refund went out through the API (${legs.length} leg), completed at Square and confirmed by the catch-up; after a reconcile and another catch-up it counts once: refunded ${$(c.refunded)} (Square ${$(atSquare)}), invoice ${c.status}`,
  )
  st.s3Refund = evId
}

async function s4(): Promise<void> {
  if (st.s4Membership) return s4check()
  const sync = must(
    await staff.post('/integrations/square/catalog/sync', {}, { key: false }),
    200,
    'catalog sync',
  )
  say(`catalog sync: ${JSON.stringify(sync)}`)
  const tiers = must(await staff.get('/catalog/tiers'), 200, 'tiers').tiers as any[]
  const gold = tiers.find((x) => x.key === 'gold')
  say(
    `gold: plan ${red(gold.squarePlanId)} prices ${gold.prices.map((p: any) => `${p.class} ${$(p.monthlyCents)} ${p.squareState}`).join(', ')}`,
  )
  st.joiner = st.joiner ?? (await customer('Jada Joiner', PHONES.joiner))
  const session = await linkSession(st.joiner, 'membership', { planKey: 'gold' })
  const me = await linkCall(ctx.api, 'GET', '/me', { session })
  const plan = me.body?.plan
  say(
    `#/m page: tier ${plan?.key} billing ${plan?.billing} joinable sizes ${(plan?.prices ?? [])
      .filter((p: any) => p.joinable)
      .map((p: any) => `${p.class} ${$(p.monthlyCents)}`)
      .join(', ')} consent ${me.body?.cardSetup?.consent?.version ?? me.body?.consent?.version ?? '?'}`,
  )
  const email = `q4-e2e-${Date.now().toString(36)}@oasisautospanj.com`
  const sub = await linkCall(ctx.api, 'POST', '/membership/subscribe', {
    session,
    key: `q4-sub-${crypto.randomUUID()}`,
    body: {
      email,
      planClass: 'compact_car',
      sourceId: 'cnon:card-nonce-ok',
      consentVersion: 'v1',
      cardholderName: 'Jada Joiner',
      postalCode: '07026',
    },
  })
  say(`subscribe: HTTP ${sub.status} ${JSON.stringify(sub.body).slice(0, 300)}`)
  if (sub.status !== 202) {
    verdict('S4', false, `membership/subscribe answered ${sub.status} ${sub.body?.code ?? ''}`)
    return
  }
  const t0 = Date.now()
  const active = await catchupUntil(
    'the membership active',
    async () => {
      await runJob(ctx, 'square.enrollments.resume')
      const r = await linkCall(ctx.api, 'GET', '/membership/status', { session })
      return r.body?.status === 'active' || r.body?.status === 'failed' ? r.body : null
    },
    300_000,
  )
  const enr = await ctx.db
    .selectFrom('square_enrollments')
    .selectAll()
    .where('customer_id', '=', st.joiner)
    .orderBy('created_at', 'desc')
    .executeTakeFirstOrThrow()
  const mem = await ctx.db
    .selectFrom('memberships')
    .selectAll()
    .where('customer_id', '=', st.joiner)
    .orderBy('created_at', 'desc')
    .executeTakeFirstOrThrow()
  const invs = await ctx.db
    .selectFrom('square_subscription_invoices')
    .selectAll()
    .where('membership_id', '=', mem.id)
    .execute()
  const credits = await ctx.db
    .selectFrom('membership_credit_events' as never)
    .selectAll()
    .where('membership_id' as never, '=', mem.id as never)
    .execute()
    .catch(() => [] as any[])
  const view = must(await staff.get(`/customers/${st.joiner}/membership`), 200, 'membership view')
  const sub2 = await sq('GET', `/subscriptions/${mem.square_subscription_id}`)
  st.s4Membership = mem.id
  st.s4Subscription = mem.square_subscription_id
  st.s4Customer = enr.square_customer_id
  st.s4Variation = sub2.body?.subscription?.plan_variation_id
  st.s4TierPrice = mem.tier_price_id
  say(
    `status ${active.status} after ${Math.round((Date.now() - t0) / 1000)} s; enrollment ${enr.state}; membership ${mem.status}/${mem.square_status}/${mem.billing_status} period ${mem.current_period_start?.toISOString?.() ?? mem.current_period_start}..${mem.current_period_end?.toISOString?.() ?? mem.current_period_end}; subscription ${red(mem.square_subscription_id)} ${sub2.body?.subscription?.status} variation ${red(st.s4Variation)}; invoices ${invs.map((i) => `${i.status} ${$(i.amount_cents)} applied ${!!i.applied_at}`).join('; ')}; credit events ${credits.length}; credits ${JSON.stringify(view.membership?.credits ?? view.credits ?? null).slice(0, 300)}`,
  )
  const creditRows = (view.membership?.credits?.rules ?? []) as any[]
  verdict(
    'S4',
    active.status === 'active' &&
      mem.status === 'active' &&
      invs.some((i) => i.status === 'PAID' || i.status === 'paid') &&
      creditRows.some((c) => (c.left ?? 0) > 0 || c.left === null),
    `#/m join (Compact car, ${$(enr.monthly_cents)}/month) with cnon:card-nonce-ok and ${email.replace(/^[^@]+/, 'q4-e2e-…')}: ${active.status}; first invoice ${invs.map((i) => i.status).join(',')}; credits ${creditRows.map((c) => `${c.label ?? c.rule}: ${c.left ?? 'unlimited'} left`).join(', ')}`,
  )
}

async function s4check(): Promise<void> {
  const mem = await ctx.db
    .selectFrom('memberships')
    .selectAll()
    .where('id', '=', st.s4Membership)
    .executeTakeFirstOrThrow()
  const enr = await ctx.db
    .selectFrom('square_enrollments')
    .selectAll()
    .where('membership_id', '=', mem.id)
    .executeTakeFirstOrThrow()
  const invs = await ctx.db
    .selectFrom('square_subscription_invoices')
    .selectAll()
    .where('membership_id', '=', mem.id)
    .execute()
  const view = must(await staff.get(`/customers/${st.joiner}/membership`), 200, 'membership view')
  const sub = await sq('GET', `/subscriptions/${mem.square_subscription_id}`)
  const rules = (view.membership?.credits?.rules ?? []) as any[]
  say(
    `membership ${mem.status}/${mem.square_status}/${mem.billing_status}; enrollment ${enr.state}; Square subscription ${red(mem.square_subscription_id)} ${sub.body?.subscription?.status} charged through ${sub.body?.subscription?.charged_through_date}; invoices ${invs.map((i) => `${i.status} ${$(i.amount_cents)} applied ${!!i.applied_at}`).join('; ')}`,
  )
  verdict(
    'S4',
    mem.status === 'active' &&
      enr.state === 'active' &&
      invs.length === 1 &&
      !!invs[0]!.applied_at &&
      rules.some((r) => r.left > 0),
    `#/m join on the link API (Compact car, ${$(enr.monthly_cents)}/month, cnon:card-nonce-ok, an @oasisautospanj.com address): Square subscription ${sub.body?.subscription?.status}, first invoice ${invs.map((i) => i.status).join(',')} applied once, membership ${mem.status} with credits ${rules.map((r) => `${r.label} ${r.left}/${r.granted}`).join(', ')}`,
  )
}

async function counterPayment(cents: number, note: string | null, key: string): Promise<string> {
  const p = await sq('POST', '/payments', {
    idempotency_key: key,
    source_id: 'cnon:card-nonce-ok',
    amount_money: { amount: cents, currency: 'USD' },
    location_id: ctx.env.SQUARE_LOCATION_ID,
    autocomplete: true,
    ...(note ? { note } : {}),
  })
  if (p.status !== 200) throw new Error(`CreatePayment: ${sqErr(p)}`)
  return p.body.payment.id as string
}

async function completedVisit(
  customerId: string,
  plate: string,
  service = 'Express Hand Wash',
): Promise<{ appointmentId: string; invoiceId: string; invoiceNo: number; balance: number }> {
  const b = await book(customerId, service, 'compact_car', plate)
  const id = b.appointment.id as string
  for (const step of ['arrive', 'start', 'complete'])
    must(await staff.post(`/appointments/${id}/${step}`, {}), [200, 201], step)
  const inv = await invoiceOf(id)
  const c = await calcOf(inv.id)
  return { appointmentId: id, invoiceId: inv.id, invoiceNo: Number(inv.invoice_no), balance: c.balance }
}

async function s5(): Promise<void> {
  st.guest = st.guest ?? (await customer('Gina Guest', PHONES.guest))
  const tag = Date.now().toString(36)
  // R1: the invoice number in the POS note
  const v1 = await completedVisit(st.guest, `Q4A${tag.slice(-4)}`)
  // R3: staff tapped "Square reader" for the balance, the reader took it (no note)
  const v3 = await completedVisit(st.guest, `Q4B${tag.slice(-4)}`, 'Premium Hand Wash + Interior')
  const tender = must(
    await staff.post(`/invoices/${v3.invoiceId}/payments`, { method: 'card' }),
    [200, 201],
    'Square reader tender',
  )
  const awaitingId = tender.event?.id as string
  const p1 = await counterPayment(v1.balance, `INV-${v1.invoiceNo} counter`, `q4s5-r1-${tag}`)
  const p3 = await counterPayment(v3.balance, null, `q4s5-r3-${tag}`)
  // R5: nothing to go on
  const p5 = await counterPayment(1234, null, `q4s5-r5-${tag}`)
  say(
    `counter payments: R1 ${red(p1)} ${$(v1.balance)} note INV-${v1.invoiceNo}; R3 ${red(p3)} ${$(v3.balance)} (awaiting entry); none ${red(p5)} $12.34`,
  )
  await catchupUntil('the three payments mirrored', async () => {
    const rows = await ctx.db
      .selectFrom('square_payments')
      .select('square_payment_id')
      .where('square_payment_id', 'in', [p1, p3, p5])
      .execute()
    return rows.length === 3
  })
  await sleep(12_000) // SQUARE_MATCH_DELAY_SECONDS=10
  await runJob(ctx, 'square.payments.match')
  await sleep(2000)
  const rows = await ctx.db
    .selectFrom('square_payments')
    .select(['square_payment_id', 'classification', 'match_state', 'rule', 'invoice_id'])
    .where('square_payment_id', 'in', [p1, p3, p5])
    .execute()
  const by = (id: string) => rows.find((r) => r.square_payment_id === id)!
  const c1 = await calcOf(v1.invoiceId)
  const ev3 = await ctx.db
    .selectFrom('ledger_events')
    .select(['processor_state', 'processor_ref', 'brand', 'last4'])
    .where('id', '=', awaitingId)
    .executeTakeFirstOrThrow()
  const pays3 = await ctx.db
    .selectFrom('ledger_events')
    .select('id')
    .where('invoice_id', '=', v3.invoiceId)
    .where('type', '=', 'pay')
    .execute()
  const queue = must(await staff.get('/payments/square/unmatched'), 200, 'unmatched').items as any[]
  const inQueue = queue.map((q) => q.paymentId as string)
  const mem = st.s4Membership
    ? await ctx.db
        .selectFrom('square_payments')
        .select(['classification', 'match_state'])
        .where(
          'square_order_id',
          'in',
          (
            await ctx.db
              .selectFrom('square_subscription_invoices')
              .select('square_order_id')
              .where('membership_id', '=', st.s4Membership)
              .execute()
          )
            .map((x) => x.square_order_id!)
            .filter(Boolean)
            .concat(['-']),
        )
        .execute()
    : []
  say(
    `R1 ${by(p1).classification}/${by(p1).match_state}/${by(p1).rule} -> invoice ${by(p1).invoice_id === v1.invoiceId ? 'right' : by(p1).invoice_id}; invoice ${c1.status}`,
  )
  say(
    `R3 ${by(p3).classification}/${by(p3).match_state}/${by(p3).rule}; awaiting entry now ${ev3.processor_state} ${ev3.brand ?? ''} ••${ev3.last4 ?? ''} ref ${red(ev3.processor_ref)}; pay rows on that invoice ${pays3.length}`,
  )
  say(
    `none ${by(p5).classification}/${by(p5).match_state}/${by(p5).rule}; queue holds it: ${inQueue.includes(p5)}; queue size ${queue.length}; membership payment rows ${JSON.stringify(mem)} (in queue: ${queue.some((q) => q.product === 'INVOICES' || q.classification === 'membership')})`,
  )
  verdict(
    'S5',
    by(p1).match_state === 'matched' &&
      by(p1).rule === 'R1' &&
      by(p1).invoice_id === v1.invoiceId &&
      c1.status === 'paid',
    `a sandbox payment with "INV-${v1.invoiceNo}" in its note was recorded on that invoice by rule ${by(p1).rule} (invoice ${c1.status})`,
  )
  verdict(
    'S5b',
    by(p3).match_state === 'matched' && ev3.processor_state === 'confirmed' && pays3.length === 1,
    `a sandbox payment of the amount of a staff "Square reader" entry confirmed that entry (rule ${by(p3).rule}, ${ev3.processor_state}, one pay row)`,
  )
  verdict(
    'S5c',
    by(p5).match_state === 'unmatched' && inQueue.includes(p5) && !by(p5).invoice_id,
    `a sandbox payment with nothing to go on waits in "Square payments to match" (${by(p5).match_state}, no invoice)`,
  )
  st.s5 = { r1: { ...v1, payment: p1 }, r3: { ...v3, awaitingId, payment: p3 }, none: p5 }
}

async function s6(): Promise<void> {
  const planObj = async (id: string) =>
    (await sq('GET', `/catalog/object/${id}?include_related_objects=false`)).body?.object
  const tiers = must(await staff.get('/catalog/tiers'), 200, 'tiers').tiers as any[]
  const gold = tiers.find((x) => x.key === 'gold')
  const plan = await planObj(gold.squarePlanId)
  say(`Square plan ${red(gold.squarePlanId)} named "${plan?.subscription_plan_data?.name}"`)
  const oldRow = await ctx.db
    .selectFrom('membership_tier_prices')
    .selectAll()
    .where('id', '=', st.s4TierPrice)
    .executeTakeFirstOrThrow()
  const edit = must(
    await staff.put('/catalog/tier-prices', {
      rows: [
        {
          tierKey: 'gold',
          priceVersion: gold.priceVersion,
          cells: [{ class: 'compact_car', monthlyCents: 13900 }],
        },
      ],
    }),
    200,
    'PUT tier price',
  )
  say(`edit: ${JSON.stringify(edit.changed)}`)
  const sync = must(
    await staff.post('/integrations/square/catalog/sync', {}, { key: false }),
    200,
    'catalog sync',
  )
  say(`sync: ${JSON.stringify(sync)}`)
  const rows = await ctx.db
    .selectFrom('membership_tier_prices')
    .selectAll()
    .where('plan_id', '=', oldRow.plan_id)
    .where('class_key', '=', 'compact_car')
    .orderBy('price_version')
    .execute()
  const newRow = rows[rows.length - 1]!
  const newVar = newRow.square_variation_id ? await planObj(newRow.square_variation_id) : null
  const oldVar = await planObj(oldRow.square_variation_id!)
  const mem = await ctx.db
    .selectFrom('memberships')
    .select(['tier_price_id', 'status'])
    .where('id', '=', st.s4Membership)
    .executeTakeFirstOrThrow()
  const sub = (await sq('GET', `/subscriptions/${st.s4Subscription}`)).body?.subscription
  const price = (v: any) =>
    v?.subscription_plan_variation_data?.phases?.[0]?.pricing?.price_money?.amount ??
    v?.subscription_plan_variation_data?.phases?.[0]?.recurring_price_money?.amount
  say(
    `rows: ${rows.map((r) => `v${r.price_version} ${$(r.monthly_cents)} ${r.square_state} ${red(r.square_variation_id)} ${r.superseded_at ? 'superseded' : 'current'}`).join('; ')}`,
  )
  say(
    `Square: new variation ${red(newRow.square_variation_id)} "${newVar?.subscription_plan_variation_data?.name}" ${$(price(newVar) ?? 0)}; old ${red(oldRow.square_variation_id)} still there: ${!!oldVar && !oldVar.is_deleted} ${$(price(oldVar) ?? 0)}; member's subscription on ${red(sub?.plan_variation_id)} (${sub?.status}); member's price row ${mem.tier_price_id === oldRow.id ? 'unchanged' : 'MOVED'}`,
  )
  verdict(
    'S6',
    newRow.id !== oldRow.id &&
      newRow.monthly_cents === 13900 &&
      newRow.square_state === 'synced' &&
      !!newRow.square_variation_id &&
      newRow.square_variation_id !== oldRow.square_variation_id &&
      price(newVar) === 13900 &&
      sub?.plan_variation_id === oldRow.square_variation_id &&
      mem.tier_price_id === oldRow.id,
    `Gold Compact car $129.00 -> $139.00: a new Square variation ${red(newRow.square_variation_id)} at ${$(price(newVar) ?? 0)}; the member stays on ${red(oldRow.square_variation_id)} at $129.00 (subscription and price row untouched)`,
  )
}

async function s7(): Promise<void> {
  st.carder = st.carder ?? (await customer('Cara Carder', PHONES.carder))
  const session = await linkSession(st.carder, 'card')
  const me = await linkCall(ctx.api, 'GET', '/me', { session })
  const setup = me.body?.cardSetup
  say(
    `#/k page: application ${setup?.square?.applicationId ? 'set' : 'missing'} location ${red(setup?.square?.locationId)} env ${setup?.square?.environment} sdk ${setup?.square?.sdkUrl ? new URL(setup.square.sdkUrl).host : '-'} consent ${setup?.consent?.version} checkedByDefault ${setup?.consent?.checkedByDefault}`,
  )
  const save = await linkCall(ctx.api, 'POST', '/cards', {
    session,
    key: `q4-card-${crypto.randomUUID()}`,
    body: {
      sourceId: 'cnon:card-nonce-ok',
      consentVersion: setup?.consent?.version ?? 'v1',
      purposes: ['balance', 'no_show_fee'],
      cardholderName: 'Cara Carder',
      postalCode: '07026',
    },
  })
  say(`save card: HTTP ${save.status} ${JSON.stringify(save.body).slice(0, 300)}`)
  const cards = must(await staff.get(`/customers/${st.carder}/cards`), 200, 'cards')
  const card = (cards.cards as any[]).find((c) => c.state === 'active')
  say(
    `staff sees: ${(cards.cards as any[]).map((c) => `${c.label} ${c.state} purposes ${c.purposes.join('/')} consents ${c.consents.length}`).join('; ')}; charge tender offered: ${cards.charge}`,
  )
  const v = await completedVisit(st.carder, `Q4K${Date.now().toString(36).slice(-4)}`)
  // too much first: refused, nothing charged
  const over = await staff.post(`/invoices/${v.invoiceId}/card-charges`, {
    cardId: card?.id,
    amountCents: v.balance + 100,
  })
  const charge = await staff.post(`/invoices/${v.invoiceId}/card-charges`, {
    cardId: card?.id,
    amountCents: v.balance,
  })
  say(
    `charge over the balance: HTTP ${over.status} ${over.body?.code}; charge ${$(v.balance)}: HTTP ${charge.status} state ${charge.body?.charge?.state} payment ${red(charge.body?.charge?.squarePaymentId)}`,
  )
  const c = await calcOf(v.invoiceId)
  const pays = await ctx.db
    .selectFrom('ledger_events')
    .select(['amount_cents', 'processor', 'processor_state', 'reason'])
    .where('invoice_id', '=', v.invoiceId)
    .where('type', '=', 'pay')
    .execute()
  // the webhook-less path: the catch-up sees the same payment and must not record it again
  await catchup()
  await sleep(12_000)
  await runJob(ctx, 'square.payments.match')
  const pays2 = await ctx.db
    .selectFrom('ledger_events')
    .select('id')
    .where('invoice_id', '=', v.invoiceId)
    .where('type', '=', 'pay')
    .execute()
  const m = charge.body?.charge?.squarePaymentId ? await mirror(charge.body.charge.squarePaymentId) : null
  say(
    `invoice ${c.status} paid ${$(c.paid)}; pay rows ${pays.length} -> after catch-up ${pays2.length} (${JSON.stringify(pays)}); mirror ${m?.classification}/${m?.match_state}`,
  )
  verdict(
    'S7',
    save.status === 201 &&
      !!card &&
      over.status === 422 &&
      charge.status === 201 &&
      charge.body?.charge?.state === 'charged' &&
      c.status === 'paid' &&
      pays2.length === 1,
    `card saved on #/k with cnon:card-nonce-ok (${card?.label}, consent ${card?.purposes?.join('/')}); staff charge of ${$(v.balance)} confirmed -> charged, invoice ${c.status}, one pay row after the catch-up read the same payment; over-balance charge refused (${over.body?.code})`,
  )
  // decline path: Square refuses the card at save time
  const dec = await linkCall(ctx.api, 'POST', '/cards', {
    session,
    key: `q4-card-${crypto.randomUUID()}`,
    body: {
      sourceId: 'cnon:card-nonce-declined',
      consentVersion: setup?.consent?.version ?? 'v1',
      purposes: ['balance'],
      postalCode: '07026',
    },
  })
  const cardsAfter = must(await staff.get(`/customers/${st.carder}/cards`), 200, 'cards').cards as any[]
  say(
    `declined nonce: HTTP ${dec.status} ${dec.body?.code} "${dec.body?.detail}"; cards now ${cardsAfter.length}`,
  )
  verdict(
    'S7b',
    dec.status === 422 && dec.body?.code === 'CARD_DECLINED' && cardsAfter.length === 1,
    `cnon:card-nonce-declined on #/k: ${dec.status} ${dec.body?.code} ("${dec.body?.detail}"), nothing saved`,
  )
  st.s7 = { card: card?.id, invoice: v.invoiceId }
}

/** The Square item of a service, as the item sync linked it (sandbox), read back from Square. */
async function squareItemOf(serviceName: string): Promise<any> {
  const svc = await serviceRow(serviceName)
  const link = await ctx.db
    .selectFrom('square_catalog_links')
    .select(['square_object_id', 'state'])
    .where('kind', '=', 'item')
    .where('service_id', '=', svc.id)
    .where('environment', '=', 'sandbox')
    .executeTakeFirst()
  if (!link?.square_object_id) return null
  return (await sq('GET', `/catalog/object/${link.square_object_id}`)).body?.object ?? null
}

const variationNamed = (item: any, name: string): any => (item?.item_data?.variations ?? []).find((v: any) => v.item_variation_data?.name === name)

async function s8(): Promise<void> {
  // Oasis at New Jersey's 6.625%, rounded like Square (ADR 0173 rollout), and Oasis's own Square tax (the sandbox's may differ)
  const billing = must(await staff.get('/settings/billing'), 200, 'billing')
  must(await staff.put('/settings/billing/sales-tax', { percent: '6.625', rounding: 'half_even', version: billing.salesTax.version }, { key: false }), 200, 'sales tax')
  const items0 = must(await staff.get('/integrations/square/items'), 200, 'items view')
  must(await staff.put('/integrations/square/items/tax', { mode: 'create', version: items0.version }, { key: false }), 200, 'items tax')
  const rows = []
  for (const [name, cells] of Object.entries(PRICES)) {
    const s = await serviceRow(name)
    rows.push({ serviceId: s.id, version: s.version, cells: Object.entries(cells).map(([cls, cents]) => ({ class: cls, cents })) })
  }
  must(await staff.put('/catalog/prices', { rows }), 200, 'PUT /catalog/prices')
  const t = must(await staff.post('/integrations/square/test', {}, { key: false }), 200, 'test connection')
  say(`test connection: ${t.checks.map((c: any) => `${c.key}:${c.ok ? 'ok' : 'no'}`).join(',')}; tax: ${t.checks.find((c: any) => c.key === 'tax')?.detail ?? '-'}`)
  await runJob(ctx, 'square.items.sync')
  const view = must(await staff.get('/integrations/square/items'), 200, 'items view')
  say(`items: mode ${view.mode}, tax ${view.taxCheck?.status} (${view.taxCheck?.detail}), on Square ${view.counts.onSquare}, waiting ${view.counts.waiting}, failed ${view.counts.failed}${view.failures.length ? `: ${view.failures.map((f: any) => `${f.service}: ${f.error}`).join('; ')}` : ''}`)
  const before = await squareItemOf('Express Hand Wash')
  const v0 = variationNamed(before, 'Large SUV')
  verdict(
    'S8a',
    !!v0 && v0.item_variation_data?.price_money?.amount === PRICES['Express Hand Wash']!.large_suv && view.counts.failed === 0,
    `the item sync made Express Hand Wash at Square (${(before?.item_data?.variations ?? []).map((v: any) => `${v.item_variation_data?.name} ${v.item_variation_data?.price_money ? $(v.item_variation_data.price_money.amount) : 'variable'}`).join(', ')}), ${view.counts.onSquare} service(s) on Square`,
  )
  // an Oasis price edit: the same Square variation, the new price
  const express = await serviceRow('Express Hand Wash')
  must(await staff.put('/catalog/prices', { rows: [{ serviceId: express.id, version: express.version, cells: [{ class: 'large_suv', cents: 6500 }] }] }), 200, 'price edit')
  await runJob(ctx, 'square.items.sync')
  const after = await squareItemOf('Express Hand Wash')
  const v1 = variationNamed(after, 'Large SUV')
  verdict(
    'S8b',
    !!v0 && v1?.id === v0.id && v1?.item_variation_data?.price_money?.amount === 6500 && Number(v1?.version) > Number(v0?.version),
    `an Oasis price edit ($60 to $65, Large SUV) appeared at Square in place: variation ${red(v1?.id)} (was ${red(v0?.id)}), version ${v0?.version} to ${v1?.version}`,
  )
  // a guest basket: Express Hand Wash at Large SUV and an add-on, against Square's own pricing of the same catalog lines
  const guest = await customer('Gina Guest Items', '+12015550176')
  const addon = await ctx.db.selectFrom('services').select(['id', 'name', 'price_cents']).where('kind', '=', 'addon').where('active', '=', true).where('price_cents', '>', 0).orderBy('sort').limit(1).executeTakeFirstOrThrow()
  const visit = must(
    await staff.post('/appointments', {
      customer: { id: guest },
      vehicle: { make: 'Test', model: 'large_suv', plate: 'ITEMS1' },
      vehicleClass: 'large_suv',
      serviceId: express.id,
      addonIds: [addon.id],
      walkIn: true,
      source: 'walk_in',
      override: { reason: 'Sandbox end-to-end run after hours' },
    }),
    201,
    'book the guest basket',
  )
  const inv = await invoiceOf(visit.appointment.id)
  const calc = await calcOf(inv.id)
  const addonItem = await squareItemOf(addon.name)
  const regular = variationNamed(addonItem, 'Regular')
  const order = await sq('POST', '/orders/calculate', {
    order: {
      location_id: ctx.env.SQUARE_LOCATION_ID,
      pricing_options: { auto_apply_taxes: true },
      line_items: [
        { quantity: '1', catalog_object_id: v1?.id },
        { quantity: '1', catalog_object_id: regular?.id },
      ],
    },
  })
  const squareTotal = order.body?.order?.total_money?.amount
  const squareTax = order.body?.order?.total_tax_money?.amount
  verdict(
    'S8c',
    order.status === 200 && Number(calc.total) === squareTotal && Number(calc.tax) === squareTax && inv.tax_dbp === 6625 && inv.tax_rounding === 'half_even',
    `a guest basket (Express Hand Wash at Large SUV ${$(6500)} + ${addon.name} ${$(addon.price_cents)}): Oasis invoice ${$(Number(calc.total))} (tax ${$(Number(calc.tax))} at ${inv.tax_dbp / 1000}% ${inv.tax_rounding}), Square CalculateOrder of the catalog lines ${order.status === 200 ? `${$(squareTotal)} (tax ${$(squareTax)})` : sqErr(order)}`,
  )
  saveState(ctx.dir, st)
}

async function cleanup(): Promise<void> {
  const out: string[] = []
  // the item library objects the item sync made in the sandbox (ADR 0172): items first (their variations go with them), then
  // Oasis's own categories and tax; adopted ones are the sandbox's own and stay
  const made = await ctx.db
    .selectFrom('square_catalog_links')
    .select(['kind', 'square_object_id'])
    .where('environment', '=', 'sandbox')
    .where('adopted', '=', false)
    .where('square_object_id', 'is not', null)
    .execute()
  for (const kind of ['item', 'category', 'tax'] as const) {
    const ids = made.filter((l) => l.kind === kind).map((l) => l.square_object_id!)
    let deleted = 0
    for (const id of ids) if ((await sq('DELETE', `/catalog/object/${id}`)).status === 200) deleted++
    if (ids.length) out.push(`item library ${{ item: 'items', category: 'categories', tax: 'taxes' }[kind]}: ${deleted} of ${ids.length} deleted`)
  }
  // memberships billed by Square: canceled through the staff action (Square cancels at the period end)
  const mems = await ctx.db
    .selectFrom('memberships')
    .select(['id', 'square_subscription_id'])
    .where('square_subscription_id', 'is not', null)
    .execute()
  for (const m of mems) {
    const r = await staff.post(`/memberships/${m.id}/billing/cancel`, {})
    const sub = (await sq('GET', `/subscriptions/${m.square_subscription_id}`)).body?.subscription
    out.push(
      `subscription ${red(m.square_subscription_id)}: staff cancel HTTP ${r.status} ${r.body?.code ?? ''} cancelAt ${r.body?.membership?.billing?.cancelAt ?? '-'}; Square ${sub?.status} canceled_date ${sub?.canceled_date ?? '-'}`,
    )
  }
  // saved cards: removed through the staff route (DisableCard at Square)
  const cards = await ctx.db
    .selectFrom('customer_cards')
    .select(['id', 'customer_id', 'square_card_id', 'state'])
    .where('state', '=', 'active')
    .execute()
  for (const c of cards) {
    const r = await staff.del(`/customers/${c.customer_id}/cards/${c.id}`)
    const at = (await sq('GET', `/cards/${c.square_card_id}`)).body?.card
    out.push(
      `card ${red(c.square_card_id)}: staff remove HTTP ${r.status} ${r.body?.code ?? r.body?.state ?? ''}; Square enabled=${at?.enabled}`,
    )
  }
  // payment links not yet deleted at Square
  const links = await ctx.db
    .selectFrom('payment_links')
    .select(['id', 'square_payment_link_id', 'state', 'square_deleted_at'])
    .where('square_payment_link_id', 'is not', null)
    .execute()
  for (const l of links) {
    if (l.square_deleted_at) {
      out.push(`link ${red(l.square_payment_link_id)}: already deleted by the sweep (${l.state})`)
      continue
    }
    const r = await sq('DELETE', `/online-checkout/payment-links/${l.square_payment_link_id}`)
    out.push(
      `link ${red(l.square_payment_link_id)} (${l.state}): DeletePaymentLink ${r.status === 200 ? 'ok' : sqErr(r)}`,
    )
  }
  // the Square customers this run made
  const custs = await ctx.db.selectFrom('square_customer_links').select('square_customer_id').execute()
  for (const c of custs) {
    const r = await sq('DELETE', `/customers/${c.square_customer_id}`)
    out.push(`customer ${red(c.square_customer_id)}: DeleteCustomer ${r.status === 200 ? 'ok' : sqErr(r)}`)
  }
  const plans = await ctx.db
    .selectFrom('membership_plans')
    .select(['name', 'square_plan_id'])
    .where('square_plan_id', 'is not', null)
    .execute()
  out.push(`plans kept at Square: ${plans.map((p) => `"${p.name}" ${red(p.square_plan_id)}`).join(', ')}`)
  for (const l of out) say(l)
}

async function main(): Promise<void> {
  await staff.login()
  const steps: Record<string, () => Promise<void>> = { setup, s1, s2, s3, s4, s5, s6, s7, s8, cleanup }
  const fn = steps[step]
  if (!fn) throw new Error(`unknown step ${step}`)
  try {
    await fn()
  } finally {
    saveState(ctx.dir, st)
    fs.appendFileSync(path.join(ctx.dir, 'results.txt'), results.map((l) => `${l}\n`).join(''))
    await ctx.db.destroy()
  }
}

main().catch((e: unknown) => {
  console.error(`driver ${step}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exitCode = 1
})
