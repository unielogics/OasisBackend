// pnpm verify:ai  -  checks that this account and identity can reach Claude on Amazon Bedrock the way the app does (ADR 0160,
// docs/aws-setup.md "The AI assistant"): the settings name a Claude inference profile, and ONE Converse call of one output token
// through the app's own BedrockProvider is answered (a few input tokens: far below a cent). Each refusal is named for what it
// is: the app identity lacks bedrock:InvokeModel (pnpm aws:provision --bedrock), the account has no model access (the Anthropic
// use-case form and agreement), or the account's quota for the model is 0 ("not available for this account": a support case).
// --probe-effort adds up to two more one-token calls to see which effort field the model accepts (AI_BEDROCK_EFFORT_MODE).
//
// It never changes anything, never prints a credential, and contacts instance metadata only with --instance-profile.
import { applySecretEnvironment } from '../../src/config/secrets-source.js'
import { aiEnvFragment } from '../../src/integrations/ai/env.js'
import { CLAUDE_BEDROCK_MODELS, TARGET_ASSISTANT_MODEL, findClaudeModel } from '../../src/integrations/ai/models.js'
import {
  BedrockProvider,
  MODEL_ACCESS_RE,
  createBedrockClient,
  type BedrockEffortMode,
} from '../../src/integrations/ai/bedrock.js'
import { AiProviderError, type AiConverseRequest } from '../../src/integrations/ports/ai.js'
import {
  MissingConfig,
  Report,
  UsageError,
  cli,
  type ItemDef,
  type RunContext,
  type RunResult,
} from './lib.js'
import { BedrockSim, type BedrockSimScenario } from './sim-bedrock.js'

const DOC = 'docs/aws-setup.md, The AI assistant: Claude on Amazon Bedrock'

export const AI_ITEMS: readonly ItemDef[] = [
  {
    id: 'AI-01',
    title: 'Settings: AI_BEDROCK_MODEL_ID names a Claude inference profile the IAM grant covers, AI_BEDROCK_REGION a region',
    source: `${DOC}, settings`,
  },
  {
    id: 'AI-02',
    title: 'Bedrock: a one-token Converse call through the app BedrockProvider is answered',
    source: `${DOC}, steps 1 to 4`,
  },
  {
    id: 'AI-03',
    title: 'Bedrock: which effort field the model accepts (--probe-effort)',
    source: `${DOC}, effort`,
  },
]

export const AI_OPTIONS = {
  flags: ['instance-profile', 'probe-effort'],
  options: ['sim-port', 'sim-scenario', 'max-tokens', 'model'],
} as const

const SCENARIOS: readonly BedrockSimScenario[] = [
  'ok',
  'access_denied',
  'model_access',
  'quota',
  'throttled',
  'unavailable',
  'invalid_model',
  'refusal',
  'no_effort',
]

const BAD_CREDENTIALS =
  /UnrecognizedClientException|InvalidSignatureException|ExpiredToken|InvalidClientTokenId|CredentialsProviderError|SignatureDoesNotMatch/

const ping = (maxTokens: number): AiConverseRequest => ({
  system: [],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word OK.' }] }],
  maxTokens,
})

const LISTED = CLAUDE_BEDROCK_MODELS.map((m) => m.profileId).join(', ')

/** The Claude model of an AI_BEDROCK_MODEL_ID in words, and its foundation model id (for the console and the CLI). */
function describeModel(model: string): { label: string; foundation: string } {
  const m = findClaudeModel(model)
  return {
    label: m?.label ?? model,
    foundation: (m?.foundationModel ?? model.replace(/^(us|eu|apac|global)\./, '')).replace(/\*$/, ''),
  }
}

