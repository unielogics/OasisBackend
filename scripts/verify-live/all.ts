// pnpm verify:all  -  runs smsgate, squarespace and aws one after the other with the same flags where they apply, writes each
// integration's own report plus docs/live-verification/<date>-all.md, and exits with the worst result:
// 1 if any integration has a FAIL, else 2 if any could not start for lack of configuration, else 0.
import { applySecretEnvironment } from '../../src/config/secrets-source.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import {
  COMMON_FLAGS,
  COMMON_OPTIONS,
  EXIT_CONFIG,
  EXIT_FAIL,
  EXIT_OK,
  MissingConfig,
  UsageError,
  defaultOutDir,
  finish,
  isoDate,
  parseArgs,
  realSleep,
  type RunContext,
  type RunResult,
} from './lib.js'
import { SMSGATE_OPTIONS, runSmsGate } from './smsgate.js'
import { SQUARESPACE_OPTIONS, runSquarespace } from './squarespace.js'
import { AWS_OPTIONS, runAws } from './aws.js'

const SUITES = [
  { name: 'smsgate', run: runSmsGate, known: SMSGATE_OPTIONS },
  { name: 'squarespace', run: runSquarespace, known: SQUARESPACE_OPTIONS },
  { name: 'aws', run: runAws, known: AWS_OPTIONS },
] as const

const union = (pick: 'flags' | 'options'): string[] => [
  ...new Set([
    ...SUITES.flatMap((s) => [...s.known[pick]]),
    ...(pick === 'flags' ? COMMON_FLAGS : COMMON_OPTIONS),
    ...(pick === 'options' ? ['only-integration'] : []),
  ]),
]

export const HELP = `pnpm verify:all [options]

Runs verify:smsgate, verify:squarespace and verify:aws in turn. Every option of the three scripts is accepted and handed to the
ones that know it (--sim, --send, --to, --watch, --days ...). --to is used for the SMS number when it looks like a phone number and
for the email recipient when it looks like an email address; pass --sms-to and --email-to to give both.
  --only-integration smsgate|squarespace|aws   run just one
Exit code: 1 if any integration has a FAIL, else 2 if any could not start for lack of configuration, else 0.
Reports: docs/live-verification/<date>-<integration>.md and .json, plus <date>-all.md.
`

export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  log: (l: string) => void = console.log,
): Promise<number> {
  let all
  try {
    all = parseArgs(argv, { flags: union('flags'), options: [...union('options'), 'sms-to', 'email-to'] })
  } catch (e) {
    log(`verify:all: ${(e as Error).message}`)
    return EXIT_CONFIG
  }
  if (all.flag('help')) {
    log(HELP)
    return EXIT_OK
  }
  const outDir = all.value('out-dir') ?? defaultOutDir(env)
  const only = all.value('only-integration')
  const rows: Array<{ name: string; code: number; line: string }> = []
  for (const suite of SUITES) {
    if (only && only !== suite.name) continue
    const to = all.value('to')
    const smsTo = all.value('sms-to') ?? (to && !to.includes('@') ? to : undefined)
    const emailTo = all.value('email-to') ?? (to?.includes('@') ? to : undefined)
    const forward: string[] = []
    for (const f of suite.known.flags) if (all.flag(f)) forward.push(`--${f}`)
    for (const f of COMMON_FLAGS) if (all.flag(f) && f !== 'help') forward.push(`--${f}`)
    for (const o of suite.known.options) {
      const v =
        o === 'to'
          ? suite.name === 'smsgate'
            ? smsTo
            : suite.name === 'aws'
              ? emailTo
              : undefined
          : all.value(o)
      if (v !== undefined) forward.push(`--${o}`, v)
    }
    if (suite.name === 'aws' && all.flag('send') && !emailTo) forward.splice(forward.indexOf('--send'), 1)
    if (suite.name === 'smsgate' && all.flag('send') && !smsTo) forward.splice(forward.indexOf('--send'), 1)
    log(`\n=== ${suite.name} ===`)
    let args
    try {
      args = parseArgs(forward, {
        flags: [...COMMON_FLAGS, ...suite.known.flags],
        options: [...COMMON_OPTIONS, ...suite.known.options],
      })
    } catch (e) {
      log(`${suite.name}: ${(e as Error).message}`)
      rows.push({ name: suite.name, code: EXIT_CONFIG, line: (e as Error).message })
      continue
    }
    const ctx: RunContext = { args, env, log, now: () => new Date(), sleep: realSleep, outDir }
    let result: RunResult
    try {
      result = await suite.run(ctx)
    } catch (e) {
      if (e instanceof UsageError || e instanceof MissingConfig) {
        log(`${suite.name}: ${e.message}`)
        rows.push({ name: suite.name, code: EXIT_CONFIG, line: e.message })
        continue
      }
      throw e
    }
    const code = finish(result, ctx)
    const line =
      'missing' in result
        ? `not configured: ${result.missing.missing.map((m) => m.name).join(', ')}`
        : (() => {
            const s = result.report.summary()
            return `${s.pass} PASS, ${s.fail} FAIL, ${s.skip} SKIP`
          })()
    rows.push({ name: suite.name, code, line })
  }
  const worst = rows.some((r) => r.code === EXIT_FAIL)
    ? EXIT_FAIL
    : rows.some((r) => r.code === EXIT_CONFIG)
      ? EXIT_CONFIG
      : EXIT_OK
  log('\n=== summary ===')
  for (const r of rows) log(`${r.name.padEnd(12)} exit ${r.code}  ${r.line}`)
  if (!all.flag('no-report')) {
    mkdirSync(outDir, { recursive: true })
    const file = path.join(outDir, `${isoDate(new Date())}-all.md`)
    writeFileSync(
      file,
      [
        '# Live verification summary',
        '',
        '| Integration | Exit | Result |',
        '|---|---|---|',
        ...rows.map((r) => `| ${r.name} | ${r.code} | ${r.line.replace(/\|/g, '/')} |`),
        '',
        'Exit 0 = no FAIL, 1 = at least one FAIL, 2 = configuration missing. Each integration has its own report next to this file.',
        '',
      ].join('\n'),
      { mode: 0o600 },
    )
    log(`summary: ${file}`)
  }
  return worst
}

if (process.argv[1] && process.argv[1].endsWith('all.ts')) {
  // the settings may live in the Secrets Manager secret (OASIS_SECRET_ID), like the app's
  applySecretEnvironment().then(
    () => main(process.argv.slice(2)).then((c) => process.exit(c)),
    (e: unknown) => {
      console.error((e as Error).message)
      process.exit(2)
    },
  )
}
