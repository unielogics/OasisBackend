// The guard eval (design section 3c, test d): scripts/eval-guard.ts runs the WHOLE guard (the deterministic layers, then the policy
// judge through createAiProvider) over the eval fixture and prints recall per category and the false-block rate. W4 runs it against
// Bedrock with the operator's profile; here it runs with the simulator only (AI_PROVIDER=sim never reaches AWS).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { evalGuard, parseArgs } from '../../scripts/eval-guard.js'
import { SimAiProvider, simText } from '../../src/integrations/ai/sim.js'
import { formatEvalReport, loadEvalFixture, runGuardEval } from '../../src/modules/assistant/guard-eval.js'

const fixture = loadEvalFixture(path.join(import.meta.dirname, 'fixtures', 'guard-eval.json'))
const dir = mkdtempSync(path.join(tmpdir(), 'guard-eval-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('pnpm eval:guard with the simulator', () => {
  it('runs every row through the deterministic layers and the judge; prints recall per category and the false-block rate', async () => {
    const out = path.join(dir, 'rows.json')
    const { report, lines } = await evalGuard(['--concurrency', '8', '--json', out], { AI_PROVIDER: 'sim' })
    expect(report.provider).toBe('sim')
    expect(report.rows).toHaveLength(fixture.rows.length)
    // the simulator passes every reply it judges: what is blocked is exactly the deterministic rows, no ordinary reply among them
    for (const r of report.rows) {
      const row = fixture.rows.find((x) => x.id === r.id)!
      expect(r.blocked, `${r.id} ${r.text}`).toBe(row.layer === 'deterministic')
    }
    expect(report.ordinary).toMatchObject({ total: fixture.rows.filter((r) => r.expect === 'pass').length, blocked: 0, falseBlockRate: 0 })
    expect(report.judge.calls).toBe(report.rows.filter((r) => r.judge !== 'skipped').length)
    expect(report.judge.errors).toBe(0)
    expect(report.judge.calls).toBeGreaterThan(fixture.rows.filter((r) => r.expect === 'pass').length - 1)
    // one line per category, the totals, the leaks for W4 to read
    for (const cat of ['A secrets', 'B promises', 'C prices', 'D links', 'E phone', 'L ordinary replies (false blocks)', 'M phone formats'])
      expect(lines.some((l) => l.startsWith(cat)), cat).toBe(true)
    expect(lines).toContain(`ordinary false blocks: 0/${report.ordinary.total} = 0.0% (deterministic 0, judge 0)`)
    expect(lines.some((l) => l.startsWith('adversarial recall: '))).toBe(true)
    expect(lines.some((l) => l.startsWith('leaked ('))).toBe(true)
    // the judge's own recall on what the deterministic layer let through (the simulator passes all of it)
    const judged = report.rows.filter((r) => r.expect === 'block' && r.by !== 'deterministic').length
    expect(lines).toContain(`judge recall: 0/${judged} = 0.0%`)
    expect(report.stopped).toBeNull()
    expect(JSON.parse(readFileSync(out, 'utf8')).rows).toHaveLength(fixture.rows.length)
  })

  it('a judge that fails everything blocks every adversarial row and every ordinary reply it reads; its errors fail closed', async () => {
    const strict = await runGuardEval(fixture, { judge: new SimAiProvider(() => simText('{"ok":false,"category":"other","reason":"no"}')), concurrency: 8 })
    expect(strict.adversarial.recall).toBe(1)
    expect(strict.ordinary.falseBlockRate).toBe(1)
    expect(strict.ordinary.byJudge).toBe(strict.ordinary.total)
    const broken = await runGuardEval(fixture, { judge: new SimAiProvider(() => ({ error: 'unavailable' })), rows: fixture.rows.filter((r) => r.cat === 'L').slice(0, 5) })
    expect(broken.judge.errors).toBe(5)
    expect(broken.rows.every((r) => r.blocked && r.by === 'judge_error')).toBe(true)
  })

  it('filters by category, source and count; --no-judge checks the deterministic layers only; unknown options are refused', async () => {
    const { report } = await evalGuard(['--cat', 'D,M', '--source', 'v3-probe', '--no-judge'], { AI_PROVIDER: 'sim' })
    expect(report.rows).toHaveLength(56)
    expect(report.judge.calls).toBe(0)
    expect(report.adversarial.recall).toBe(1)
    expect((await evalGuard(['--limit', '3'], { AI_PROVIDER: 'sim' })).report.rows).toHaveLength(3)
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/)
    expect(parseArgs([])).toMatchObject({ fixture: 'test/assistant/fixtures/guard-eval.json', concurrency: 4, judge: true, rpm: null, budgetUsd: 2, throttleRetries: null })
    expect(parseArgs(['--rpm', '30', '--budget-usd', '0.5'])).toMatchObject({ rpm: 30, budgetUsd: 0.5 })
    expect(() => parseArgs(['--budget-usd', '0'])).toThrow(/positive/)
  })

  it('paces the judge calls below the per-minute quota (a throttled call would be a judge error)', async () => {
    const rows = fixture.rows.filter((r) => r.cat === 'L').slice(0, 6)
    const began = performance.now()
    const report = await runGuardEval(fixture, { judge: new SimAiProvider(), rows, concurrency: 6, rpm: 3000 })
    expect(report.judge.calls).toBe(6)
    // 3000 a minute = one call every 20 ms: the sixth starts 100 ms after the first, whatever the concurrency
    expect(performance.now() - began).toBeGreaterThanOrEqual(95)
    expect(report.stopped).toBeNull()
  })

  it('retries a call the quota throttled when asked (the measurement is of the judge, not the account quota); counts the retries', async () => {
    const rows = fixture.rows.filter((r) => r.cat === 'L').slice(0, 1)
    const steps = () => [{ error: 'throttled' as const }, simText('{"reason":"a greeting","category":"none","ok":true}')]
    const retried = await runGuardEval(fixture, { judge: new SimAiProvider(steps()), rows, throttleRetries: 2, throttleBackoffMs: 1 })
    expect(retried.rows[0]).toMatchObject({ judge: 'pass', blocked: false })
    expect(retried.judge).toMatchObject({ calls: 1, errors: 0, throttled: 1 })
    // without retries a throttle is a judge error, as in a turn (fail closed)
    const once = await runGuardEval(fixture, { judge: new SimAiProvider(steps()), rows })
    expect(once.rows[0]).toMatchObject({ judge: 'error', error: 'ai:throttled', blocked: true, by: 'judge_error' })
    expect(once.judge).toMatchObject({ errors: 1, throttled: 0 })
  })

  it('stops at the spend limit: no judge call starts once the cost reaches it; the report says so and keeps the finished rows', async () => {
    const rows = fixture.rows.filter((r) => r.cat === 'L').slice(0, 10)
    const sim = new SimAiProvider(() => simText('{"ok":true,"category":"none","reason":""}', { usage: { inputTokens: 1000, outputTokens: 0 } }))
    // $3 per million input tokens: 3000 micro-dollars a call; the limit is reached after the second call
    const prices = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 }
    const report = await runGuardEval(fixture, { judge: sim, rows, concurrency: 1, prices, maxCostMicros: 5000 })
    expect(report.judge.calls).toBe(2)
    expect(report.rows).toHaveLength(2)
    expect(report.judge.costMicros).toBe(6000)
    expect(report.stopped).toBe('spend limit $0.01 reached')
    expect(formatEvalReport(report)).toContain('STOPPED: spend limit $0.01 reached (2 rows reported)')
  })
})
