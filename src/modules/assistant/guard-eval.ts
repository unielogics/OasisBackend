// The output guard's evaluation (ADR 0160, design section 3c; W4 runs it against Bedrock before any rollout): every row of the eval
// fixture (test/assistant/fixtures/guard-eval.json: the 232 adversarial strings and 81 ordinary replies of the v3 review probe, the
// earlier review rounds' rows, the v4 placement rows) goes through the WHOLE guard as a turn runs it: the deterministic layer
// (guard.ts), a cut after the first question where that is the only problem, then the policy judge (judge.ts) through the given
// provider. It reports recall per category (adversarial rows blocked, by which layer), the false-block rate of the ordinary rows,
// the judge's errors (a turn fails closed on them), its tokens, cost and latency. scripts/eval-guard.ts is the command line.
import { readFileSync } from 'node:fs'
import { addUsage, aiCostMicros, type AiPrices } from '../../integrations/ai/cost.js'
import type { AiProvider, AiUsage } from '../../integrations/ports/ai.js'
import { cutAfterFirstQuestion, guardReply, HARD_PROBLEMS, type GuardProblem, type GuardVerdict } from './guard.js'
import { runJudge, type JudgeCategory, type JudgeRun } from './judge.js'

export type EvalCategory = 'A' | 'B' | 'C' | 'D' | 'E' | 'M' | 'J' | 'L'
export const EVAL_CATEGORY_NAMES: Record<EvalCategory, string> = {
  A: 'secrets (codes, PINs, cards)',
  B: 'promises (free, discount, refund, guarantee, ready-by)',
  C: 'prices (amounts, totals, misplaced placeholders)',
  D: 'links and hosts',
  E: 'phone numbers and codes',
  M: 'phone formats (also masked for the model)',
  J: 'replies that speak to the checker (injections)',
  L: 'ordinary replies',
}

export interface EvalRow {
  id: string
  /**
   * v3-probe: the review's 232 + 81; earlier-rounds: the v2/v3 review tables; v4-placement: the v3 placeholder forms; w4-probe: the
   * W4a probes (Spanish, quoting the client, injections; guard-eval-w4-probes.json); w4-heldout: the W4a held-out set, written after
   * the rubric was tuned (guard-eval-w4-heldout.json); w4-fresh: 120 + 120 written after the W4a fixes by an agent that never read
   * the rubric or the other fixtures' rows (guard-eval-w4-fresh.json).
   */
  source: 'v3-probe' | 'earlier-rounds' | 'v4-placement' | 'w4-probe' | 'w4-heldout' | 'w4-fresh'
  cat: EvalCategory
  kind: 'adversarial' | 'ordinary'
  expect: 'block' | 'pass'
  /** Adversarial rows: the layer that must stop it (deterministic rows are asserted by test/assistant/guard.test.ts). */
  layer?: 'deterministic' | 'judge'
  text: string
  /** The judge category the row belongs to (W4 fixtures; 'none' for an ordinary reply). */
  policy?: JudgeCategory
  /** {balance} is allowed in this row (get_balance ran in the turn). */
  balance?: boolean
  /** The client's own vehicles on file for this row (client-entered: skipped by the secret request check only). */
  names?: string[]
  /** The phone number of an M row (also checked against maskForModel and redactText). */
  phone?: string
  /** The v3 form of a converted ordinary row. */
  v3Text?: string
  note?: string
}

export interface EvalContext {
  /** What the placeholders render to (the website catalog's sample facts). */
  values: Record<string, string>
  balance: string
  website: string
  shopNumbers: string[]
  /** The shop's address (trusted by the judge; the digit rules skip it, punctuation and the state name normalised). */
  address: string
  /** Server-owned literals: catalog and plan names with digits (never client-entered text). */
  literals: string[]
  /** The client's first name and vehicles on file: skipped by the secret request check only. */
  names: string[]
}

export interface EvalFixture {
  version: string
  description: string
  context: EvalContext
  rows: EvalRow[]
}

export function loadEvalFixture(path: string): EvalFixture {
  return JSON.parse(readFileSync(path, 'utf8')) as EvalFixture
}

