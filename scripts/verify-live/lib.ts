// Shared plumbing for the live-verification scripts (docs/live-verification.md): the checklist report, the argument parser,
// the missing-configuration error (exit code 2), redaction and the report writer. Nothing here talks to a device or an API.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type Status = 'PASS' | 'FAIL' | 'SKIP'

export interface ItemDef {
  id: string
  title: string
  /** Where the checklist item comes from, e.g. "docs/integrations/smsgate.md section 2, item 6". */
  source: string
}

export interface ItemResult extends ItemDef {
  status: Status
  detail: string
  /** What to change when the item failed. */
  fix?: string
  /** Extra facts worth keeping in the report (already redacted). */
  evidence?: string[]
}

export type Mode = 'live' | 'sim'

export const EXIT_OK = 0
export const EXIT_FAIL = 1
export const EXIT_CONFIG = 2

/** Thrown when the script cannot start for lack of configuration; lists exactly what to set. */
export class MissingConfig extends Error {
  constructor(
    readonly integration: string,
    readonly missing: Array<{ name: string; why: string }>,
    readonly hints: string[] = [],
  ) {
    super(`${integration}: missing ${missing.map((m) => m.name).join(', ')}`)
  }

  render(): string[] {
    return [
      `${this.integration}: cannot run, configuration is missing (exit code 2)`,
      ...this.missing.map((m) => `  - ${m.name}: ${m.why}`),
      ...this.hints.map((h) => `  ${h}`),
    ]
  }
}

/** A wrong or unsafe command line. Exit code 2 as well: nothing was contacted. */
export class UsageError extends Error {}

const SECRET_KEY = /(pass(word)?|secret|token|signing[_-]?key|api[_-]?key|authorization|credential)/i

/** Replaces values of secret-looking keys in a JSON-ish structure; used before anything from a device is written to a report. */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]'
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value))
      out[k] = SECRET_KEY.test(k) && v !== null && v !== undefined ? '***' : redactDeep(v, depth + 1)
    return out
  }
  return value
}

/** +17865550151 -> +1786***0151: enough to recognise the number, not enough to dial it from a report. */
export function maskPhone(p: string): string {
  const digits = p.replace(/[^\d+]/g, '')
  return digits.length <= 7 ? '***' : `${digits.slice(0, 3)}***${digits.slice(-4)}`
}

export function maskEmail(e: string): string {
  const [local = '', domain = ''] = e.split('@')
  return `${local.slice(0, 1)}***@${domain}`
}

export function maskUrlCredentials(u: string): string {
  try {
    const url = new URL(u)
    if (url.username || url.password) {
      url.username = '***'
      url.password = ''
    }
    url.search = url.search ? '?***' : ''
    return url.toString()
  } catch {
    return u
  }
}

export class Report {
  readonly startedAt: Date
  finishedAt?: Date
  readonly notes: string[] = []
  private readonly results = new Map<string, ItemResult>()
  private readonly secrets = new Set<string>()

  constructor(
    readonly integration: string,
    readonly title: string,
    private readonly defs: readonly ItemDef[],
    readonly meta: { mode: Mode; target: string },
    private readonly now: () => Date,
    private readonly echo: (line: string) => void,
  ) {
    this.startedAt = now()
  }

  /** Registers a value that must never appear in console output or files (credentials, signing keys, the --to number). */
  secret(value: string | undefined): void {
    if (value && value.length >= 4) this.secrets.add(value)
  }

  clean(text: string): string {
    let out = text
    for (const s of this.secrets) out = out.split(s).join('***')
    return out
  }

  private def(id: string): ItemDef {
    const d = this.defs.find((x) => x.id === id)
    if (!d) throw new Error(`unknown checklist item ${id}`)
    return d
  }

