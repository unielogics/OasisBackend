// The Payments module's outbox port on the messaging queue: the payment link and receipt texts go through the SMS policy
// like every other text, and the receipt email is queued for the EmailProvider.
import type { PaymentOutbox, QueuedEmail, QueuedSms } from '../../payments/messenger.js'
import type { Tx } from '../../../platform/db.js'
import { loadCustomerTarget } from '../db/recipients.js'
import { queueEmail } from '../email/service.js'
import { receiptEmailVars } from '../email/receipt.js'
import type { MessagingRuntime } from '../runtime.js'

async function appointmentOf(tx: Tx, invoiceId: string | undefined): Promise<string | null> {
  if (!invoiceId) return null
  const r = await tx.selectFrom('invoices').select('appointment_id').where('id', '=', invoiceId).executeTakeFirst()
  return r?.appointment_id ?? null
}

export function createDbPaymentOutbox(rt: MessagingRuntime): PaymentOutbox {
  return {
    async queueSms(tx: Tx, m: QueuedSms) {
      const loc = await rt.location(tx)
      const target = await loadCustomerTarget(tx, loc.id, m.customerId)
      if (!target) return { messageId: null }
      const out = await rt.queue.enqueueFor(tx, {
        locationId: loc.id,
        customerId: m.customerId,
        recipient: target.recipient,
        appointmentId: await appointmentOf(tx, m.invoiceId),
        text: m.body,
        klass: m.klass,
        purpose: m.klass,
        senderKind: 'system',
        dedupeKey: m.dedupeKey,
      })
      return { messageId: out.queued ? out.messageId : null }
    },

    async queueEmail(tx: Tx, m: QueuedEmail) {
      const vars = m.invoiceId ? await receiptEmailVars(tx, m.invoiceId) : null
      if (!vars) {
        rt.log.warn({ customerId: m.customerId }, 'receipt email not queued: no invoice to build it from')
        return { messageId: null }
      }
      const loc = await rt.location(tx)
      const q = await queueEmail(tx, { locationId: loc.id, to: m.to, template: 'receipt', vars, purpose: 'receipt', customerId: m.customerId, dedupeKey: m.dedupeKey }, rt.deps)
      return { messageId: q.emailId }
    },
  }
}
