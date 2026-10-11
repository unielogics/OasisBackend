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
// result). Exit 0 when it ran (the numbers are for people to read), 2 on a usage or settings error.
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
}

export function parseArgs(argv: readonly string[]): EvalGuardOptions {
  const o: EvalGuardOptions = { fixture: DEFAULT_FIXTURE, concurrency: 4, cats: null, source: null, limit: null, judge: true, json: null }
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
  const report = await runGuardEval(fixture, { judge: provider, prices: judge.prices, concurrency: o.concurrency, timeoutMs: judge.timeoutMs, rows })
  if (o.json) writeFileSync(o.json, `${JSON.stringify(report, null, 1)}\n`)
  return { report, lines: formatEvalReport(report) }
}

if (process.argv[1] && process.argv[1].endsWith('eval-guard.ts')) {
  evalGuard(process.argv.slice(2)).then(
    ({ lines }) => {
      console.log(lines.join('\n'))
      process.exit(0)
    },
    (e: unknown) => {
      console.error((e as Error).message)
      process.exit(2)
    },
  )
}
