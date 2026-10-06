// Loaders for the oracle values extracted from the ORIGINAL Payments bundle (test/golden/pay/extract-oracle.mjs).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { InvoiceStatus } from '../../src/modules/payments/schema.js'

const dir = path.resolve(import.meta.dirname, '../golden/pay')
const read = <T>(f: string): T => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as T

export interface OracleEvent {
  type: string
  amt: number
  t?: string
  by?: string
  byRole?: string
  method?: string
  deposit?: boolean
  dest?: string
  reason?: string
  note?: string
  status?: string
  expiry?: string
}

export interface OracleInvoice {
  id: string
  off: number
  time: string
  client: string
  vehicle: string
  staff: string
  items: { name: string; price: number }[]
  tip: number
  canceled: boolean
  events: OracleEvent[]
}

export interface OracleCalc {
  items: number
  adj: number
  sub: number
  tax: number
  total: number
  paid: number
  paidOrig: number
  creditApplied: number
  refunded: number
  pending: number[]
  balance: number
  refundable: number
  toOrigMax: number
  issued: number
  status: string
  net: number
}

export interface OracleView {
  state: { range: string; filter: string }
  rangeLabel: string
  kpis: { label: string; value: string; sub: string; color: string }[]
  bars: { label: string; title: string; netHeight: string; netMin: string; lossHeight: string }[]
  methods: { label: string; value: string; width: string }[]
  filters: { label: string; count: string }[]
  rows: { id: string; date: string; client: string; vehicle: string; items: string; total: string; status: string; adjusted: boolean }[]
  noRows: boolean
  hasPending: boolean
  pendingText: string
  raw: {
    agg: { gross: number; adj: number; refunds: number; credits: number; outstanding: number; net: number }
    counts: { invoices: number; refunded: number; adjusted: number; creditInvoices: number; openBalances: number }
    chart: { key: number; net: number; loss: number; n: number }[]
    methods: Record<string, number>
    droppedFromChart: number
  }
}

export interface OracleDetail {
  id: string
  when: string
  client: string
  vehicle: string
  staff: string
  status: string
  big: { label: string; value: string }[]
  lines: { label: string; value: string }[]
  actions: { label: string; disabled: boolean; why: string }[]
  ledger: { glyph: string; title: string; meta: string; amt: string; pending: boolean; approveNote: string }[]
  creditLine: string
}

export const oracleFixtures = (): OracleInvoice[] => read('fixtures.json')
export const oracleCalcs = (): OracleCalc[] => read('calcs.json')
export const oracleViews = (): { meta: Record<string, string>; views: Record<string, Record<string, OracleView>> } =>
  read('views.json')
export const oracleDetails = (): {
  pending: { hasPending: boolean; pendingText: string }
  invoices: Record<string, OracleDetail>
} => read('details.json')

/** The design's status text -> the backend status key (the design has no canceled / kept-deposit states). */
export const STATUS_KEY: Record<string, InvoiceStatus> = {
  Paid: 'paid',
  Unpaid: 'unpaid',
  'Partially paid': 'partially_paid',
  'Partially refunded': 'partially_refunded',
  Refunded: 'refunded',
  'Canceled · refunded': 'canceled_refunded',
}

export const cents = (dollars: number): number => Math.round(dollars * 100)
