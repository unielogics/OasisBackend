// pnpm verify:ai against the built-in Bedrock stand-in (real HTTP/2, the real SDK, the app's BedrockProvider): a one-token ping
// passes, and every refusal is named for what it is with the fix (IAM grant, model access, the account quota of 0), the effort
// probe says which field the model takes, and nothing runs without credentials chosen on purpose.
import { describe, expect, it } from 'vitest'
import { AI_ITEMS, main } from '../../../scripts/verify-live/ai.js'
import { main as mainAll } from '../../../scripts/verify-live/all.js'

const BASE = { AWS_EC2_METADATA_DISABLED: 'true' }

async function run(args: string[], env: Record<string, string | undefined> = BASE) {
  const lines: string[] = []
  const code = await main([...args, '--no-report'], env, (l) => lines.push(l))
  return { code, out: lines.join('\n') }
}

describe('verify:ai --sim', () => {
  it('the ping passes with the settings, the latency and the tokens; AI-03 waits for --probe-effort', async () => {
    const r = await run(['--sim'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(
      /PASS AI-01 .*us\.anthropic\.claude-sonnet-4-6 \(Claude Sonnet 4\.6\) in us-east-1; effort low sent as off; the app runs AI_PROVIDER=sim, AI_ENABLED=false/,
    )
    expect(r.out).toMatch(/PASS AI-02 .*answered in \d+ ms \(stop max_tokens, 12 tokens in, 1 out\)/)
    expect(r.out).toMatch(/SKIP AI-03 .*pass --probe-effort/)
    expect(r.out).toContain('note AI_PROVIDER=sim: the app itself does not call Bedrock yet')
    expect(r.out).toContain('ai: 2 PASS, 0 FAIL, 1 SKIP')
    expect(AI_ITEMS.map((i) => i.id)).toEqual(['AI-01', 'AI-02', 'AI-03'])
  })

  it('names each refusal and its fix', async () => {
    const cases: Array<[string, RegExp, RegExp]> = [
      [
        'access_denied',
        /FAIL AI-02 .*IAM: this identity may not call bedrock:InvokeModel/,
        /fix: Grant it: pnpm aws:provision .* --bedrock --apply/,
      ],
      [
        'model_access',
        /FAIL AI-02 .*MODEL ACCESS: the account may not use us\.anthropic\.claude-sonnet-4-6 yet/,
        /fix: Bedrock console, Model access: the Anthropic use-case form and the model agreement .*for anthropic\.claude-sonnet-4-6; check with aws bedrock get-foundation-model-availability --model-id anthropic\.claude-sonnet-4-6 /,
      ],
      [
        'quota',
        /FAIL AI-02 .*QUOTA: the account's quota for us\.anthropic\.claude-sonnet-4-6 is 0 \("not available for this account"\)/,
        /fix: Open a free AWS Support case \(Account and billing\) .*for Anthropic Claude Sonnet 4\.6, cross-region/,
      ],
      ['throttled', /FAIL AI-02 .*throttled: /, /fix: Run again in a minute/],
      ['unavailable', /FAIL AI-02 .*Bedrock did not answer \(unavailable\)/, /fix: A transient outage/],
      [
        'invalid_model',
        /FAIL AI-02 .*the request was rejected: .*model identifier is invalid/,
        /fix: AI_BEDROCK_MODEL_ID must be an inference profile id \(one of us\.anthropic\.claude-sonnet-5-5, /,
      ],
      ['refusal', /FAIL AI-02 .*stopped with refusal/, /fix: A refusal of a one-word ping/],
    ]
    for (const [scenario, detail, fix] of cases) {
      const r = await run(['--sim', '--sim-scenario', scenario])
      expect(r.code, scenario).toBe(1)
      expect(r.out, scenario).toMatch(detail)
      expect(r.out, scenario).toMatch(fix)
    }
  })

  it('names the configured model: Sonnet 5.5 with the quota of 0 says so and points back to the interim Sonnet 4.6', async () => {
    const r = await run(['--sim', '--sim-scenario', 'quota'], { ...BASE, AI_BEDROCK_MODEL_ID: 'us.anthropic.claude-sonnet-5-5' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/PASS AI-01 .*us\.anthropic\.claude-sonnet-5-5 \(Claude Sonnet 5\.5\)/)
    expect(r.out).toMatch(/QUOTA: the account's quota for us\.anthropic\.claude-sonnet-5-5 is 0 .*The model anthropic\.claude-sonnet-5-5 is not available for this account/)
    expect(r.out).toMatch(/for Anthropic Claude Sonnet 5\.5, cross-region, in us-east-1; .*Until then run on a model the account has quota for \(AI_BEDROCK_MODEL_ID=us\.anthropic\.claude-sonnet-4-6\)/)
    // --model tries another model without touching the env files (they win over the command line on the host)
    const next = await run(['--sim', '--model', 'us.anthropic.claude-sonnet-5-5'], { ...BASE, AI_BEDROCK_MODEL_ID: 'us.anthropic.claude-sonnet-4-6' })
    expect(next.code, next.out).toBe(0)
    expect(next.out).toMatch(/PASS AI-01 .*us\.anthropic\.claude-sonnet-5-5 \(Claude Sonnet 5\.5\) in us-east-1/)
    expect((await run(['--sim', '--model', ' '])).out).toMatch(/--model needs an inference profile id/)
    // every listed model is a valid setting (the judge models included)
    for (const model of ['us.anthropic.claude-opus-5-5', 'us.anthropic.claude-sonnet-4-6', 'us.anthropic.claude-opus-4-6-v1']) {
      const ok = await run(['--sim'], { ...BASE, AI_BEDROCK_MODEL_ID: model })
      expect(ok.code, ok.out).toBe(0)
    }
  })

  it('--probe-effort says which field the model takes, and fails only when the configured one is rejected', async () => {
    const ok = await run(['--sim', '--probe-effort'])
    expect(ok.code, ok.out).toBe(0)
    expect(ok.out).toMatch(
      /PASS AI-03 .*output_config and additional_fields accepted \(AI_BEDROCK_EFFORT_MODE=output_config sends AI_EFFORT\); now off/,
    )
    const none = await run(['--sim', '--sim-scenario', 'no_effort', '--probe-effort'])
    expect(none.code, none.out).toBe(0)
    expect(none.out).toMatch(/PASS AI-03 .*neither field is accepted: keep AI_BEDROCK_EFFORT_MODE=off/)
    // configured but rejected: the ping itself (sent the way the app would) fails, and says so
    const configured = await run(['--sim', '--sim-scenario', 'no_effort', '--probe-effort'], {
      ...BASE,
      AI_BEDROCK_EFFORT_MODE: 'output_config',
    })
    expect(configured.code).toBe(1)
    expect(configured.out).toMatch(/FAIL AI-02 .*the request was rejected: .*output_config\.effort/)
    expect(configured.out).toMatch(/a rejected effort field means AI_BEDROCK_EFFORT_MODE must stay off/)
    expect(configured.out).toMatch(/SKIP AI-03 .*the ping did not pass/)
  })

  it('settings: a model id that is not a Claude inference profile fails AI-01; an invalid value fails it with the variable', async () => {
    const plain = await run(['--sim'], { ...BASE, AI_BEDROCK_MODEL_ID: 'anthropic.claude-sonnet-5-5' })
    expect(plain.code).toBe(1)
    expect(plain.out).toMatch(/FAIL AI-01 .*AI_BEDROCK_MODEL_ID=anthropic\.claude-sonnet-5-5/)
    expect(plain.out).toMatch(/fix: The app calls Claude through a cross-region inference profile: AI_BEDROCK_MODEL_ID one of us\.anthropic\.claude-sonnet-5-5, us\.anthropic\.claude-opus-5-5, us\.anthropic\.claude-sonnet-4-6, us\.anthropic\.claude-opus-4-6-v1/)
    // a Claude profile the IAM grant does not cover
    const unlisted = await run(['--sim'], { ...BASE, AI_BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5' })
    expect(unlisted.code).toBe(1)
    expect(unlisted.out).toMatch(/FAIL AI-01 .*AI_BEDROCK_MODEL_ID=us\.anthropic\.claude-haiku-4-5 is not one of the models the app role may call/)
    expect(unlisted.out).toMatch(/fix: Use one of those, or add the model to src\/integrations\/ai\/models\.ts/)
    const bad = await run(['--sim'], { ...BASE, AI_BEDROCK_EFFORT_MODE: 'sometimes' })
    expect(bad.code).toBe(1)
    expect(bad.out).toMatch(/FAIL AI-01 .*invalid AI settings: AI_BEDROCK_EFFORT_MODE/)
    expect(bad.out).toMatch(/SKIP AI-02 .*the settings are invalid/)
  })

  it('without credentials chosen on purpose it stops with exit 2 before any call; bad options are usage errors', async () => {
    const r = await run([])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/ai: cannot run, configuration is missing/)
    expect(r.out).toContain('Nothing probes instance metadata unless you pass --instance-profile')
    expect((await run(['--sim-scenario', 'quota'])).out).toMatch(/--sim-scenario is for --sim/)
    expect((await run(['--sim', '--sim-scenario', 'nope'])).code).toBe(2)
    expect((await run(['--sim', '--max-tokens', '0'])).out).toMatch(
      /--max-tokens must be an integer from 1 to 64/,
    )
    expect((await run(['--help'])).out).toContain('pnpm verify:ai [options]')
  })
})

describe('verify:all includes ai', () => {
  it('--only-integration ai runs just this check', async () => {
    const lines: string[] = []
    const code = await mainAll(['--only-integration', 'ai', '--sim', '--no-report'], BASE, (l) =>
      lines.push(l),
    )
    expect(code, lines.join('\n')).toBe(0)
    expect(lines.join('\n')).toMatch(/=== ai ===[\s\S]*ai\s+exit 0 {2}2 PASS, 0 FAIL, 1 SKIP/)
  })
})
