// pnpm verify:square: the whole checklist against the simulator over a socket (the same checks the sandbox passed on 2026-10-12),
// the configuration and safety refusals, and the capture scrubber.
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main, scrubCapture } from '../../scripts/verify-live/square.js'
import { runVerify, statusOf, type CliRun } from './verify-live-helpers.js'

const runs: CliRun[] = []
afterEach(() => {
  while (runs.length) runs.pop()!.cleanup()
})
const run = async (argv: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> => {
  const r = await runVerify(main, argv, env)
  runs.push(r)
  return r
}

describe('verify:square', () => {
  it('--sim: every check passes against the simulator and the run cleans up after itself', async () => {
    const capture = path.join(process.cwd(), '.data', `verify-square-capture-${process.pid}`)
    const r = await run(['--sim', '--wait', '20', '--capture', capture])
    expect(r.code, r.out).toBe(0)
    expect(statusOf(r, 'square')).toEqual({
      'SQR-01': 'PASS',
      'SQR-02': 'PASS',
      'SQR-03': 'PASS',
      'SQR-04': 'PASS',
      'SQR-05': 'PASS',
      'SQR-06': 'PASS',
      'SQR-07': 'PASS',
      'SQR-08': 'PASS',
      'SQR-09': 'PASS',
      'SQR-10': 'SKIP',
      'SQR-11': 'PASS',
      'SQR-12': 'PASS',
      'SQR-13': 'PASS',
      'SQR-14': 'PASS',
      // ADR 0173: the simulator has no CalculateOrder; the sandbox is the reference for tax rounding
      'SQR-18': 'SKIP',
    })
    expect(r.out).toContain('resume: refused: 400 INVALID_REQUEST_ERROR/INVALID_DATE')
    expect(r.out).toContain('unpaid invoice: invoice UNPAID: CreatePayment on its order refused: 403')
    for (const f of readdirSync(capture)) {
      const text = readFileSync(path.join(capture, f), 'utf8')
      expect(text).not.toContain('sim-verify-token')
      expect(text).not.toMatch(/ccof:|inv:0-/)
    }
    expect(r.out).not.toContain('sim-verify-token')
    expect(r.markdown('square')).not.toContain('sim-verify-token')
    rmSync(capture, { recursive: true, force: true })
  }, 120_000)

  it('--tax-only runs SQR-01, SQR-18 and the cleanup only (SQR-18 is skipped against the simulator)', async () => {
    const r = await run(['--sim', '--tax-only'])
    expect(r.code, r.out).toBe(0)
    const st = statusOf(r, 'square')
    expect([st['SQR-01'], st['SQR-11'], st['SQR-18']]).toEqual(['PASS', 'PASS', 'SKIP'])
    expect(Object.entries(st).filter(([id, v]) => !['SQR-01', 'SQR-11'].includes(id) && v !== 'SKIP')).toEqual([])
    expect(r.out).toContain('the simulator has no CalculateOrder')
  })

  it('without a token it does not start (exit 2) and names what is missing', async () => {
    const r = await run([])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/SQUARE_ACCESS_TOKEN/)
    expect(r.out).toMatch(/--secret oasis\/sandbox\/square/)
  })

  it('refuses a production token unless --read-only', async () => {
    const r = await run([], { SQUARE_ACCESS_TOKEN: 'production-token-not-real', SQUARE_ENVIRONMENT: 'production' })
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/only --read-only runs against production/)
    expect(r.out).not.toContain('production-token-not-real')
  })

  it('--help', async () => {
    const r = await run(['--help'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('--secret ID')
  })

  it('the capture scrubber replaces ids everywhere, keeps URL hosts only, and replaces emails and application ids', () => {
    const [a, b] = scrubCapture([
      { path: '/v2/payments/PAY123456', body: { payment: { id: 'PAY123456', order_id: 'ORD999999', note: 'for ORD999999', receipt_url: 'https://squareupsandbox.com/receipt/preview/PAY123456', buyer_email_address: 'a@b.com' } } },
      { path: '/v2/subscriptions', body: { subscription: { invoice_ids: ['inv:0-ABCDEF'], source: { name: 'Sandbox for sq0idp-AbC_dEf' } } } },
    ]) as Array<Record<string, unknown>>
    const text = JSON.stringify([a, b])
    expect(text).not.toMatch(/PAY123456|ORD999999|inv:0-ABCDEF|sq0idp|a@b\.com/)
    expect(text).toContain('https://squareupsandbox.com/scrubbed')
    expect(text).toContain('APPLICATION_ID')
    expect((a as { path: string }).path).toBe('/v2/payments/ID0001')
  })
})