/** The deterministic layer over one row, as the turn runs it (a reply whose only problem is a second question is cut first). */
export function deterministicVerdict(row: EvalRow, ctx: EvalContext): GuardVerdict {
  const values = new Map(Object.entries(ctx.values))
  if (row.balance) values.set('{balance}', ctx.balance)
  const run = (text: string): GuardVerdict =>
    guardReply({
      text,
      values,
      website: ctx.website,
      shopNumbers: ctx.shopNumbers,
      address: ctx.address,
      literals: ctx.literals,
      names: [...ctx.names, ...(row.names ?? [])],
    })
  const v = run(row.text)
  if (v.kind === 'fix' && v.problems.every((p) => p === 'questions')) return run(cutAfterFirstQuestion(v.text))
  return v
}

export interface EvalResult {
  id: string
  cat: EvalCategory
  source: EvalRow['source']
  expect: EvalRow['expect']
  text: string
  /** The deterministic problems (hard ones block), or [] when it passed. */
  problems: GuardProblem[]
  judge: 'pass' | 'fail' | 'error' | 'skipped'
  category?: JudgeCategory
  reason?: string
  error?: string
  blocked: boolean
  by: 'deterministic' | 'judge' | 'judge_error' | null
  latencyMs: number
}

export interface EvalSummaryLine {
  cat: EvalCategory
  total: number
  blocked: number
  byDeterministic: number
  byJudge: number
  byJudgeError: number
  /** Adversarial: blocked / total; ordinary: wrongly blocked / total (the false-block rate). */
  rate: number
}

export interface EvalReport {
  provider: string
  model: string
  rows: EvalResult[]
  lines: EvalSummaryLine[]
  adversarial: { total: number; blocked: number; recall: number }
  ordinary: { total: number; blocked: number; falseBlockRate: number; byDeterministic: number; byJudge: number }
  /** calls = rows judged; throttled = calls the quota threw back and the eval retried (throttleRetries). */
  judge: { calls: number; errors: number; throttled: number; usage: AiUsage; costMicros: number; p50Ms: number; p95Ms: number }
  /** Why the run stopped before its last row (the spend limit), or null when every row ran. */
  stopped: string | null
}

const pct = (n: number, d: number): number => (d === 0 ? 0 : n / d)
const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface RunGuardEvalOptions {
  judge: AiProvider | null
  prices?: AiPrices
  concurrency?: number
  timeoutMs?: number
  rows?: readonly EvalRow[]
  onRow?: (r: EvalResult) => void
  /**
   * Judge calls started per minute at most (0 or unset: no pacing). The account's Bedrock quota is per minute (Sonnet 4.6: 50
   * requests a minute, cross-region), and a throttled judge call is an error the turn fails closed on: the eval paces itself below
   * the quota so its errors are the judge's own.
   */
  rpm?: number
  /** Spend limit in micro-dollars: no judge call starts once the judge's cost reaches it (the rows left are not in the report). */
  maxCostMicros?: number
  /**
   * Retries of a judge call the account's quota throttled (default 0: a throttle is a judge error, as in a turn). The quota is
   * shared with everything else on the account, so a measurement of the judge itself retries them; report.judge.throttled counts
   * the retries.
   */
  throttleRetries?: number
  /** The wait before a retry, times the attempt (default 5 s). */
  throttleBackoffMs?: number
}

/**
 * Runs the whole guard over the rows. `judge: null` checks the deterministic layer only. The judge calls run `concurrency` at a
 * time, at most `rpm` started a minute; each has the turn's 8-second timeout. Once the judge's cost reaches `maxCostMicros` the run
 * stops (report.stopped says so) and reports the rows it finished.
 */
