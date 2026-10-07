import { describe, expect, it } from 'vitest'
import { payView } from '../../src/modules/scheduling/board.js'
import type { InvoiceSummary } from '../../src/modules/scheduling/ports.js'

const inv = (o: Partial<InvoiceSummary>): InvoiceSummary => ({
  invoiceId: 'i',
  invoiceNo: 20611,
  subtotalCents: 10000,
  taxCents: 700,
  tipCents: 0,
  totalCents: 10700,
  paidCents: 0,
  balanceCents: 10700,
  depositCents: 0,
  status: 'unpaid',
  refundPending: false,
  items: [],
  payMethodLabel: null,
  ...o,
})

describe('payView (DV-212)', () => {
  it('is Paid only when nothing waits on Squarespace', () => {
    expect(payView(inv({ paidCents: 10700, balanceCents: 0, status: 'paid' }))).toMatchObject({
      label: 'Paid',
      kind: 'paid',
    })
  })
  it('reads Payment pending while card money awaits confirmation, even when the invoice is fully funded', () => {
    expect(
      payView(inv({ paidCents: 10700, balanceCents: 0, status: 'paid', awaitingCents: 10700 })),
    ).toMatchObject({ label: 'Payment pending', kind: 'pending', awaitingCents: 10700, balanceCents: 0 })
  })
  it('says what is still due when the unconfirmed money does not cover the invoice', () => {
    expect(
      payView(inv({ paidCents: 5000, balanceCents: 5700, status: 'partially_paid', awaitingCents: 5000 })),
    ).toMatchObject({ label: 'Payment pending · $57 due', kind: 'pending', balanceCents: 5700 })
  })
  it('keeps the deposit and due labels for confirmed money', () => {
    expect(payView(inv({ paidCents: 5000, balanceCents: 5700, status: 'partially_paid' })).label).toBe(
      'Deposit · $57 due',
    )
    expect(payView(inv({})).label).toBe('$107 due')
    expect(payView(null).kind).toBe('none')
  })
  it('a canceled invoice is never pending', () => {
    expect(payView(inv({ status: 'canceled', awaitingCents: 100 })).label).toBe('Canceled')
  })
})
