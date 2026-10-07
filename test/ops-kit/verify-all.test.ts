import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SquarespaceSimApi } from '../../src/integrations/squarespace/sim/api.js'
import { close, createSimHttpServer, listen } from '../../src/integrations/squarespace/sim/http.js'
import { SquarespaceSimStore } from '../../src/integrations/squarespace/sim/store.js'
import { systemClock } from '../../src/platform/clock.js'
import { main } from '../../scripts/verify-live/all.js'
import {
  Report,
  UsageError,
  maskEmail,
  maskPhone,
  maskUrlCredentials,
  parseArgs,
  redactDeep,
  writeReport,
} from '../../scripts/verify-live/lib.js'
import { seedSquarespaceSim } from '../../scripts/verify-live/sim-data.js'
import { runVerify, type CliRun } from './verify-live-helpers.js'

const runs: CliRun[] = []
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (runs.length) runs.pop()!.cleanup()
  while (cleanups.length) await cleanups.pop()!()
})
const run = async (argv: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> => {
  const r = await runVerify(main, argv, env)
  runs.push(r)
  return r
}
const today = new Date().toISOString().slice(0, 10)

describe('verify:all', () => {
  it('runs the three integrations against the simulators, writes a report for each plus a summary, and exits 0', async () => {
    const r = await run([
      '--sim',
      '--days',
      '90',
      '--send',
      '--sms-to',
      '+17865550151',
      '--email-to',
      'tester@example.com',
      '--event-timeout',
      '5',
    ])
    expect(r.code).toBe(0)
    expect(readdirSync(r.outDir).sort()).toEqual(
      [
        `${today}-all.md`,
        `${today}-aws.json`,
        `${today}-aws.md`,
        `${today}-smsgate.json`,
        `${today}-smsgate.md`,
        `${today}-squarespace-product-map.proposed.json`,
        `${today}-squarespace.json`,
        `${today}-squarespace.md`,
      ].sort(),
    )
    expect(r.out).toMatch(/smsgate\s+exit 0/)
    expect(r.out).toMatch(/squarespace\s+exit 0/)
    expect(r.out).toMatch(/aws\s+exit 0/)
    const summary = readFileSync(path.join(r.outDir, `${today}-all.md`), 'utf8')
    expect(summary).toContain('| smsgate | 0 |')
    expect(r.json('aws').items.find((i) => i.id === 'AWS-06')!.status).toBe('PASS')
    expect(r.json('smsgate').items.find((i) => i.id === 'SG-B4')!.status).toBe('PASS')
  })

  it('--to is split by shape: a phone number for the tablet, an address for SES', async () => {
    const sms = await run([
      '--sim',
      '--only-integration',
      'smsgate',
      '--send',
      '--to',
      '+17865550151',
      '--event-timeout',
      '5',
    ])
    expect(sms.json('smsgate').items.find((i) => i.id === 'SG-04')!.status).toBe('PASS')
    const mail = await run(['--sim', '--only-integration', 'aws', '--send', '--to', 'tester@example.com'])
    expect(mail.json('aws').items.find((i) => i.id === 'AWS-06')!.status).toBe('PASS')
    // --send with only a phone number: SES gets no recipient, so it does not send (and does not fail the run)
    const both = await run(['--sim', '--only-integration', 'aws', '--send', '--to', '+17865550151'])
    expect(both.json('aws').items.find((i) => i.id === 'AWS-06')!.status).toBe('SKIP')
  })

  it('with nothing configured every integration is "not configured", exit code 2, and only the summary is written', async () => {
    const r = await run([])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(
      /smsgate\s+exit 2\s+not configured: SMSGATE_DEVICE_URL, SMSGATE_USERNAME, SMSGATE_PASSWORD, SMSGATE_WEBHOOK_SECRET/,
    )
    expect(r.out).toMatch(/squarespace\s+exit 2\s+not configured: SQSP_API_KEY/)
    expect(r.out).toMatch(
      /aws\s+exit 2\s+not configured: AWS_ACCESS_KEY_ID \+ AWS_SECRET_ACCESS_KEY, SES_FROM_ADDRESS, S3_BUCKET/,
    )
    expect(readdirSync(r.outDir)).toEqual([`${today}-all.md`])
  })

  it('a FAIL anywhere wins over a missing configuration elsewhere (exit 1)', async () => {
    const store = new SquarespaceSimStore(systemClock, { pageSize: 50, order: 'asc', currency: 'USD' })
    seedSquarespaceSim(store, systemClock)
    const server = createSimHttpServer(
      new SquarespaceSimApi(store, systemClock, { apiKeys: ['right-key-123456'] }),
    )
    const url = await listen(server, 4597)
    cleanups.push(() => close(server))
    const r = await run([], { SQSP_API_KEY: 'wrong-key-123456', SQSP_API_BASE: url })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/squarespace\s+exit 1/)
    expect(r.out).toMatch(/smsgate\s+exit 2/)
  })

  it('--help and a bad option', async () => {
    const h = await run(['--help'])
    expect(h.code).toBe(0)
    expect(h.out).toContain('verify:smsgate, verify:squarespace and verify:aws')
    const bad = await run(['--sim', '--frobnicate'])
    expect(bad.code).toBe(2)
    expect(existsSync(path.join(bad.outDir, `${today}-all.md`))).toBe(false)
  })
})

