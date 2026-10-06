// The few derivations the design does in renderVals() and the dashboard will do from the API, reproduced so the tests prove the
// API carries everything the design shows (ledger titles and amounts, action buttons, the breakdown).
import { formatUsd } from '../../src/platform/money.js'

export interface Ev {
  type: string
  status: string
  amountCents: number
  dest: string | null
  method: string | null
  deposit: boolean
  reason: string | null
  note: string | null
  expiryLabel: string | null
  by: string | null
  byRole: string | null
  approvedBy: string | null
  atLabel: string
}
export interface Detail {
  label: string
  when: string
  client: string
  vehicle: string
  staff: string
  statusLabel: string
  tipCents: number
  canceled: boolean
  items: { name: string; priceCents: number }[]
  adjustments: { kind: string; reason: string | null; amountCents: number }[]
  calc: {
    total: number
    tax: number
    paid: number
    paidOrig: number
    creditApplied: number
    refunded: number
    balance: number
    refundable: number
  }
  clientCredit: { balanceCents: number }
  ledger: Ev[]
  caller: {
    canCollect: boolean
    canRefund: boolean
    canAdjust: boolean
    canCredit: boolean
    refundLimitCents: number | null
  }
}

export const TIME_PREFIX = /^(?:(?:Today|Yesterday) |[A-Z][a-z]{2} \d{1,2} · )?\d{1,2}:\d{2} [AP]M(?: · )?/

export function ledgerRow(e: Ev, withActor = true): { title: string; amt: string; rest: string } {
  const pend = e.type === 'refund' && e.status === 'pending'
  const den = e.status === 'denied'
  const dest = e.dest === 'credit' ? 'to store credit' : e.dest === 'cash' ? 'cash' : e.method
  const title: Record<string, string> = {
    pay: `${e.deposit ? 'Deposit' : 'Payment'} · ${e.method}`,
    adjust: `${e.amountCents < 0 ? 'Discount' : 'Surcharge'} · ${e.reason}`,
    refund: `${pend ? 'Refund requested' : den ? 'Refund denied' : 'Refund'} · ${dest}`,
    credit_issue: `Credit issued · ${e.reason}`,
    credit_apply: 'Store credit applied',
  }
  const sign =
    e.type === 'pay' || e.type === 'credit_apply'
      ? ''
      : e.type === 'refund'
        ? '−'
        : e.type === 'credit_issue'
          ? '+'
          : ''
  const amt =
    sign +
    formatUsd(Math.abs(e.amountCents)).replace('−', e.type === 'adjust' && e.amountCents < 0 ? '−' : '')
  const rest = [
    withActor && e.by ? e.by + (e.byRole ? ` (${e.byRole})` : '') : null,
    e.type === 'refund' ? e.reason : null,
    e.note,
    e.expiryLabel ? `Expires: ${e.expiryLabel}` : null,
    e.approvedBy ? `Approved by ${e.approvedBy}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return { title: title[e.type]!, amt, rest }
}

export function uiActions(d: Detail): { label: string; disabled: boolean; why: string }[] {
  const out: { label: string; disabled: boolean; why: string }[] = []
  const c = d.calc
  const credit = d.clientCredit.balanceCents
  if (c.balance > 0)
    out.push({
      label: `Collect ${formatUsd(c.balance)}`,
      disabled: !d.caller.canCollect,
      why: d.caller.canCollect ? '' : 'Role can’t collect payments',
    })
  if (c.balance > 0 && credit > 0)
    out.push({
      label: `Apply ${formatUsd(Math.min(credit, c.balance))} credit`,
      disabled: !d.caller.canCollect,
      why: d.caller.canCollect ? '' : 'Role can’t collect payments',
    })
  const canRefund = d.caller.canRefund && c.refundable > 0
  out.push({
    label: 'Refund',
    disabled: !canRefund,
    why: canRefund ? '' : d.caller.canRefund ? 'Nothing left to refund' : 'Role can’t issue refunds',
  })
  const canAdjust = d.caller.canAdjust && !d.canceled
  out.push({ label: 'Adjust', disabled: !canAdjust, why: canAdjust ? '' : 'Role can’t adjust invoices' })
  out.push({
    label: 'Issue credit',
    disabled: !d.caller.canCredit,
    why: d.caller.canCredit ? '' : 'Role can’t issue credits',
  })
  out.push({ label: 'Send receipt', disabled: false, why: '' })
  return out
}
