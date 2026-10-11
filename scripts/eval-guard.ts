// pnpm eval:guard  -  the output guard v4 over its eval fixture (ADR 0160, design section 3c): the deterministic layer, then the
// REAL policy judge through createAiProvider (AI_PROVIDER, AI_GUARD_MODEL_ID or AI_BEDROCK_MODEL_ID, AI_BEDROCK_REGION from the
// environment), exactly as a turn runs them. Prints recall per category, the false-block rate of the ordinary replies, the judge's
// errors, tokens, cost and latency.
//
// AI_PROVIDER=sim (the default) never reaches AWS: the simulator passes every reply, so the numbers are the deterministic layer's.
// W4 runs it against Bedrock with the operator's profile, for example:
//   AWS_PROFILE=<operator> AI_PROVIDER=bedrock AI_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6 pnpm eval:guard --concurrency 4
// (about 285 judge calls, one per row the deterministic layers pass, of ~750 input and ~40 output tokens each: about one US
// dollar on Sonnet 4.6 list prices).
//
// Options: --fixture <path> (default test/assistant/fixtures/guard-eval.json), --concurrency <n> (default 4), --cat A,B,...,
// --source v3-probe|earlier-rounds|v4-placement, --limit <n>, --no-judge (the deterministic layer only), --json <path> (every row's
// result), --rpm <n> (judge calls started a minute; default 40 on Bedrock, below the account's quota of 50 a minute: a throttled
// call is a judge error), --throttle-retries <n> (default 3 on Bedrock: the quota is the account's, shared with everything else; the
// report counts the retries), --budget-usd <x> (default 2: no judge call starts once the run's cost reaches it; the report says
// STOPPED). Exit 0 when it ran (the numbers are for people to read), 2 on a usage or settings error, 3 when the spend limit stopped
// it.
import { writeFileSync } from 'node:fs'
import { resolveAiPrices } from '../src/integrations/ai/cost.js'
import { aiEnvFragment } from '../src/integrations/ai/env.js'
import { createAiProvider, type AiProviderDeps } from '../src/integrations/ai/index.js'
import { judgeConfig } from '../src/modules/assistant/config.js'
import { formatEvalReport, loadEvalFixture, runGuardEval, type EvalReport } from '../src/modules/assistant/guard-eval.js'

export const DEFAULT_FIXTURE = 'test/assistant/fixtures/guard-eval.json'

export interface EvalGuardOptions {
  fixture: string
  concurrency: number
  cats: string[] | null
  source: string | null
  limit: number | null
  judge: boolean
  json: string | null
  /** Judge calls started per minute; null = 40 on Bedrock (the account's Sonnet 4.6 quota is 50), unpaced otherwise. */
  rpm: number | null
  /** The run's spend limit in US dollars (the judge's cost); no call starts once it is reached. */
  budgetUsd: number
  /** Retries of a throttled judge call (null = 3 on Bedrock, whose quota other work on the account shares; 0 otherwise). */
  throttleRetries: number | null
}

/** The default spend limit of one run (a full run on Sonnet 4.6 costs about $0.80). */
export const DEFAULT_BUDGET_USD = 2
/** The default pace on Bedrock, below the account's quota of 50 requests a minute (Sonnet 4.6, cross-region). */
export const DEFAULT_BEDROCK_RPM = 40

export function parseArgs(argv: readonly string[]): EvalGuardOptions {
  const o: EvalGuardOptions = { fixture: DEFAULT_FIXTURE, concurrency: 4, cats: null, source: null, limit: null, judge: true, json: null, rpm: null, budgetUsd: DEFAULT_BUDGET_USD, throttleRetries: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const value = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--fixture') o.fixture = value()
    else if (a === '--concurrency') o.concurrency = Math.max(1, Math.min(16, Number.parseInt(value(), 10) || 1))
    else if (a === '--cat') o.cats = value().split(',').map((x) => x.trim().toUpperCase())
    else if (a === '--source') o.source = value()
    else if (a === '--limit') o.limit = Math.max(1, Number.parseInt(value(), 10) || 1)
    else if (a === '--no-judge') o.judge = false
    else if (a === '--json') o.json = value()
    else if (a === '--throttle-retries') o.throttleRetries = Math.max(0, Number.parseInt(value(), 10) || 0)
    else if (a === '--rpm') o.rpm = Math.max(0, Number.parseInt(value(), 10) || 0)
    else if (a === '--budget-usd') {
      const usd = Number(value())
      if (!Number.isFinite(usd) || usd <= 0) throw new Error('--budget-usd needs a positive number')
      o.budgetUsd = usd
    }
    else throw new Error(`unknown option ${a}`)
  }
  return o
}

/** Runs the eval with the settings of `env` (process.env by default); returns the report and its printed lines. */
export async function evalGuard(argv: readonly string[], env: NodeJS.ProcessEnv = process.env, deps: AiProviderDeps = {}): Promise<{ report: EvalReport; lines: string[] }> {
  const o = parseArgs(argv)
  const ai = aiEnvFragment.parse(env)
  const assistantPrices = resolveAiPrices(ai).prices
  const judge = judgeConfig({ ...ai, AI_ENABLED: true }, assistantPrices)
  const fixture = loadEvalFixture(o.fixture)
  let rows = fixture.rows.filter((r) => (o.cats ? o.cats.includes(r.cat) : true) && (o.source ? r.source === o.source : true))
  if (o.limit !== null) rows = rows.slice(0, o.limit)
  const provider = o.judge ? createAiProvider({ ...ai, AI_BEDROCK_MODEL_ID: judge.modelId }, deps) : null
  const rpm = o.rpm ?? (ai.AI_PROVIDER === 'bedrock' ? DEFAULT_BEDROCK_RPM : 0)
  const report = await runGuardEval(fixture, {
    judge: provider,
    prices: judge.prices,
    concurrency: o.concurrency,
    timeoutMs: judge.timeoutMs,
    rows,
    rpm,
    maxCostMicros: Math.round(o.budgetUsd * 1e6),
    throttleRetries: o.throttleRetries ?? (ai.AI_PROVIDER === 'bedrock' ? 3 : 0),
  })
  if (o.json) writeFileSync(o.json, `${JSON.stringify(report, null, 1)}\n`)
  return { report, lines: formatEvalReport(report) }
}

if (process.argv[1] && process.argv[1].endsWith('eval-guard.ts')) {
  evalGuard(process.argv.slice(2)).then(
    ({ report, lines }) => {
      console.log(lines.join('\n'))
      process.exit(report.stopped ? 3 : 0)
    },
    (e: unknown) => {
      console.error((e as Error).message)
      process.exit(2)
    },
  )
}
