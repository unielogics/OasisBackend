// The production configuration, for real: src/server.ts booted as a process with NODE_ENV=production and the environment that
// install.sh generates (common.env + api.env naming the secret; the secret's content is install.sh's seed, served by a local
// Secrets Manager endpoint through the real SDK), then driven the way an operator would: healthcheck.sh and oasis-admin.sh.
// The SMS Gate tablet and Squarespace are the simulators.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SimServer } from '../../src/integrations/smsgate/sim-server.js'
import { SquarespaceSimApi } from '../../src/integrations/squarespace/sim/api.js'
import { close, createSimHttpServer, listen } from '../../src/integrations/squarespace/sim/http.js'
import { SquarespaceSimStore } from '../../src/integrations/squarespace/sim/store.js'
import { systemClock } from '../../src/platform/clock.js'
import { sql } from 'kysely'
import { createTestDb, schemaPrefix, truncateAll, type TestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { parseEnvFile, script, sh } from './deploy-helpers.js'
import { seedSquarespaceSim } from '../../scripts/verify-live/sim-data.js'
import { useStage } from './deploy-stage.js'
import { FakeSecretsHttp } from '../aws/helpers/fake-secrets-http.js'

const stage = useStage()
const API_PORT = 4599
const API = `http://127.0.0.1:${API_PORT}`
const ADMIN = { email: 'owner@oasis.example.com', password: 'a-long-production-password-1' }
let t: TestDb
let child: ChildProcess
let output = ''
let tablet: SimServer
let sqsp: ReturnType<typeof createSimHttpServer>
let work: string
const secrets = new FakeSecretsHttp()

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 40_000): Promise<T> {
  const t0 = performance.now()
  for (;;) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    if (performance.now() - t0 > ms) throw new Error(`timed out; server output:\n${output.slice(-2000)}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

// A production server refuses a tablet on loopback (device-url.ts), so the simulated tablet listens on this host's
// private address, as a real tablet would on its own address.
const TABLET_HOST =
  Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address ?? null
const TABLET_URL = `http://${TABLET_HOST}:4591`

beforeAll(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'oasis-live-'))
  t = await createTestDb({ schema: `ops_${schemaPrefix}_live`.toLowerCase(), poolMax: 4 })
  await truncateAll(t.db)
  tablet = new SimServer({
    host: TABLET_HOST ?? '127.0.0.1',
    port: 4591,
    username: 'tablet',
    password: 'tablet-pass',
    signingKey: 'tablet-signing-key',
    autoProgress: 'instant',
  })
  await tablet.start()
  const store = new SquarespaceSimStore(systemClock, { pageSize: 50, order: 'asc', currency: 'USD' })
  seedSquarespaceSim(store, systemClock)
  sqsp = createSimHttpServer(new SquarespaceSimApi(store, systemClock, { apiKeys: ['sqsp-live-key-123'] }))
  await listen(sqsp, 4590)

  const merged = {
    ...parseEnvFile(readFileSync(path.join(stage.etc, 'common.env'), 'utf8')),
    ...parseEnvFile(readFileSync(path.join(stage.etc, 'api.env'), 'utf8')),
  }
  // what the operator pushes: install.sh's seed (SESSION_SECRET and SECRETS_KEY come from here only)
  secrets.secrets.set(merged.OASIS_SECRET_ID!, JSON.stringify(parseEnvFile(readFileSync(path.join(stage.etc, 'secret-seed.env'), 'utf8'))))
  const aws = await secrets.start()
  child = spawn('node_modules/.bin/tsx', ['src/server.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      ...merged,
      ...aws,
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      DATABASE_URL: testDatabaseUrl(),
      DB_SEARCH_PATH: `${t.schema},public`,
      PORT: String(API_PORT),
      HOOKS_PORT: '0',
      JOBS_ENABLED: 'false',
      SMS_DISPATCH_MODE: 'off',
      SQSP_PROVIDER: 'live',
      SQSP_API_BASE: 'http://127.0.0.1:4590',
      // the environment schema insists on a key when SQSP_PROVIDER=live; the stored key (below) is what the sync prefers
      SQSP_API_KEY: 'placeholder-key-from-env',
      EMAIL_CONSOLE_DIR: path.join(work, 'mail'),
      STORAGE_FS_ROOT: path.join(work, 'files'),
      SMSGATE_WEBHOOK_PUBLIC_URL: 'http://127.0.0.1:4593/hooks/smsgate',
      BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
      BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
    },
  })
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()))
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()))
  await until(async () => (await fetch(`${API}/healthz`)).ok)
}, 120_000)

