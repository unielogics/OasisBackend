// The pure parts of the dashboard gaps (wave Q3 dashapi): which Square tenders an invoice offers, the deposit state of a visit (every
// state, the pending refund of Q2c N1 included), and which Square receipt pages are shown.
import { describe, expect, it } from 'vitest'
import { depositViewOf, type DepositFacts } from '../../src/modules/payments/deposit-view.js'
import { safeReceiptUrl } from '../../src/modules/payments/detail.js'
import { processingOf, savedCardsUsable } from '../../src/modules/square/tenders.js'

const card = { cardId: 'c1', label: 'Visa ••4242', brand: 'visa', last4: '4242' }
const env = (processor: 'squarespace' | 'square', writes: boolean, pos = false) => ({
  PAYMENT_PROCESSOR: processor,
  SQUARE_WRITES_ENABLED: writes,
  SQUARE_POS_API_ENABLED: pos,
})

describe('processingOf', () => {
  it('everything off before the cutover, whatever the card', () => {
    expect(processingOf(env('squarespace', true, true), { card })).toEqual({
      processor: 'squarespace',
      squarePosAppSwitch: true,
      squareTenders: { reader: false, link: false, savedCard: null },
    })
    expect(savedCardsUsable(env('squarespace', true))).toBe(false)
  })
  it('observe-only: the reader alone', () => {
    expect(processingOf(env('square', false), { card }).squareTenders).toEqual({ reader: true, link: false, savedCard: null })
    expect(savedCardsUsable(env('square', false))).toBe(false)
  })
  it('Square with writes: reader, link and the card; never the card on a canceled invoice', () => {
    expect(processingOf(env('square', true), { card }).squareTenders).toEqual({ reader: true, link: true, savedCard: card })
    expect(processingOf(env('square', true), { card, canceled: true }).squareTenders.savedCard).toBeNull()
    expect(processingOf(env('square', true)).squareTenders.savedCard).toBeNull()
  })
})

const base: DepositFacts = {
  canceled: false,
  paidCents: 0,
  refundedCents: 0,
  pendingRefundCents: 0,
  pendingRefunds: 0,
  depositPaidCents: 0,
  refundFailed: false,
  refundSending: false,
  link: null,
}
const at = new Date('2026-06-13T14:00:00Z')
const link = (state: NonNullable<DepositFacts['link']>['state'], o: Partial<NonNullable<DepositFacts['link']>> = {}) => ({
  state,
  expectedCents: 2500,
  sentAt: null,
  expiresAt: null,
  createdAt: at,
  cancelReason: null,
  ...o,
})

describe('depositViewOf', () => {
  it('nothing asked for and nothing paid: null', () => {
    expect(depositViewOf(base)).toBeNull()
    expect(depositViewOf({ ...base, paidCents: 4000 })).toBeNull() // a part payment is not a deposit request
  })
  it('a link asked for, made, texted, lapsed', () => {
    expect(depositViewOf({ ...base, link: link('pending') })).toMatchObject({ state: 'requested', requestedCents: 2500, paidCents: 0, link: { state: 'pending', sentAt: null } })
    expect(depositViewOf({ ...base, link: link('active') })?.state).toBe('requested')
    expect(depositViewOf({ ...base, link: link('active', { sentAt: at }) })).toMatchObject({ state: 'link_sent', link: { sentAt: at.toISOString() } })
    expect(depositViewOf({ ...base, link: link('expired', { cancelReason: 'expired' }) })?.state).toBe('link_expired')
    expect(depositViewOf({ ...base, link: link('canceled', { cancelReason: 'stale' }) })?.state).toBe('link_expired')
    expect(depositViewOf({ ...base, link: link('canceled', { cancelReason: 'deposit_paid' }) })).toBeNull()
    expect(depositViewOf({ ...base, link: link('paid') })?.state).toBe('paid')
  })
  it('paid on an open visit (the link no longer matters)', () => {
    expect(depositViewOf({ ...base, depositPaidCents: 2500, paidCents: 2500, link: link('active', { sentAt: at }) })).toMatchObject({
      state: 'paid',
      paidCents: 2500,
      keptCents: 0,
    })
  })
  it('canceled: kept, partly refunded, refunded, a refund waiting for approval (Q2c N1), a failed refund', () => {
    const c = { ...base, canceled: true, paidCents: 2500, depositPaidCents: 2500 }
    expect(depositViewOf(c)).toMatchObject({ state: 'kept', paidCents: 2500, keptCents: 2500, refundedCents: 0 })
    expect(depositViewOf({ ...c, refundedCents: 1250 })).toMatchObject({ state: 'kept', keptCents: 1250, refundedCents: 1250 })
    expect(depositViewOf({ ...c, refundedCents: 2500, refundSending: true })).toMatchObject({ state: 'refunded', keptCents: 0, refundSending: true })
    expect(depositViewOf({ ...c, pendingRefundCents: 2500, pendingRefunds: 1 })).toMatchObject({ state: 'refund_pending', pendingRefundCents: 2500, keptCents: 0 })
    expect(depositViewOf({ ...c, refundFailed: true })).toMatchObject({ state: 'kept', keptCents: 2500, refundFailed: true })
    expect(depositViewOf({ ...base, canceled: true, link: link('canceled', { cancelReason: 'invoice_canceled' }) })).toBeNull()
  })
})

describe('safeReceiptUrl', () => {
  it('only https pages on Square’s receipt hosts', () => {
    expect(safeReceiptUrl('https://squareup.com/receipt/preview/abc')).toBe('https://squareup.com/receipt/preview/abc')
    expect(safeReceiptUrl('https://app.squareupsandbox.com/receipt/preview/abc')).toBe('https://app.squareupsandbox.com/receipt/preview/abc')
    for (const bad of [
      null,
      '',
      'http://squareup.com/receipt/x',
      'https://squareup.com.evil.example/receipt/x',
      'https://evilsquareup.com/receipt/x',
      'https://user:pw@squareup.com/receipt/x',
      'https://squareup.com:8443/receipt/x',
      'javascript:alert(1)',
      'not a url',
    ])
      expect(safeReceiptUrl(bad)).toBeNull()
  })
})