/** What an AiProviderError from the ping means for the operator, and what to do. */
export function explain(
  e: AiProviderError,
  ctx: { model: string; region: string },
): { detail: string; fix: string } {
  const m = e.message
  const d = describeModel(ctx.model)
  if (e.kind === 'access_denied' && /quota:/.test(m))
    return {
      detail: `QUOTA: the account's quota for ${ctx.model} is 0 ("not available for this account"): ${m}`,
      fix: `Open a free AWS Support case (Account and billing) asking to apply the default Bedrock quota "On-demand model inference tokens per minute" (and requests per minute) for Anthropic ${d.label}, cross-region, in ${ctx.region}; the Service Quotas API refuses an increase to a value at or below the default. Until then run on a model the account has quota for (AI_BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-6). Text and steps: ${DOC}, step 2.`,
    }
  if (e.kind === 'access_denied' && BAD_CREDENTIALS.test(m))
    return {
      detail: `the credentials were refused: ${m}`,
      fix: 'Check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN (temporary keys expire), AWS_PROFILE, or pass --instance-profile on the app host.',
    }
  if (e.kind === 'access_denied' && MODEL_ACCESS_RE.test(m))
    return {
      detail: `MODEL ACCESS: the account may not use ${ctx.model} yet: ${m}`,
      fix: `Bedrock console, Model access: the Anthropic use-case form and the model agreement (Marketplace offer) must be complete for ${d.foundation}; check with aws bedrock get-foundation-model-availability --model-id ${d.foundation} --region ${ctx.region}. ${DOC}, step 1.`,
    }
  if (e.kind === 'access_denied')
    return {
      detail: `IAM: this identity may not call bedrock:InvokeModel: ${m}`,
      fix: `Grant it: pnpm aws:provision ...the same flags as before... --bedrock --apply (adds InvokeClaude and InvokeClaudeRouted to oasis-app-runtime), then run this check again with --instance-profile on the app host. ${DOC}, step 3.`,
    }
  if (e.kind === 'invalid_request')
    return {
      detail: `the request was rejected: ${m}`,
      fix: `AI_BEDROCK_MODEL_ID must be an inference profile id (one of ${LISTED}) and AI_BEDROCK_REGION a region of that profile (us-east-1); a rejected effort field means AI_BEDROCK_EFFORT_MODE must stay off.`,
    }
  if (e.kind === 'throttled')
    return {
      detail: `throttled: ${m}`,
      fix: `Run again in a minute; if it keeps failing the account's tokens-per-minute quota is too low for even one call (${DOC}, step 2).`,
    }
  if (e.kind === 'timeout' || e.kind === 'unavailable')
    return {
      detail: `Bedrock did not answer (${e.kind}): ${m}`,
      fix: 'A transient outage or a network path problem from this host: run again; check outbound HTTPS to bedrock-runtime.<region>.amazonaws.com.',
    }
  return {
    detail: `${e.kind}: ${m}`,
    fix: 'Unexpected: keep the report and look at the AWS exception name above.',
  }
}

/** The defaults of the two settings this check always names. */
const s0 = () => aiEnvFragment.pick({ AI_BEDROCK_REGION: true, AI_BEDROCK_MODEL_ID: true }).parse({})

export async function runAi(ctx: RunContext): Promise<RunResult> {
  try {
    return await runInner(ctx)
  } catch (e) {
    if (e instanceof MissingConfig) return { missing: e }
    throw e
  }
}