describe('report plumbing', () => {
  const defs = [
    { id: 'T-1', title: 'First | with a pipe', source: 'doc a' },
    { id: 'T-2', title: 'Second', source: 'doc a' },
    { id: 'T-3', title: 'Third', source: 'doc b' },
  ]
  const make = (lines: string[] = []) =>
    new Report(
      'test',
      'Test run',
      defs,
      { mode: 'live', target: 'http://host' },
      () => new Date('2026-10-07T12:00:00Z'),
      (l) => lines.push(l),
    )

  it('lists every checklist item, SKIP for the ones nobody reported, and scrubs registered secrets everywhere', () => {
    const lines: string[] = []
    const r = make(lines)
    r.secret('hunter2-password')
    r.pass('T-1', 'logged in with hunter2-password')
    r.fail('T-2', 'rejected', 'change hunter2-password', ['evidence hunter2-password'])
    r.finalize()
    const json = JSON.stringify(r.toJson())
    const md = r.toMarkdown()
    expect(r.items().map((i) => [i.id, i.status])).toEqual([
      ['T-1', 'PASS'],
      ['T-2', 'FAIL'],
      ['T-3', 'SKIP'],
    ])
    for (const text of [json, md, lines.join('\n')]) expect(text).not.toContain('hunter2-password')
    expect(md).toContain('First \\| with a pipe')
    expect(md).toContain('## What to change')
    expect(r.exitCode()).toBe(1)
    expect(r.summary()).toEqual({ pass: 1, fail: 1, skip: 1 })
  })

  it('a FAIL is not overwritten by a later PASS or SKIP, and a SKIP never hides a decided result', () => {
    const r = make()
    r.fail('T-1', 'bad')
    r.pass('T-1', 'fine')
    r.skip('T-1', 'later')
    r.pass('T-2', 'ok')
    r.skip('T-2', 'later')
    r.skip('T-3', 'first skip')
    r.pass('T-3', 'then pass')
    expect(r.items().map((i) => i.status)).toEqual(['FAIL', 'PASS', 'PASS'])
  })

  it('writes <ISO date>-<integration>.md and .json into the directory it is given', () => {
    const r = make()
    r.finalize()
    const run = { outDir: '' } as { outDir: string }
    const dir = path.join(process.cwd(), '.data', `ops-kit-report-${process.pid}`)
    run.outDir = dir
    const written = writeReport(r, dir)
    expect(path.basename(written.md)).toBe('2026-10-07-test.md')
    expect(path.basename(written.json)).toBe('2026-10-07-test.json')
    expect(JSON.parse(readFileSync(written.json, 'utf8')).items).toHaveLength(3)
    return import('node:fs').then((fs) => fs.rmSync(dir, { recursive: true, force: true }))
  })

  it('helpers mask what must not be printed', () => {
    expect(maskPhone('+17865550151')).toBe('+17***0151')
    expect(maskEmail('someone@example.com')).toBe('s***@example.com')
    expect(maskUrlCredentials('https://user:pw@host/x?token=abc')).not.toMatch(/pw|abc/)
    expect(
      redactDeep({ a: 1, signing_key: 'k', nested: { password: 'p', list: [{ apiKey: 'x', ok: true }] } }),
    ).toEqual({ a: 1, signing_key: '***', nested: { password: '***', list: [{ apiKey: '***', ok: true }] } })
  })

  it('parseArgs accepts --name=value, rejects unknown options and missing values', () => {
    const known = { flags: ['sim'], options: ['to'] }
    expect(parseArgs(['--to=+1555', '--sim'], known).value('to')).toBe('+1555')
    expect(() => parseArgs(['--nope'], known)).toThrow(UsageError)
    expect(() => parseArgs(['--to'], known)).toThrow(/needs a value/)
    expect(() => parseArgs(['--to', '--sim'], known)).toThrow(/needs a value/)
    expect(() => parseArgs(['stray'], known)).toThrow(/Unexpected argument/)
    expect(() => parseArgs(['--days', 'x'], { flags: [], options: ['days'] }).number('days')).toThrow(
      /must be a number/,
    )
  })
})
