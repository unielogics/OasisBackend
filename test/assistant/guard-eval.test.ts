// The guard eval (design section 3c, test d): scripts/eval-guard.ts runs the WHOLE guard (the deterministic layers, then the policy
// judge through createAiProvider) over the eval fixture and prints recall per category and the false-block rate. W4 runs it against
// Bedrock with the operator's profile; here it runs with the simulator only (AI_PROVIDER=sim never reaches AWS).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { evalGuard, parseArgs } from '../../scripts/eval-guard.js'
import { SimAiProvider, simText } from '../../src/integrations/ai/sim.js'
import { loadEvalFixture, runGuardEval } from '../../src/modules/assistant/guard-eval.js'

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
    expect(parseArgs([])).toMatchObject({ fixture: 'test/assistant/fixtures/guard-eval.json', concurrency: 4, judge: true })
  })
})