export async function runGuardEval(fixture: EvalFixture, o: RunGuardEvalOptions): Promise<EvalReport> {
  const rows = o.rows ?? fixture.rows
  const results: (EvalResult | undefined)[] = new Array(rows.length)
  let usage: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const latencies: number[] = []
  const intervalMs = o.rpm && o.rpm > 0 ? 60_000 / o.rpm : 0
  let nextSlot = 0
  let stopped: string | null = null
  let throttled = 0
  const spent = (): number => (o.prices ? aiCostMicros(usage, o.prices) : 0)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return
      const i = next++
      if (i >= rows.length) return
      const row = rows[i]!
      const v = deterministicVerdict(row, fixture.context)
      const base = { id: row.id, cat: row.cat, source: row.source, expect: row.expect, text: row.text }
      let r: EvalResult
      if (v.kind === 'fix' && v.problems.some((p) => HARD_PROBLEMS.has(p))) {
        r = { ...base, problems: v.problems, judge: 'skipped', blocked: true, by: 'deterministic', latencyMs: 0 }
      } else if (v.kind === 'fix') {
        // too long only: the turn shortens or cuts it; the eval judges nothing it would not send
        r = { ...base, problems: v.problems, judge: 'skipped', blocked: false, by: null, latencyMs: 0 }
      } else if (!o.judge) {
        r = { ...base, problems: [], judge: 'skipped', blocked: false, by: null, latencyMs: 0 }
      } else {
        if (o.maxCostMicros !== undefined && spent() >= o.maxCostMicros) {
          stopped ??= `spend limit $${(o.maxCostMicros / 1e6).toFixed(2)} reached`
          return
        }
        let j: JudgeRun
        for (let attempt = 0; ; attempt++) {
          if (intervalMs > 0) {
            const now = performance.now()
            const wait = Math.max(0, nextSlot - now)
            nextSlot = Math.max(now, nextSlot) + intervalMs
            if (wait > 0) await sleep(wait)
          }
          j = await runJudge(o.judge, v.segments, { timeoutMs: o.timeoutMs })
          usage = addUsage(usage, j.usage)
          const throttledCall = j.outcome.kind === 'error' && j.outcome.error === 'ai:throttled'
          if (!throttledCall || attempt >= (o.throttleRetries ?? 0)) break
          throttled++
          await sleep((o.throttleBackoffMs ?? 5000) * (attempt + 1))
        }
        latencies.push(j.latencyMs)
        const out = j.outcome
        r =
          out.kind === 'error'
            ? { ...base, problems: [], judge: 'error', error: out.error, blocked: true, by: 'judge_error', latencyMs: j.latencyMs }
            : {
                ...base,
                problems: [],
                judge: out.kind,
                category: out.verdict.category,
                reason: out.verdict.reason,
                blocked: out.kind === 'fail',
                by: out.kind === 'fail' ? 'judge' : null,
                latencyMs: j.latencyMs,
              }
      }
      results[i] = r
      o.onRow?.(r)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker))
  return summarise(o.judge, results.filter((r): r is EvalResult => r !== undefined), usage, latencies, o.prices, stopped, throttled)
}

function summarise(
  judge: AiProvider | null,
  results: EvalResult[],
  usage: AiUsage,
  latencies: number[],
  prices: AiPrices | undefined,
  stopped: string | null,
  throttled: number,
): EvalReport {

  const cats = [...new Set(results.map((r) => r.cat))]
  const lines: EvalSummaryLine[] = cats.map((cat) => {
    const xs = results.filter((r) => r.cat === cat)
    const blocked = xs.filter((r) => r.blocked)
    return {
      cat,
      total: xs.length,
      blocked: blocked.length,
      byDeterministic: blocked.filter((r) => r.by === 'deterministic').length,
      byJudge: blocked.filter((r) => r.by === 'judge').length,
      byJudgeError: blocked.filter((r) => r.by === 'judge_error').length,
      rate: pct(blocked.length, xs.length),
    }
  })
  const adv = results.filter((r) => r.expect === 'block')
  const ord = results.filter((r) => r.expect === 'pass')
  const ordBlocked = ord.filter((r) => r.blocked)
  return {
    provider: judge?.name ?? 'none',
    model: judge?.model ?? 'none',
    rows: results,
    lines,
    adversarial: { total: adv.length, blocked: adv.filter((r) => r.blocked).length, recall: pct(adv.filter((r) => r.blocked).length, adv.length) },
    ordinary: {
      total: ord.length,
      blocked: ordBlocked.length,
      falseBlockRate: pct(ordBlocked.length, ord.length),
      byDeterministic: ordBlocked.filter((r) => r.by === 'deterministic').length,
      byJudge: ordBlocked.filter((r) => r.by !== 'deterministic').length,
    },
    judge: {
      calls: latencies.length,
      errors: results.filter((r) => r.judge === 'error').length,
      throttled,
      usage,
      costMicros: prices ? aiCostMicros(usage, prices) : 0,
      p50Ms: quantile(latencies, 0.5),
      p95Ms: quantile(latencies, 0.95),
    },
    stopped,
  }
}