  private set(
    id: string,
    status: Status,
    detail: string,
    extra: { fix?: string; evidence?: string[] } = {},
  ): void {
    const d = this.def(id)
    const result: ItemResult = {
      ...d,
      status,
      detail: this.clean(detail),
      ...(extra.fix ? { fix: this.clean(extra.fix) } : {}),
      ...(extra.evidence?.length ? { evidence: extra.evidence.map((e) => this.clean(e)) } : {}),
    }
    const prev = this.results.get(id)
    // A FAIL is never papered over by a later PASS of the same item, and a SKIP never replaces a decided result.
    if (prev?.status === 'FAIL' && status !== 'FAIL') return
    if (prev && prev.status !== 'SKIP' && status === 'SKIP') return
    this.results.set(id, result)
    this.echo(`${status.padEnd(4)} ${id.padEnd(7)} ${d.title}${result.detail ? `  -  ${result.detail}` : ''}`)
    if (result.fix && status === 'FAIL') this.echo(`             fix: ${result.fix}`)
  }

  pass(id: string, detail = '', evidence?: string[]): void {
    this.set(id, 'PASS', detail, { evidence })
  }

  fail(id: string, detail: string, fix?: string, evidence?: string[]): void {
    this.set(id, 'FAIL', detail, { fix, evidence })
  }

  skip(id: string, reason: string): void {
    this.set(id, 'SKIP', reason)
  }

  has(id: string): boolean {
    return this.results.has(id)
  }

  note(text: string): void {
    const t = this.clean(text)
    this.notes.push(t)
    this.echo(`note ${t}`)
  }

  /** Items nobody reported are listed as SKIP so the report always shows the whole checklist. */
  finalize(unreported = 'not run in this mode'): void {
    for (const d of this.defs) if (!this.results.has(d.id)) this.set(d.id, 'SKIP', unreported)
    this.finishedAt = this.now()
  }

  items(): ItemResult[] {
    return this.defs.map((d) => this.results.get(d.id)).filter((r): r is ItemResult => r !== undefined)
  }

  summary(): { pass: number; fail: number; skip: number } {
    const items = this.items()
    return {
      pass: items.filter((i) => i.status === 'PASS').length,
      fail: items.filter((i) => i.status === 'FAIL').length,
      skip: items.filter((i) => i.status === 'SKIP').length,
    }
  }

  exitCode(): number {
    return this.summary().fail > 0 ? EXIT_FAIL : EXIT_OK
  }

  toJson(): Record<string, unknown> {
    return {
      integration: this.integration,
      mode: this.meta.mode,
      target: this.meta.target,
      startedAt: this.startedAt.toISOString(),
      finishedAt: (this.finishedAt ?? this.now()).toISOString(),
      summary: this.summary(),
      result: this.summary().fail > 0 ? 'FAIL' : 'PASS',
      items: this.items(),
      notes: this.notes,
    }
  }

  toMarkdown(): string {
    const s = this.summary()
    const finished = this.finishedAt ?? this.now()
    const lines = [
      `# ${this.title}`,
      '',
      `- Run: ${this.startedAt.toISOString()} (${Math.round((finished.getTime() - this.startedAt.getTime()) / 1000)} s)`,
      `- Mode: ${this.meta.mode === 'sim' ? 'simulator (proves the script, not the hardware or account)' : 'LIVE'}`,
      `- Target: ${this.clean(this.meta.target)}`,
      `- Result: **${s.fail > 0 ? 'FAIL' : 'PASS'}** (${s.pass} PASS, ${s.fail} FAIL, ${s.skip} SKIP)`,
      '',
      '| # | Item | Result | Detail |',
      '|---|---|---|---|',
      ...this.items().map((i) => `| ${i.id} | ${cell(i.title)} | ${i.status} | ${cell(i.detail)} |`),
    ]
    const fixes = this.items().filter((i) => i.status === 'FAIL' && i.fix)
    if (fixes.length) {
      lines.push('', '## What to change', '', ...fixes.map((i) => `- **${i.id}** ${i.fix}`))
    }
    const withEvidence = this.items().filter((i) => i.evidence?.length)
    if (withEvidence.length) {
      lines.push('', '## Evidence', '')
      for (const i of withEvidence)
        lines.push(`### ${i.id} ${i.title}`, '', '```', ...(i.evidence ?? []), '```', '')
    }
    if (this.notes.length) lines.push('', '## Notes', '', ...this.notes.map((n) => `- ${n}`))
    lines.push(
      '',
      '## Sources',
      '',
      ...Array.from(new Set(this.items().map((i) => i.source))).map((x) => `- ${x}`),
      '',
    )
    return lines.join('\n')
  }
}

