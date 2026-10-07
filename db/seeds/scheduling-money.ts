// The money half of the "parity-ops" design day: one invoice per design appointment (through the real payments gateway,
// so numbers continue the gap-free counter and the lines are the appointment's package and add-ons), the tips and the
// payments the Operations design shows (PARITY_OPS_MONEY: paid in full, a deposit, or unpaid), and the design's members.
// Without this the seeded board has no invoices ("No invoice" everywhere, Pending payments $0, Revenue $0) and nothing
// to collect, so the screen could not be driven end to end. Idempotent: an appointment that already has ledger events
// is left alone. Anchored on the design's frozen clock like the rest of parity-ops.
import { PARITY_NOW } from '../../src/platform/clock.js'
import { createInvoiceGateway } from '../../src/modules/payments/gateway.js'
import { kindOfMethodLabel } from '../../src/modules/payments/repository.js'
import { requireAppointment } from '../../src/modules/scheduling/appointments.js'
import { ensureInvoiceFor } from '../../src/modules/scheduling/invoicing.js'
import type { SchedulingCtx } from '../../src/modules/scheduling/context.js'
import { addDays, parseT, wallToInstant } from '../../src/platform/time.js'
import type { SeedContext } from './index.js'
import { BASE_DATE, DESIGN_APPOINTMENTS, PARITY_OPS_MONEY } from './scheduling.js'

const TZ = 'America/New_York'
const PARITY_NOW_MS = new Date(PARITY_NOW).getTime()
/** The card the design's paid invoices show. Seeded history is money Squarespace already settled: confirmed. */
const CARD = { method: 'Visa ••4421', brand: 'visa', last4: '4421' } as const

export async function seedParityOpsMoney(ctx: SeedContext): Promise<void> {
  const { tx, location } = ctx
  const gateway = createInvoiceGateway({ clock: ctx.clock, newId: ctx.newId })
  const c: SchedulingCtx = {
    clock: ctx.clock,
    newId: ctx.newId,
    locationId: location.id,
    tz: location.timezone || TZ,
    ports: { invoices: gateway } as never,
  }
  const customers = new Map(
    (await tx.selectFrom('customers').select(['id', 'full_name']).execute()).map((r) => [r.full_name, r.id]),
  )
  let made = 0
  for (const a of DESIGN_APPOINTMENTS) {
    const customerId = customers.get(a.customer)
    if (!customerId) continue
    const start = wallToInstant(addDays(BASE_DATE, a.day), parseT(a.time), TZ)
    const row = await tx
      .selectFrom('appointments')
      .select('id')
      .where('location_id', '=', location.id)
      .where('customer_id', '=', customerId)
      .where('scheduled_start', '=', start)
      .where('package_name', '=', a.svc)
      .executeTakeFirst()
    if (!row) continue
    const appt = await requireAppointment(tx, location.id, row.id)
    const money = PARITY_OPS_MONEY[a.id]!
    const summary = await ensureInvoiceFor(tx, c, appt)
    const hasEvents = await tx
      .selectFrom('ledger_events')
      .select('id')
      .where('invoice_id', '=', summary.invoiceId)
      .executeTakeFirst()
    if (hasEvents) continue
    if (a.status === 'completed' && appt.completedAt)
      await gateway.freezeDate(tx, appt.id, appt.scheduledStart)
    if (money.tipCents)
      await tx
        .updateTable('invoices')
        .set({ tip_cents: money.tipCents })
        .where('id', '=', summary.invoiceId)
        .execute()
    if (money.pay === 'unpaid') continue
    const total = (await gateway.summariesFor(tx, [appt.id])).get(appt.id)!.totalCents
    const cents = money.pay === 'paid' ? total : money.depositCents
    // A deposit was taken at booking (yesterday); a day-0 payment is dated this morning so the cash-basis Revenue today
    // matches the design (a12 belongs to tomorrow and was paid in advance, so it is not today's revenue).
    const at =
      money.pay === 'deposit' || a.day === 1
        ? wallToInstant(addDays(BASE_DATE, -1), 16 * 60 + 30, TZ)
        : new Date(Math.min(start.getTime(), PARITY_NOW_MS - 30 * 60_000))
    await tx
      .insertInto('ledger_events')
      .values({
        id: ctx.newId(),
        location_id: location.id,
        invoice_id: summary.invoiceId,
        customer_id: customerId,
        type: 'pay',
        amount_cents: cents,
        status: 'done',
        method: CARD.method,
        method_kind: kindOfMethodLabel(CARD.method),
        brand: CARD.brand,
        last4: CARD.last4,
        dest: null,
        deposit: money.pay === 'deposit',
        reason: null,
        note: null,
        expiry: null,
        expires_at: null,
        actor_name: 'Rafael M.',
        actor_roles: 'Management',
        occurred_at: at,
        resolved_at: null,
        source: 'seed',
        processor_state: 'confirmed',
      } as never)
      .execute()
    made++
  }
  ctx.log(`parity-ops: ${made} payments on the design invoices`)
}
