// A money change on an invoice that belongs to an appointment is news for the Operations board too: its pay pill, the
// balance in the file and the Pending payments and Revenue KPIs all read the invoice. The payments channel already says
// "invoice.updated"; this adds the matching `ops` events (appointment.updated with change "payment", kpi.dirty) in the same
// transaction, so a second browser on the board refreshes without polling.
import type { Tx } from '../../platform/db.js'
import * as realtime from '../../platform/realtime.js'

export async function publishOpsForInvoice(tx: Tx, locationId: string, invoiceId: string): Promise<void> {
  const row = await tx
    .selectFrom('invoices as i')
    .innerJoin('appointments as a', 'a.id', 'i.appointment_id')
    .select(['a.id', 'a.version', 'a.status'])
    .where('i.id', '=', invoiceId)
    .executeTakeFirst()
  if (!row) return
  await realtime.publish(tx, {
    locationId,
    channel: 'ops',
    type: 'appointment.updated',
    payload: { id: row.id, version: row.version, status: row.status, change: 'payment' },
  })
  await realtime.publish(tx, { locationId, channel: 'ops', type: 'kpi.dirty', payload: {} })
}
