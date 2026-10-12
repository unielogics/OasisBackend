// Shared plumbing of the Square sandbox end-to-end run (scripts/e2e-square): the staff API with a session, the personal-link API,
// the stack's database, pg-boss kicks for the jobs, and direct Square sandbox calls (the "customer" and "counter" side the run
// plays). The sandbox token is read from Secrets Manager in this process only and never printed; Square ids are shown by their last
// four characters (red()).
/* eslint-disable @typescript-eslint/no-explicit-any -- untyped JSON of the API and of Square */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import PgBoss from 'pg-boss'
import { sql } from 'kysely'
import { createDb, type Db } from '../../src/platform/db.js'
import { systemClock } from '../../src/platform/clock.js'
import { createIdGenerator } from '../../src/platform/ids.js'

export const clock = systemClock
export const newId = createIdGenerator(clock)

export interface Ctx {
  dir: string
  env: Record<string, string>
  api: string
  db: Db
  schema: string
}

export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

export function context(envFile: string, dir: string): Ctx {
  const env = readEnvFile(envFile)
  const schema = env.DB_SEARCH_PATH!.split(',')[0]!
  const db = createDb({
    url: env.DATABASE_URL!,
    searchPath: env.DB_SEARCH_PATH,
    clock,
    poolMax: 3,
    applicationName: 'q4-e2e-driver',
  })
  return { dir, env, api: `http://127.0.0.1:${env.PORT}`, db, schema }
}

/** A Square id shown by its last four characters. */
export const red = (id: string | null | undefined): string => (id ? `…${id.slice(-4)}` : String(id))

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 120_000,
  everyMs = 2000,
): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(everyMs)
  }
}

// ---------------------------------------------------------------- state

export function loadState(dir: string): Record<string, any> {
  const f = path.join(dir, 'state.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}
}
export function saveState(dir: string, s: Record<string, any>): void {
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(s, null, 2), { mode: 0o600 })
}

// ---------------------------------------------------------------- staff API

export interface Res {
  status: number
  body: any
}

export class Staff {
  private cookie = ''
  private csrf = ''
  constructor(
    private readonly base: string,
    private readonly dir: string,
  ) {}

  async login(): Promise<void> {
    const admin = JSON.parse(fs.readFileSync(path.join(this.dir, 'admin.json'), 'utf8')) as {
      email: string
      password: string
    }
    const r = await fetch(`${this.base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(admin),
    })
    if (r.status !== 200) throw new Error(`login ${r.status} ${await r.text()}`)
    const set = r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
    this.cookie = set
    this.csrf = ((await r.json()) as { csrfToken: string }).csrfToken
  }

  async call(
    method: string,
    p: string,
    body?: unknown,
    o: { key?: string | false; headers?: Record<string, string> } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = { cookie: this.cookie, ...(o.headers ?? {}) }
    if (method !== 'GET') {
      headers['x-csrf-token'] = this.csrf
      headers.origin = this.base
      if (o.key !== false) headers['idempotency-key'] = o.key ?? `q4-${crypto.randomUUID()}`
    }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const r = await fetch(`${this.base}/api/v1${p}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await r.text()
    let parsed: any = text
    try {
      parsed = JSON.parse(text)
    } catch {
      /* text */
    }
    return { status: r.status, body: parsed }
  }
  get = (p: string) => this.call('GET', p)
  post = (p: string, b: unknown = {}, o?: { key?: string | false }) => this.call('POST', p, b, o)
  put = (p: string, b: unknown, o?: { key?: string | false }) => this.call('PUT', p, b, o)
  patch = (p: string, b: unknown) => this.call('PATCH', p, b)
  del = (p: string) => this.call('DELETE', p)
}

export function must(r: Res, ok: number | number[], what: string): any {
  const codes = Array.isArray(ok) ? ok : [ok]
  if (!codes.includes(r.status))
    throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 600)}`)
  return r.body
}

// ---------------------------------------------------------------- personal links

export async function linkCall(
  base: string,
  method: string,
  p: string,
  o: { session?: string; body?: unknown; key?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {}
  if (o.body !== undefined) headers['content-type'] = 'application/json'
  if (o.session) headers.authorization = `Bearer ${o.session}`
  if (o.key) headers['idempotency-key'] = o.key
  const r = await fetch(`${base}/api/v1/public/links${p}`, {
    method,
    headers,
    ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
  })
  const text = await r.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* text */
  }
  return { status: r.status, body }
}

// ---------------------------------------------------------------- jobs

/** Queues one run of a job (the worker runs it), as its cron would. */
export async function kick(ctx: Ctx, name: string, data: object = {}): Promise<void> {
  const boss = new PgBoss({
    connectionString: ctx.env.DATABASE_URL!,
    schema: ctx.env.PGBOSS_SCHEMA!,
    supervise: false,
    schedule: false,
    migrate: false,
    max: 1,
  })
  boss.on('error', () => undefined)
  await boss.start()
  try {
    await boss.send(name, data)
  } finally {
    await boss.stop({ graceful: false, wait: false })
  }
}

/** Waits until no job of that name is queued or active (the worker took the kick and finished it). */
export async function settled(ctx: Ctx, name: string, timeoutMs = 120_000): Promise<void> {
  const s = ctx.env.PGBOSS_SCHEMA!
  await waitFor(
    `job ${name}`,
    async () => {
      const r = await sql<{
        n: string
      }>`select count(*)::text as n from ${sql.table(`${s}.job`)} where name = ${name} and state in ('created','retry','active') and start_after <= now()`.execute(
        ctx.db,
      )
      return r.rows[0]!.n === '0'
    },
    timeoutMs,
    1000,
  )
}

export async function runJob(ctx: Ctx, name: string): Promise<void> {
  await kick(ctx, name)
  await sleep(1500)
  await settled(ctx, name)
}

// ---------------------------------------------------------------- Square sandbox (the client and counter side)

let token: string | null = null
async function squareToken(): Promise<string> {
  if (token) return token
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
  const out = await sm.send(
    new GetSecretValueCommand({ SecretId: process.env.SANDBOX_SECRET_ID ?? 'oasis/sandbox/square' }),
  )
  const doc = JSON.parse(out.SecretString ?? '{}') as Record<string, string>
  if (!doc.SQUARE_ACCESS_TOKEN) throw new Error('the sandbox secret has no SQUARE_ACCESS_TOKEN')
  token = doc.SQUARE_ACCESS_TOKEN
  return token
}

export async function sq(method: string, p: string, body?: unknown): Promise<Res> {
  const t = await squareToken()
  const r = await fetch(`https://connect.squareupsandbox.com/v2${p}`, {
    method,
    headers: {
      authorization: `Bearer ${t}`,
      'square-version': '2026-09-16',
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  let parsed: any = text
  try {
    parsed = JSON.parse(text)
  } catch {
    /* text */
  }
  return { status: r.status, body: parsed }
}

/** A Square error list as "CODE detail" (no ids). */
export const sqErr = (r: Res): string =>
  (r.body?.errors ?? [])
    .map((e: { code: string; detail?: string }) => `${e.code}${e.detail ? ` ${e.detail}` : ''}`)
    .join('; ') || `HTTP ${r.status}`