const cell = (t: string): string => t.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** docs/live-verification/<ISO date>-<integration>.md and .json (the directory is gitignored). */
export function writeReport(report: Report, outDir: string): { md: string; json: string } {
  mkdirSync(outDir, { recursive: true })
  const base = path.join(outDir, `${isoDate(report.startedAt)}-${report.integration}`)
  writeFileSync(`${base}.md`, report.toMarkdown(), { mode: 0o600 })
  writeFileSync(`${base}.json`, `${JSON.stringify(report.toJson(), null, 2)}\n`, { mode: 0o600 })
  return { md: `${base}.md`, json: `${base}.json` }
}

// ---- arguments ---------------------------------------------------------------------------------------------------------

export interface Args {
  flag(name: string): boolean
  value(name: string): string | undefined
  number(name: string): number | undefined
}

export function parseArgs(
  argv: readonly string[],
  known: { flags: readonly string[]; options: readonly string[] },
): Args {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  const list = argv.filter((a) => a !== '--')
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!
    if (!a.startsWith('--')) throw new UsageError(`Unexpected argument "${a}"`)
    const eq = a.indexOf('=')
    const name = a.slice(2, eq > 0 ? eq : undefined)
    if (known.flags.includes(name)) {
      flags.add(name)
    } else if (known.options.includes(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : list[++i]
      if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} needs a value`)
      values.set(name, v)
    } else {
      throw new UsageError(`Unknown option --${name}`)
    }
  }
  return {
    flag: (n) => flags.has(n),
    value: (n) => values.get(n),
    number: (n) => {
      const v = values.get(n)
      if (v === undefined) return undefined
      const x = Number(v)
      if (!Number.isFinite(x)) throw new UsageError(`--${n} must be a number`)
      return x
    },
  }
}

export const COMMON_FLAGS = ['sim', 'json', 'help', 'no-report'] as const
export const COMMON_OPTIONS = ['out-dir'] as const

export interface RunContext {
  args: Args
  env: Record<string, string | undefined>
  log: (line: string) => void
  now: () => Date
  sleep: (ms: number) => Promise<void>
  outDir: string
}

export type RunResult = { report: Report } | { missing: MissingConfig }

export const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function defaultOutDir(env: Record<string, string | undefined>): string {
  return env.VERIFY_LIVE_OUT_DIR ?? path.resolve('docs', 'live-verification')
}

/** Prints, writes the report, and returns the exit code. */
export function finish(result: RunResult, ctx: RunContext): number {
  if ('missing' in result) {
    for (const l of result.missing.render()) ctx.log(l)
    return EXIT_CONFIG
  }
  const { report } = result
  report.finalize()
  const s = report.summary()
  ctx.log(`${report.integration}: ${s.pass} PASS, ${s.fail} FAIL, ${s.skip} SKIP`)
  if (!ctx.args.flag('no-report')) {
    const written = writeReport(report, ctx.outDir)
    ctx.log(`report: ${written.md}`)
    ctx.log(`json:   ${written.json}`)
  }
  if (ctx.args.flag('json')) ctx.log(JSON.stringify(report.toJson()))
  return report.exitCode()
}

/** Wrapper for the bin entry of each script. */
export async function cli(
  name: string,
  help: string,
  argv: string[],
  run: (ctx: RunContext) => Promise<RunResult>,
  known: { flags: readonly string[]; options: readonly string[] },
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.log,
): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv, {
      flags: [...COMMON_FLAGS, ...known.flags],
      options: [...COMMON_OPTIONS, ...known.options],
    })
  } catch (e) {
    log(`${name}: ${(e as Error).message}`)
    log(`run "pnpm ${name} --help"`)
    return EXIT_CONFIG
  }
  if (args.flag('help')) {
    log(help)
    return EXIT_OK
  }
  const ctx: RunContext = {
    args,
    env,
    log,
    now: () => new Date(),
    sleep: realSleep,
    outDir: args.value('out-dir') ?? defaultOutDir(env),
  }
  try {
    return finish(await run(ctx), ctx)
  } catch (e) {
    if (e instanceof UsageError) {
      log(`${name}: ${e.message}`)
      return EXIT_CONFIG
    }
    if (e instanceof MissingConfig) {
      for (const l of e.render()) log(l)
      return EXIT_CONFIG
    }
    throw e
  }
}
