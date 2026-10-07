// The real process: `src/server.ts` booted with the production composition against an isolated schema. Proves the wiring
// that no in-process test reaches: the public and hooks listeners, the inline dispatch runner, the scheduling and
// messaging modules sharing one runtime, and sign-in through the real session authorizer.
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { FixedClock, PARITY_NOW } from '../../src/platform/clock.js'
import { signWebhook } from '../../src/integrations/smsgate/signature.js'
import { createTestDb, truncateAll, type TestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

const SIM_SECRET = 'sim-signing-key-design'
const ADMIN = { email: 'admin-boot@example.test', password: 'a-long-test-password-123' }
let t: TestDb
let child: ChildProcess
let api = ''
let hooks = ''
let output = ''

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const t0 = performance.now()
  for (;;) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    if (performance.now() - t0 > ms) throw new Error(`timed out; server output:\n${output.slice(-1500)}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}

beforeAll(async () => {
  const clock = new FixedClock(PARITY_NOW)
  t = await createTestDb({ clock, poolMax: 4 })
  await truncateAll(t.db)
  await runSeed({ db: t.db, clock, profile: 'design' })
  const phones = (await t.db.selectFrom('customers').select('phone_e164').execute())
    .map((c) => c.phone_e164)
    .filter(Boolean)
  const [apiPort, hooksPort] = [await freePort(), await freePort()]
  api = `http://127.0.0.1:${apiPort}`
  hooks = `http://127.0.0.1:${hooksPort}`
  child = spawn('node_modules/.bin/tsx', ['src/server.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      DATABASE_URL: testDatabaseUrl(),
      DB_SEARCH_PATH: `${t.schema},public`,
      PORT: String(apiPort),
      HOST: '127.0.0.1',
      HOOKS_HOST: '127.0.0.1',
      HOOKS_PORT: String(hooksPort),
      JOBS_ENABLED: 'false',
      CLOCK_FREEZE_AT: PARITY_NOW,
      SMS_PROVIDER: 'sim',
      SMS_DISPATCH_MODE: 'inline',
      SMS_TICK_INTERVAL_MS: '250',
      SMSGATE_MIN_INTERVAL_MS: '0',
      SMS_ALLOWLIST: phones.join(','),
      EMAIL_PROVIDER: 'sim',
      EMAIL_CONSOLE_DIR: `${process.env.TMPDIR ?? '/tmp'}/oasis-boot-mail`,
      BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
      BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
      PUBLIC_DASHBOARD_URL: 'http://localhost:3000',
    },
  })
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()))
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()))
  await until(async () => (await fetch(`${api}/healthz`)).ok)
}, 90_000)

afterAll(async () => {
  child?.kill('SIGTERM')
  await new Promise((r) => child?.once('exit', r) ?? r(undefined))
  await t?.close()
})

describe('src/server.ts with the production composition', () => {
  it('books through the real session authorizer, dispatches inline, and reports the text delivered', async () => {
    const login = await fetch(`${api}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify(ADMIN),
    })
    expect(login.status).toBe(200)
    const csrf = ((await login.json()) as { csrfToken: string }).csrfToken
    const cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
    const authed = {
      cookie,
      'x-csrf-token': csrf,
      origin: 'http://localhost:3000',
      'content-type': 'application/json',
    }

    const svc = await t.db
      .selectFrom('services')
      .select('id')
      .where('name', '=', 'Express Hand Wash')
      .where('kind', '=', 'package')
      .executeTakeFirstOrThrow()
    const maria = await t.db
      .selectFrom('customers')
      .select('id')
      .where('full_name', '=', 'Maria Delgado')
      .executeTakeFirstOrThrow()
    const booked = await fetch(`${api}/api/v1/appointments`, {
      method: 'POST',
      headers: { ...authed, 'idempotency-key': 'boot-test-booking-1' },
      body: JSON.stringify({
        customer: { id: maria.id },
        serviceId: svc.id,
        start: '2026-06-13T14:00:00-04:00',
      }),
    })
    expect(booked.status, await booked.clone().text()).toBe(201)
    const b = (await booked.json()) as { appointment: { id: string }; messageQueued: boolean }
    expect(b.messageQueued).toBe(true)

    const thread = await until(async () => {
      const r = await fetch(`${api}/api/v1/appointments/${b.appointment.id}/messages`, { headers: authed })
      const body = (await r.json()) as { items: Array<{ status: string; templateKey: string | null }> }
      return body.items.find((m) => m.status === 'delivered') ? body : undefined
    })
    expect(thread.items[0]).toMatchObject({ templateKey: 'booking_thanks', status: 'delivered' })

    const devices = (await (
      await fetch(`${api}/api/v1/integrations/sms/devices`, { headers: authed })
    ).json()) as { items: Array<{ key: string; counters: { sent: number; delivered: number } }> }
    expect(devices.items[0]).toMatchObject({ key: SIM_DEVICE_KEY, counters: { sent: 1, delivered: 1 } })
  }, 60_000)

  it('serves the SMS Gate hook on the hooks listener only', async () => {
    const maria = await t.db
      .selectFrom('customers')
      .select(['id', 'phone_e164'])
      .where('full_name', '=', 'Maria Delgado')
      .executeTakeFirstOrThrow()
    const body = JSON.stringify({
      id: 'boot-envelope-1',
      webhookId: 'oasis-sms-received',
      event: 'sms:received',
      deviceId: 'remote-1',
      payload: {
        messageId: 'boot-in-1',
        sender: maria.phone_e164,
        recipient: '+15555550100',
        simNumber: 1,
        message: 'Hello from the tablet',
        receivedAt: '2026-06-13T10:36:00-04:00',
      },
    })
    const ts = String(Math.floor(new Date(PARITY_NOW).getTime() / 1000))
    const headers = {
      'content-type': 'application/json',
      'x-timestamp': ts,
      'x-signature': signWebhook(SIM_SECRET, body, ts),
    }

    const publicHit = await fetch(`${api}/hooks/smsgate/${SIM_DEVICE_KEY}`, { method: 'POST', headers, body })
    expect(publicHit.status).toBe(404)
    const bad = await fetch(`${hooks}/hooks/smsgate/${SIM_DEVICE_KEY}`, {
      method: 'POST',
      headers: { ...headers, 'x-signature': 'f'.repeat(64) },
      body,
    })
    expect(bad.status).toBe(401)
    const ok = await fetch(`${hooks}/hooks/smsgate/${SIM_DEVICE_KEY}`, { method: 'POST', headers, body })
    expect(ok.status).toBe(200)

    await until(
      async () =>
        (
          await t.db
            .selectFrom('messages')
            .select('id')
            .where('customer_id', '=', maria.id)
            .where('direction', '=', 'in')
            .execute()
        ).length > 0,
    )
    const row = await t.db
      .selectFrom('messages')
      .select(['body', 'status'])
      .where('direction', '=', 'in')
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ body: 'Hello from the tablet', status: 'received' })
  }, 60_000)

  it('stays up and answers /readyz', async () => {
    expect((await fetch(`${api}/readyz`)).status).toBeLessThan(500)
    expect(output).not.toMatch(/Error|ECONNREFUSED|unhandled/i)
  })
})
