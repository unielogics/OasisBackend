// Outbound notices of the Payments module (payment link by SMS, receipt by SMS + email) behind a port, so the Messaging
// vertical's dispatcher and SES adapter can be handed over at composition time. The messenger decides WHO may be reached
// (opt-in, opt-out, a number or an address on file); the outbox queues the message and applies the full SMS policy
// (quiet hours, allowlist, synthetic numbers) when the real implementation is wired.
import { randomUUID } from 'node:crypto'
import type { Tx } from '../../platform/db.js'
import { formatUsd } from '../../platform/money.js'
import { invoiceLabel } from './format.js'

export type DeliveryState = 'queued' | 'skipped_opt_out' | 'no_contact'

export interface QueuedSms {
  customerId: string
  toE164: string
  body: string
  klass: 'receipt' | 'payment_link'
  dedupeKey: string
}

export interface QueuedEmail {
  customerId: string
  to: string
  subject: string
  text: string
  dedupeKey: string
}

export interface PaymentOutbox {
  queueSms(tx: Tx, m: QueuedSms): Promise<{ messageId: string | null }>
  queueEmail(tx: Tx, m: QueuedEmail): Promise<{ messageId: string | null }>
}

/** Test and local outbox: remembers what was queued, in order. */
export class InMemoryOutbox implements PaymentOutbox {
  readonly sms: QueuedSms[] = []
  readonly email: QueuedEmail[] = []
  async queueSms(_tx: Tx, m: QueuedSms): Promise<{ messageId: string | null }> {
    this.sms.push(m)
    return { messageId: randomUUID() }
  }
  async queueEmail(_tx: Tx, m: QueuedEmail): Promise<{ messageId: string | null }> {
    this.email.push(m)
    return { messageId: randomUUID() }
  }
  clear(): void {
    this.sms.length = 0
    this.email.length = 0
  }
}

export interface PaymentLinkNotice {
  invoiceId: string
  invoiceNo: number
  customerId: string
  url: string
  dedupeKey: string
}

export interface ReceiptNotice {
  invoiceId: string
  invoiceNo: number
  customerId: string
  clientName: string
  totalCents: number
  paidCents: number
  refundedCents: number
  dedupeKey: string
}

export interface PaymentMessenger {
  sendPaymentLink(tx: Tx, n: PaymentLinkNotice): Promise<{ state: DeliveryState; messageId: string | null }>
  sendReceipt(tx: Tx, n: ReceiptNotice): Promise<{ sms: DeliveryState; email: DeliveryState }>
}

interface Contact {
  phone: string | null
  email: string | null
  smsOptedIn: boolean
  smsOptedOut: boolean
}

async function contactOf(tx: Tx, customerId: string): Promise<Contact> {
  const c = await tx
    .selectFrom('customers')
    .select(['phone_e164', 'email', 'sms_opted_in', 'sms_opted_out_at'])
    .where('id', '=', customerId)
    .executeTakeFirst()
  return {
    phone: c?.phone_e164 ?? null,
    email: c?.email ?? null,
    smsOptedIn: c?.sms_opted_in ?? false,
    smsOptedOut: c?.sms_opted_out_at != null,
  }
}

export function receiptSmsBody(
  n: Pick<ReceiptNotice, 'invoiceNo' | 'totalCents' | 'paidCents' | 'refundedCents'>,
): string {
  const net = n.paidCents - n.refundedCents
  return `Oasis Auto Spa receipt ${invoiceLabel(n.invoiceNo)}: total ${formatUsd(n.totalCents)}, paid ${formatUsd(net)}. Thank you!`
}

export function createPaymentMessenger(outbox: PaymentOutbox): PaymentMessenger {
  return {
    async sendPaymentLink(tx, n) {
      const c = await contactOf(tx, n.customerId)
      if (!c.phone) return { state: 'no_contact', messageId: null }
      if (c.smsOptedOut || !c.smsOptedIn) return { state: 'skipped_opt_out', messageId: null }
      const r = await outbox.queueSms(tx, {
        customerId: n.customerId,
        toE164: c.phone,
        body: `Here is your secure payment link: ${n.url}`,
        klass: 'payment_link',
        dedupeKey: n.dedupeKey,
      })
      return { state: 'queued', messageId: r.messageId }
    },
    async sendReceipt(tx, n) {
      const c = await contactOf(tx, n.customerId)
      let sms: DeliveryState = 'no_contact'
      if (c.phone) {
        if (c.smsOptedOut || !c.smsOptedIn) sms = 'skipped_opt_out'
        else {
          await outbox.queueSms(tx, {
            customerId: n.customerId,
            toE164: c.phone,
            body: receiptSmsBody(n),
            klass: 'receipt',
            dedupeKey: n.dedupeKey,
          })
          sms = 'queued'
        }
      }
      let email: DeliveryState = 'no_contact'
      if (c.email) {
        await outbox.queueEmail(tx, {
          customerId: n.customerId,
          to: c.email,
          subject: `Your Oasis Auto Spa receipt ${invoiceLabel(n.invoiceNo)}`,
          text: [
            `Hi ${n.clientName},`,
            '',
            `Receipt ${invoiceLabel(n.invoiceNo)}`,
            `Total: ${formatUsd(n.totalCents)}`,
            `Paid: ${formatUsd(n.paidCents)}`,
            ...(n.refundedCents > 0 ? [`Refunded: ${formatUsd(n.refundedCents)}`] : []),
            '',
            'Thank you for choosing Oasis Auto Spa.',
          ].join('\n'),
          dedupeKey: n.dedupeKey,
        })
        email = 'queued'
      }
      return { sms, email }
    },
  }
}
