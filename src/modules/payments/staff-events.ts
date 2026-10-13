// The staff event of a staff payments command (ADR 0180): collecting (cash, card, store credit) is a payment, then the tip, the
// receipt and a payment link; refunds, adjustments, credits, voids and approvals are not kiosk actions and not counted in the Team
// activity report. Read from the audit row's `after` (announceInvoiceChange's lead events plus the command's own fields), so the live
// command and the history backfill (src/modules/kiosk/backfill.ts) map an action the same way.
import type { JsonValue } from '../../platform/schema.js'
import type { StaffEventKind } from '../kiosk/schema.js'

export interface PaymentStaffEvent {
  kind: StaffEventKind
  amountCents: number | null
  ledgerEventId: string | null
  meta: Record<string, JsonValue>
}

/** The audit actions that are someone's payments activity. */
export const PAYMENT_STAFF_ACTIONS = [
  'payments.collect',
  'payments.credit_apply',
  'payments.tip',
  'payments.receipt',
  'payments.payment_link',
] as const
export type PaymentStaffAction = (typeof PAYMENT_STAFF_ACTIONS)[number]

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

export function paymentStaffEventOf(action: string, after: unknown): PaymentStaffEvent | null {
  const a = isRecord(after) ? after : {}
  switch (action) {
    case 'payments.collect':
    case 'payments.credit_apply': {
      const lead = Array.isArray(a.events) ? a.events.find(isRecord) : undefined
      if (!lead) return null
      return {
        kind: 'payment',
        amountCents: int(lead.amountCents),
        ledgerEventId: str(lead.id),
        meta: { method: action === 'payments.credit_apply' ? 'store_credit' : (str(a.method) ?? 'card') },
      }
    }
    case 'payments.tip':
      return { kind: 'tip', amountCents: int(a.tipCents), ledgerEventId: null, meta: {} }
    case 'payments.receipt':
      return { kind: 'receipt', amountCents: null, ledgerEventId: null, meta: {} }
    case 'payments.payment_link':
      return linkEvent(a)
    default:
      return null
  }
}

// "Send link" through collect (method payment_link) is audited as payments.payment_link too
const linkEvent = (a: Record<string, unknown>): PaymentStaffEvent => ({
  kind: 'payment_link',
  amountCents: int(a.expectedCents),
  ledgerEventId: null,
  meta: { purpose: str(a.purpose) ?? 'balance', provider: str(a.provider) ?? 'squarespace' },
})