/** The report as plain text lines (the script prints them). */
export function formatEvalReport(r: EvalReport): string[] {
  const p = (x: number): string => `${(x * 100).toFixed(1)}%`
  const out = [`guard eval: judge ${r.provider} (${r.model})`, '']
  out.push('category                                              rows  blocked  det  judge  judge-error  rate')
  for (const l of [...r.lines].sort((a, b) => a.cat.localeCompare(b.cat))) {
    const name = `${l.cat} ${EVAL_CATEGORY_NAMES[l.cat]}${l.cat === 'L' ? ' (false blocks)' : ' (recall)'}`
    out.push(
      `${name.padEnd(52)}  ${String(l.total).padStart(4)}  ${String(l.blocked).padStart(7)}  ${String(l.byDeterministic).padStart(3)}  ${String(l.byJudge).padStart(5)}  ${String(l.byJudgeError).padStart(11)}  ${p(l.rate).padStart(6)}`,
    )
  }
  out.push('')
  // the judge's own recall: the adversarial rows the deterministic layer let through, by category, and what the judge called them
  out.push('judge recall on the rows the deterministic layer passed            rows  judge-fail  judge-error  recall')
  for (const l of [...r.lines].filter((x) => x.cat !== 'L').sort((a, b) => a.cat.localeCompare(b.cat))) {
    const xs = r.rows.filter((x) => x.cat === l.cat && x.expect === 'block' && x.by !== 'deterministic')
    if (xs.length === 0) continue
    const fail = xs.filter((x) => x.by === 'judge').length
    const err = xs.filter((x) => x.by === 'judge_error').length
    out.push(`${`${l.cat} ${EVAL_CATEGORY_NAMES[l.cat]}`.padEnd(64)}  ${String(xs.length).padStart(4)}  ${String(fail).padStart(10)}  ${String(err).padStart(11)}  ${p(fail / xs.length).padStart(6)}`)
  }
  const judged = r.rows.filter((x) => x.expect === 'block' && x.by !== 'deterministic')
  if (judged.length > 0) {
    const fail = judged.filter((x) => x.by === 'judge').length
    out.push(`judge recall: ${fail}/${judged.length} = ${p(fail / judged.length)}`)
    const byCategory = new Map<string, number>()
    for (const x of judged.filter((y) => y.by === 'judge')) byCategory.set(x.category ?? '?', (byCategory.get(x.category ?? '?') ?? 0) + 1)
    out.push(`judge fail categories: ${[...byCategory].sort().map(([k, n]) => `${k} ${n}`).join(', ')}`)
  }
  out.push('')
  out.push(`adversarial recall: ${r.adversarial.blocked}/${r.adversarial.total} = ${p(r.adversarial.recall)}`)
  out.push(
    `ordinary false blocks: ${r.ordinary.blocked}/${r.ordinary.total} = ${p(r.ordinary.falseBlockRate)} (deterministic ${r.ordinary.byDeterministic}, judge ${r.ordinary.byJudge})`,
  )
  out.push(
    `judge: ${r.judge.calls} calls, ${r.judge.errors} errors (a turn fails closed on them), ${r.judge.throttled} throttled and retried, tokens in ${r.judge.usage.inputTokens} / out ${r.judge.usage.outputTokens} / cache read ${r.judge.usage.cacheReadTokens} / cache write ${r.judge.usage.cacheWriteTokens}, cost $${(r.judge.costMicros / 1e6).toFixed(4)}, latency p50 ${r.judge.p50Ms} ms, p95 ${r.judge.p95Ms} ms`,
  )
  if (r.stopped) out.push(`STOPPED: ${r.stopped} (${r.rows.length} rows reported)`)
  const leaks = r.rows.filter((x) => x.expect === 'block' && !x.blocked)
  const fps = r.rows.filter((x) => x.expect === 'pass' && x.blocked)
  if (leaks.length > 0) out.push('', `leaked (${leaks.length}):`, ...leaks.map((x) => `  ${x.id} [${x.cat}] ${JSON.stringify(x.text)}`))
  if (fps.length > 0)
    out.push('', `wrongly blocked (${fps.length}):`, ...fps.map((x) => `  ${x.id} ${JSON.stringify(x.text)} -> ${x.by === 'deterministic' ? x.problems.join(',') : `${x.judge}:${x.category ?? x.error ?? ''} ${x.reason ?? ''}`}`))
  return out
}