afterAll(async () => {
  child?.kill('SIGTERM')
  await new Promise((r) => (child ? child.once('exit', r) : r(undefined)))
  await tablet?.stop()
  if (sqsp) await close(sqsp)
  if (t) await sql`drop schema if exists ${sql.id(t.schema)} cascade`.execute(t.db)
  await t?.close()
  if (work) rmSync(work, { recursive: true, force: true })
  await secrets.stop()
})

const admin = (...args: string[]) =>
  sh(script('oasis-admin.sh'), ['--url', API, '--email', ADMIN.email, ...args], {
    OASIS_ETC: stage.etc,
    OASIS_ADMIN_PASSWORD: ADMIN.password,
    TABLET_PW: 'tablet-pass',
    SQSP_KEY: 'sqsp-live-key-123',
  })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: { stdout: string }): any => JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))

describe('the production process', () => {
  it('reads its secret settings from the secret at start, the explicit environment winning, and logs names only', () => {
    expect(output).toContain('environment: 3 setting(s) from Secrets Manager secret oasis/prod/app (us-east-1); set in the process environment and kept: DATABASE_URL')
    const seed = parseEnvFile(readFileSync(path.join(stage.etc, 'secret-seed.env'), 'utf8'))
    for (const v of Object.values(seed)) expect(output).not.toContain(v)
  })

  it('boots with the generated environment in production mode and answers the probes', async () => {
    const live = await fetch(`${API}/healthz`)
    expect(live.status).toBe(200)
    const ready = (await (await fetch(`${API}/readyz`)).json()) as { status: string }
    expect(ready.status).toBe('ready')
    expect(output).not.toMatch(/Invalid environment/)
  })

  it('sends the security headers nginx relies on the API to send, and the public listener has no SMS hook', async () => {
    const res = await fetch(`${API}/api/v1/auth/csrf`)
    expect(res.headers.get('strict-transport-security')).toBe('max-age=15552000; includeSubDomains')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(res.headers.get('x-api-version')).toBe('1')
    expect(
      (
        await fetch(`${API}/hooks/smsgate/anything`, {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(404)
  })

  it('trusts X-Forwarded-For as nginx sets it (TRUST_PROXY=true): the sign-in throttle follows the forwarded address', async () => {
    let n = 0
    // a different account each time, so only the per-address counter can be what trips
    const attempt = (ip: string) =>
      fetch(`${API}/api/v1/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://oasis.example.com',
          'x-forwarded-for': ip,
        },
        body: JSON.stringify({ email: `nobody${++n}@example.com`, password: 'wrong-password-123' }),
      })
    for (let i = 0; i < 12; i++) await attempt('203.0.113.9')
    expect((await attempt('203.0.113.9')).status).toBe(429) // that address is throttled ...
    expect((await attempt('203.0.113.77')).status).toBe(401) // ... another one is not, so the app does see the forwarded address
  })

  it('healthcheck.sh judges the real API', async () => {
    const web = (await import('node:http')).createServer((_q, res) => res.writeHead(200).end('ok'))
    await new Promise<void>((r) => web.listen(4594, '127.0.0.1', r))
    try {
      const r = await sh(script('healthcheck.sh'), ['--api', API, '--web', 'http://127.0.0.1:4594'])
      expect(r.code, r.out).toBe(0)
    } finally {
      await new Promise((r) => web.close(r))
    }
  })
})

describe('oasis-admin.sh', () => {
  it('signs in with the bootstrap administrator, reports status, and refuses a wrong password', async () => {
    const status = await admin('status')
    expect(status.code, status.out).toBe(0)
    expect(status.stdout).toContain('--- SMS tablets')
    expect(status.stdout).toContain('--- Squarespace')
    const bad = await sh(script('oasis-admin.sh'), ['--url', API, '--email', ADMIN.email, 'sms-devices'], {
      OASIS_ETC: stage.etc,
      OASIS_ADMIN_PASSWORD: 'not-the-password-123',
    })
    expect(bad.code).not.toBe(0)
    expect(bad.stderr).toMatch(/sign-in failed \(HTTP 401\)/)
    expect((await admin('frobnicate')).stderr).toMatch(/unknown command/)
  }, 60_000)

  it.skipIf(!TABLET_HOST)(
    'registers a tablet, shows its secret once, tests it, registers the seven webhooks and reads its health',
    async () => {
      const add = await admin(
        'sms-add-device',
        '--label',
        'Front desk tablet',
        '--device-url',
        TABLET_URL,
        '--username',
        'tablet',
        '--password-env',
        'TABLET_PW',
        '--webhook-secret-env',
        'SQSP_KEY',
      )
      expect(add.code, add.out).toBe(0)
      const created = json(add)
      expect(created.device.label).toBe('Front desk tablet')
      expect(created.webhookSecret).toBe('sqsp-live-key-123')
      expect(add.stderr).toMatch(/shown only now/)
      expect(JSON.stringify(created)).not.toContain('tablet-pass') // the password is stored encrypted and never returned
      const id = created.device.id as string

      const list = json(await admin('sms-devices'))
      expect(list.items?.[0]?.id ?? list.devices?.[0]?.id ?? list[0]?.id).toBe(id)

      const test = json(await admin('sms-test', id))
      expect(test).toMatchObject({ reachable: true, credentials: 'ok' })
      const wrong = await admin(
        'sms-update-device',
        id,
        '--device-url',
        TABLET_URL,
        '--username',
        'tablet',
        '--password-env',
        'SQSP_KEY',
      )
      expect(wrong.code, wrong.out).toBe(0)
      expect(json(await admin('sms-test', id)).credentials).toBe('rejected')
      await admin('sms-update-device', id, '--password-env', 'TABLET_PW')

      const reg = await admin('sms-register-webhooks', id)
      expect(reg.code, reg.out).toBe(0)
      const onDevice = (await (await fetch(`${TABLET_URL}/__sim/state`)).json()) as {
        webhooks: Array<{ id: string; url: string }>
      }
      expect(onDevice.webhooks.map((w) => w.id).sort()).toEqual([
        'oasis-app-started',
        'oasis-sms-cancelled',
        'oasis-sms-delivered',
        'oasis-sms-failed',
        'oasis-sms-received',
        'oasis-sms-sent',
        'oasis-system-ping',
      ])
      expect(onDevice.webhooks[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:4593\/hooks\/smsgate\//)

      const health = await admin('sms-health', id)
      expect(health.code, health.out).toBe(0)
    },
    90_000,
  )

  it('connects Squarespace (verified first), loads the proposed product map from a file, and runs a sync', async () => {
    const status0 = json(await admin('sqsp-status'))
    expect(status0.connection?.configured ?? status0.connection?.keySource).toBeDefined()

    const connect = await admin('sqsp-connect', '--key-env', 'SQSP_KEY')
    expect(connect.code, connect.out).toBe(0)
    expect(connect.stdout).not.toContain('sqsp-live-key-123')
    expect(json(connect).keySource ?? json(connect).connection?.keySource).toBe('database')

    const bad = await sh(
      script('oasis-admin.sh'),
      ['--url', API, '--email', ADMIN.email, 'sqsp-connect', '--key-env', 'BAD_KEY'],
      { OASIS_ETC: stage.etc, OASIS_ADMIN_PASSWORD: ADMIN.password, BAD_KEY: 'wrong-key-123456' },
    )
    expect(bad.code).not.toBe(0)
    expect(bad.stderr).toMatch(/HTTP 422/)

    const mapFile = path.join(work, 'map.json')
    writeFileSync(
      mapFile,
      JSON.stringify({
        entries: [
          {
            productId: 'sim-prod-premium',
            sku: 'MEM-PREMIUM',
            name: 'Premium Care Membership',
            kind: 'membership',
            plan: 'premium',
            planLabel: 'Premium Care Membership',
            intervalMonths: 1,
          },
          { productId: 'sim-prod-detail', sku: 'DET-SEDAN', name: 'Full Detail - Sedan', kind: 'service' },
        ],
      }),
    )
    const put = await admin('sqsp-product-map', '--file', mapFile)
    expect(put.code, put.out).toBe(0)
    expect(json(put).entries).toHaveLength(2)
    // a bare array works too, and the map reads back
    writeFileSync(
      mapFile,
      JSON.stringify([{ productId: 'sim-prod-wash', kind: 'service', name: 'Executive Wash' }]),
    )
    expect((await admin('sqsp-product-map', '--file', mapFile)).code).toBe(0)
    expect(json(await admin('sqsp-product-map')).entries).toHaveLength(1)
    writeFileSync(mapFile, JSON.stringify({ entries: [{ kind: 'membership' }] }))
    const invalid = await admin('sqsp-product-map', '--file', mapFile)
    expect(invalid.code).not.toBe(0)

    const sync = await admin('sqsp-sync-now')
    expect(sync.code, sync.out).toBe(0)
  }, 90_000)

  it('raw calls carry the same sign-in, and a path outside /api is refused', async () => {
    const me = json(await admin('raw', 'GET', '/api/v1/me'))
    expect(me.user.email).toBe(ADMIN.email)
    expect(me.isSuperAdmin).toBe(true)
    expect((await admin('raw', 'GET', '/healthz')).stderr).toMatch(/PATH must start with \/api\//)
  })
})
