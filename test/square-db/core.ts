// The rig of the Square core tests (wave Q2b): a database, the simulator (its own store and clock), the Square runtime pointed at
// both with Square as the processor and writes on (unless a test says otherwise), invoices to pay, and the ways a payment arrives.
import { afterEach, beforeEach } from 'vitest'
import { loadEnv, type Env } from '../../src/config/env.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import { calcOf } from '../../src/modules/payments/repository.js'
import { paymentFacts, refundFacts } from '../../src/modules/square/facts.js'
import { decideSquarePayment, lockPayment, type DecideOutcome, type SquarePaymentDeps } from '../../src/modules/square/payments.js'
import { ingestSquareRefund } from '../../src/modules/square/refunds.js'
import { configureSquareMessenger, configureSquareRuntime } from '../../src/modules/square/runtime.js'
import type { FixedClock } from '../../src/platform/clock.js'
import { advisoryXactLock, transaction } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { createLogger } from '../../src/platform/logging.js'
import { makeAppointment, makeService } from '../domain-schema/helpers.js'
import { testDatabaseUrl } from '../helpers/env.js'
import type { TestDb } from '../helpers/db.js'
import { addEvent, makeCustomer, makeInvoice, setupEnv, type MadeInvoice } from '../payments/helpers.js'
import { SIM_LOCATION, simFor } from './helpers.js'

export const silent = createLogger({ level: 'silent' })

export const coreVars = {
  SQUARE_LOCATION_ID: SIM_LOCATION,
  PAYMENT_PROCESSOR: 'square',
  SQUARE_WRITES_ENABLED: 'true',
  SQUARE_MATCH_DELAY_SECONDS: '0',
}

export const squareEnvFor = (vars: Record<string, string> = {}): Env =>
  loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars, ...vars })

/** Resets the runtime after each test of the file. */
export function useCoreRuntime(): void {
  beforeEach(() => configureSquareMessenger(undefined))
  afterEach(() => {
    configureSquareRuntime({})
    configureSquareMessenger(undefined)
  })
}

export type Rig = Awaited<ReturnType<typeof coreRig>>

/** Invoice numbers and keys unique across the rigs of one test. */
let n = 0

export async function coreRig(t: Pick<TestDb, 'db' | 'clock'>, vars: Record<string, string> = {}) {
  const clock = t.clock as FixedClock
  const newId = createIdGenerator(clock)
  const pe = await setupEnv(t)
  const sim = simFor(clock)
  const env = squareEnvFor(vars)
  configureSquareRuntime({ env, api: () => sim.api })
  const deps: SquarePaymentDeps = { locationId: pe.locationId, clock, newId, env }
  const nonce = 'cnon:card-nonce-ok'

  /** A payment taken in the Square POS app (card or cash), as the webhook would make Oasis see it. */
  const posPayment = (o: { amountCents: number; tipCents?: number; note?: string; cash?: boolean; customerId?: string }) => {
    const p = sim.store.posPayment({ amountCents: o.amountCents, tipCents: o.tipCents, note: o.note, sourceType: o.cash ? 'CASH' : 'CARD', customerId: o.customerId })
    return { ...p, id: String(p.id) }
  }

  /** Decides one payment as the event processor does (the same advisory lock, a fresh GetPayment). */
  const decide = (paymentId: string, o: { force?: boolean } = {}): Promise<DecideOutcome> =>
    transaction(t.db, async (tx) => {
      await lockPayment(tx, paymentId)
      return decideSquarePayment(tx, deps, paymentFacts(await sim.api.payments.get(paymentId)), o)
    })

  const ingestRefund = (refundId: string) =>
    transaction(t.db, async (tx) => {
      await advisoryXactLock(tx, `square:refund:${refundId}`)
      return ingestSquareRefund(tx, deps, refundFacts(await sim.api.refunds.get(refundId)))
    })

  /** An invoice of today with an appointment (booked) so it is "open today" for rule R4. */
  const openInvoice = async (o: { items?: { name: string; priceCents: number }[]; taxBp?: number; email?: string | null; phone?: string | null; name?: string } = {}): Promise<MadeInvoice> => {
    const customerId = await makeCustomer(t.db, pe, { email: o.email ?? null, ...(o.phone !== undefined ? { phone: o.phone } : {}), name: o.name })
    const inv = await makeInvoice(t.db, pe, { customerId, items: o.items ?? [{ name: 'Signature Hand Wash', priceCents: 4000 }], taxBp: o.taxBp ?? 700, no: 40000 + ++n })
    const serviceId = await makeService(t.db, pe)
    const appointmentId = await makeAppointment(t.db, pe, { customerId, serviceId, start: clock.now() })
    await t.db.updateTable('invoices').set({ appointment_id: appointmentId }).where('id', '=', inv.id).execute()
    return inv
  }

  /** A staff "Square reader" entry: a card pay waiting on the processor. */
  const staffCard = (inv: Pick<MadeInvoice, 'id' | 'customerId'>, amountCents: number) =>
    addEvent(t.db, pe, inv, { type: 'pay', amountCents, method: 'Card', methodKind: 'card', processorState: 'awaiting_processor' })
  const staffCash = (inv: Pick<MadeInvoice, 'id' | 'customerId'>, amountCents: number) =>
    addEvent(t.db, pe, inv, { type: 'pay', amountCents, method: 'Cash', methodKind: 'cash' })

  const mirror = (paymentId: string) => t.db.selectFrom('square_payments').selectAll().where('square_payment_id', '=', paymentId).executeTakeFirst()
  const livePays = (paymentId: string) =>
    t.db
      .selectFrom('ledger_events as e')
      .selectAll('e')
      .where('e.processor_ref', '=', paymentId)
      .where('e.type', '=', 'pay')
      .where((eb) => eb.or([eb('e.reason', 'is', null), eb('e.reason', '<>', 'Tip')]))
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('ledger_events as v').select('v.id').whereRef('v.voids_event_id', '=', 'e.id'))))
      .execute()
  const calc = (invoiceId: string) => calcOf(t.db, invoiceId)
  /** A card payment through the API (a client paying online, for refund tests). */
  const apiPayment = (amountCents: number) => sim.api.payments.create(sqKey('py', `api-${++n}-${amountCents}`), { source_id: nonce, amount_money: usd(amountCents), location_id: SIM_LOCATION, autocomplete: true })

  return {
    t,
    clock,
    newId,
    pe,
    sim,
    env,
    deps,
    posPayment,
    apiPayment,
    decide,
    ingestRefund,
    openInvoice,
    staffCard,
    staffCash,
    mirror,
    livePays,
    calc,
  }
}
