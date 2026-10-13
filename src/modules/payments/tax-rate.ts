// The shop's sales tax as invoices take it (ADR 0173): the rate and the rounding read together, and the re-rating of open invoices
// when the owner changes them.
//   currentTax          both settings in ONE statement, so an invoice made while the rate and the rounding change together never
//                       mixes the old rate with the new rounding (K4 review tax:H1)
//   rerateOpenInvoices  invoices of visits not yet done (not canceled, date not frozen at completion) move to the new rate and
//                       rounding in the same transaction as the change, so a visit booked before the switch is not charged the old
//                       rate (K4 review tax:M1). One that would end up overpaid (paid up front at the old rate) keeps its rate.
import type { AuditContext } from '../../platform/audit.js'
import type { Executor, Tx } from '../../platform/db.js'
import type { TaxRounding } from '../../platform/money.js'
import { defaultSetting, parseSetting } from '../../platform/settings.js'
import { announceInvoiceChange } from './announce.js'
import { calcOf } from './repository.js'

export interface CurrentTax {
  dbp: number
  rounding: TaxRounding
}

export async function currentTax(db: Executor, locationId: string): Promise<CurrentTax> {
  const rows = await db
    .selectFrom('settings')
    .select(['key', 'value'])
    .where('location_id', '=', locationId)
    .where('key', 'in', ['tax.rate_dbp', 'tax.rounding'])
    .execute()
  const rate = rows.find((r) => r.key === 'tax.rate_dbp')
  const rounding = rows.find((r) => r.key === 'tax.rounding')
  return {
    dbp: rate ? parseSetting('tax.rate_dbp', rate.value) : defaultSetting('tax.rate_dbp'),
    rounding: rounding ? parseSetting('tax.rounding', rounding.value) : defaultSetting('tax.rounding'),
  }
}

export interface RerateResult {
  /** Invoices moved to the new rate and rounding. */
  rerated: number
  /** Open invoices left at their rate: moving them would leave them overpaid (paid up front at the old rate). */
  kept: number
}

export async function rerateOpenInvoices(
  tx: Tx,
  o: { locationId: string; tax: CurrentTax; now: Date; ctx: AuditContext },
): Promise<RerateResult> {
  const open = await tx
    .selectFrom('invoices')
    .select(['id', 'tax_dbp', 'tax_rounding'])
    .where('location_id', '=', o.locationId)
    .where('canceled_at', 'is', null)
    .where('date_frozen_at', 'is', null)
    .where((eb) => eb.or([eb('tax_dbp', '!=', o.tax.dbp), eb('tax_rounding', '!=', o.tax.rounding)]))
    .orderBy('id')
    .forUpdate()
    .execute()
  let rerated = 0
  let kept = 0
  for (const inv of open) {
    const set = (dbp: number, rounding: TaxRounding) =>
      tx.updateTable('invoices').set({ tax_dbp: dbp, tax_rounding: rounding }).where('id', '=', inv.id).execute()
    await set(o.tax.dbp, o.tax.rounding)
    const calc = await calcOf(tx, inv.id)
    if (calc.overpaid > 0) {
      await set(inv.tax_dbp, inv.tax_rounding)
      kept++
      continue
    }
    await announceInvoiceChange(tx, {
      locationId: o.locationId,
      invoiceId: inv.id,
      now: o.now,
      action: 'payments.tax_rerated',
      ctx: o.ctx,
      before: { taxDbp: inv.tax_dbp, taxRounding: inv.tax_rounding },
      after: { taxDbp: o.tax.dbp, taxRounding: o.tax.rounding },
      events: [],
    })
    rerated++
  }
  return { rerated, kept }
}