async function runInner(ctx: RunContext): Promise<RunResult> {
  const { args } = ctx
  // --model: try another listed model before switching AI_BEDROCK_MODEL_ID (the env files win over a variable on the command line)
  const modelArg = args.value('model')
  if (modelArg !== undefined && !modelArg.trim()) throw new UsageError('--model needs an inference profile id')
  const env = modelArg ? { ...ctx.env, AI_BEDROCK_MODEL_ID: modelArg.trim() } : ctx.env
  const sim = args.flag('sim')
  const scenario = args.value('sim-scenario') as BedrockSimScenario | undefined
  if (scenario !== undefined && !sim) throw new UsageError('--sim-scenario is for --sim')
  if (scenario !== undefined && !SCENARIOS.includes(scenario))
    throw new UsageError(`--sim-scenario must be one of ${SCENARIOS.join(', ')}`)
  const maxTokens = args.number('max-tokens') ?? 1
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 64)
    throw new UsageError('--max-tokens must be an integer from 1 to 64')

  const parsed = aiEnvFragment
    .pick({
      AI_PROVIDER: true,
      AI_ENABLED: true,
      AI_BEDROCK_REGION: true,
      AI_BEDROCK_MODEL_ID: true,
      AI_TIMEOUT_MS: true,
      AI_EFFORT: true,
      AI_BEDROCK_EFFORT_MODE: true,
    })
    .safeParse(env)

  let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined
  let endpoint: string | undefined
  let bedrockSim: BedrockSim | undefined
  if (sim) {
    bedrockSim = new BedrockSim({ scenario: scenario ?? 'ok' })
    endpoint = await bedrockSim.start(args.number('sim-port') ?? 0)
    credentials = { accessKeyId: 'AKIDSIMULATOR', secretAccessKey: 'simulator-secret' }
  } else {
    const haveKeys = !!env.AWS_ACCESS_KEY_ID && !!env.AWS_SECRET_ACCESS_KEY
    if (!haveKeys && !env.AWS_PROFILE && !env.AWS_SHARED_CREDENTIALS_FILE && !args.flag('instance-profile'))
      throw new MissingConfig(
        'ai',
        [
          {
            name: 'AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY',
            why: 'credentials for the call (or AWS_PROFILE=<profile>, or AWS_SHARED_CREDENTIALS_FILE=<file>, or --instance-profile on the app host to test the role the app uses). Nothing probes instance metadata unless you pass --instance-profile.',
          },
        ],
        [
          `Optional: AI_BEDROCK_REGION (us-east-1), AI_BEDROCK_MODEL_ID (default ${s0().AI_BEDROCK_MODEL_ID}; ${TARGET_ASSISTANT_MODEL} once its quota is raised), AI_BEDROCK_EFFORT_MODE, AI_EFFORT.`,
          `Steps: ${DOC}.`,
        ],
      )
    // the SDK's default chain must not fall through to instance metadata unless asked
    if (!args.flag('instance-profile')) process.env.AWS_EC2_METADATA_DISABLED = 'true'
    if (haveKeys)
      credentials = {
        accessKeyId: env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
      }
  }

  const s = parsed.success ? parsed.data : s0()
  const region = s.AI_BEDROCK_REGION
  const model = s.AI_BEDROCK_MODEL_ID
  const report = new Report(
    'ai',
    'AI assistant (Claude on Amazon Bedrock) live verification',
    AI_ITEMS,
    { mode: sim ? 'sim' : 'live', target: `region ${region}, model ${model}` },
    ctx.now,
    ctx.log,
  )
  report.secret(credentials?.secretAccessKey)
  report.secret(credentials?.sessionToken)
  const r = report
  const client = createBedrockClient({
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(credentials ? { credentials } : {}),
  })
  try {
    // 1. settings
    if (!parsed.success) {
      r.fail(
        'AI-01',
        `invalid AI settings: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        'Fix the AI_* lines in /etc/oasis/common.env (deploy/env/common.env.example documents each).',
      )
      for (const id of ['AI-02', 'AI-03']) r.skip(id, 'the settings are invalid')
      return { report }
    }
    const p = parsed.data
    if (!/^(us|eu|apac|global)\.anthropic\.claude-/.test(model) || !/^[a-z]{2}(-[a-z]+)+-\d$/.test(region))
      r.fail(
        'AI-01',
        `AI_BEDROCK_MODEL_ID=${model}, AI_BEDROCK_REGION=${region}`,
        `The app calls Claude through a cross-region inference profile: AI_BEDROCK_MODEL_ID one of ${LISTED}, with AI_BEDROCK_REGION=us-east-1.`,
      )
    else if (!findClaudeModel(model))
      r.fail(
        'AI-01',
        `AI_BEDROCK_MODEL_ID=${model} is not one of the models the app role may call (${LISTED})`,
        'Use one of those, or add the model to src/integrations/ai/models.ts (its prices too) and re-run pnpm aws:provision --bedrock --apply so the IAM grant covers it.',
      )
    else
      r.pass(
        'AI-01',
        `${model} (${describeModel(model).label}) in ${region}; effort ${p.AI_EFFORT} sent as ${p.AI_BEDROCK_EFFORT_MODE}; the app runs AI_PROVIDER=${p.AI_PROVIDER}, AI_ENABLED=${p.AI_ENABLED}`,
      )
    if (p.AI_PROVIDER !== 'bedrock')
      r.note(
        `AI_PROVIDER=${p.AI_PROVIDER}: the app itself does not call Bedrock yet; this check calls it directly with the same provider code.`,
      )

    // 2. the ping, exactly as the app would send it (its effort mode included)
    const provider = (mode: BedrockEffortMode) =>
      new BedrockProvider({
        client,
        modelId: model,
        timeoutMs: p.AI_TIMEOUT_MS,
        effortMode: mode,
        defaultEffort: p.AI_EFFORT,
      })
    let pinged = false
    try {
      const a = await provider(p.AI_BEDROCK_EFFORT_MODE).converse(ping(maxTokens))
      const u = a.usage
      if (a.stopReason === 'end_turn' || a.stopReason === 'max_tokens') {
        pinged = true
        r.pass(
          'AI-02',
          `answered in ${a.latencyMs} ms (stop ${a.rawStopReason}, ${u.inputTokens} tokens in, ${u.outputTokens} out)`,
        )
      } else
        r.fail(
          'AI-02',
          `the model answered but stopped with ${a.rawStopReason}`,
          'A refusal of a one-word ping is not expected: keep the report and check the model id.',
        )
    } catch (e) {
      if (!(e instanceof AiProviderError)) throw e
      const x = explain(e, { model, region })
      r.fail('AI-02', x.detail, x.fix)
    }

    // 3. which effort field the model takes
    if (!args.flag('probe-effort'))
      r.skip('AI-03', 'pass --probe-effort to try the effort fields (up to two more one-token calls)')
    else if (!pinged) r.skip('AI-03', 'the ping did not pass')
    else {
      const results: string[] = []
      const accepted: BedrockEffortMode[] = []
      for (const mode of ['output_config', 'additional_fields'] as const) {
        try {
          await provider(mode).converse(ping(maxTokens))
          accepted.push(mode)
          results.push(`${mode}: accepted`)
        } catch (e) {
          if (!(e instanceof AiProviderError)) throw e
          results.push(`${mode}: ${e.kind} (${e.message})`)
        }
      }
      const configured = p.AI_BEDROCK_EFFORT_MODE
      if (configured !== 'off' && !accepted.includes(configured))
        r.fail(
          'AI-03',
          `AI_BEDROCK_EFFORT_MODE=${configured} is rejected: ${results.join('; ')}`,
          `Set AI_BEDROCK_EFFORT_MODE=${accepted[0] ?? 'off'} in common.env and restart.`,
        )
      else
        r.pass(
          'AI-03',
          accepted.length
            ? `${accepted.join(' and ')} accepted (AI_BEDROCK_EFFORT_MODE=${accepted[0]} sends AI_EFFORT); now ${configured}`
            : `neither field is accepted: keep AI_BEDROCK_EFFORT_MODE=off (the model runs at its default effort)`,
          results,
        )
    }
  } finally {
    client.destroy()
    await bedrockSim?.stop()
  }
  return { report }
}

export const HELP = `pnpm verify:ai [options]

Checks that this account and identity can call Claude on Amazon Bedrock the way the app does: one Converse call of one output
token through the app's BedrockProvider (a few input tokens: far below a cent). Names the cause of a refusal: IAM (pnpm
aws:provision --bedrock), model access (the Anthropic use-case form and agreement) or the account quota of 0 ("not available for
this account"). See docs/aws-setup.md, "The AI assistant: Claude on Amazon Bedrock".

Environment: AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY (or AWS_PROFILE, AWS_SHARED_CREDENTIALS_FILE, or --instance-profile)
Optional: AI_BEDROCK_REGION AI_BEDROCK_MODEL_ID AI_BEDROCK_EFFORT_MODE AI_EFFORT AI_TIMEOUT_MS
With OASIS_SECRET_ID set, the settings are read from that secret first, like the app does.

  --instance-profile    use the IAM role of this EC2 host (the only way instance metadata is contacted)
  --probe-effort        also try the two effort fields (up to two more one-token calls) and say which one the model accepts
  --model ID            call this inference profile instead of AI_BEDROCK_MODEL_ID (e.g. us.anthropic.claude-sonnet-5-5 before
                        switching to it; it must be one the app role is granted)
  --max-tokens N        output tokens of the ping (default 1)
  --sim                 run against the built-in Bedrock stand-in (--sim-port, --sim-scenario ${SCENARIOS.join('|')})
  --out-dir DIR         where reports go (default docs/live-verification)
  --json                also print the JSON summary
`

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  log: (l: string) => void = console.log,
): Promise<number> {
  return cli('verify:ai', HELP, argv, runAi, AI_OPTIONS, env, log)
}

if (process.argv[1] && process.argv[1].endsWith('ai.ts')) {
  // the settings may live in the Secrets Manager secret (OASIS_SECRET_ID), like the app's
  applySecretEnvironment().then(
    () => main(process.argv.slice(2)).then((c) => process.exit(c)),
    (e: unknown) => {
      console.error((e as Error).message)
      process.exit(2)
    },
  )
}
