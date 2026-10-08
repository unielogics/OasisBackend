// End to end through the REAL processes (src/server.ts and src/worker.ts, spawned with the production composition) against the
// AWS simulator (scripts/verify-live/sim-aws.ts, real HTTP, the real AWS SDK clients). Email and photo storage are switched from
// the simulators to SES and S3 by CONFIGURATION ONLY: STORAGE_PROVIDER=s3 with S3_ENDPOINT and path style, EMAIL_PROVIDER=ses with
// SES_ENDPOINT, credentials in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, instance metadata disabled.
//
//   photo: presign -> multipart form POST to the simulator -> complete -> photos.thumbnail (worker) writes the thumbnail ->
//          the presigned GETs return the original and the thumbnail;
//   email: an invitation, a password reset and a receipt leave with the right From, Reply-To and configuration set; an SNS-signed
//          bounce for the receipt then suppresses the next receipt to that address.
//
// The only test stand-in inside the API process is the SNS certificate download (test/aws/helpers/sns-cert-preload.mjs).
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { runSeed } from '../../db/seeds/index.js'
import { loadEnv } from '../../src/config/env.js'
import { FixedClock } from '../../src/platform/clock.js'
import { createJobs, type Jobs } from '../../src/platform/jobs.js'
import { createLogger } from '../../src/platform/logging.js'
import { AwsSim } from '../../scripts/verify-live/sim-aws.js'
import { createTestDb, truncateAll, type TestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { TOPIC, generateSigningCert, notification, sesEvent, type SigningCert } from './helpers/sns.js'

const API_PORT = 4061
const SIM_PORT = 4601
const API = `http://127.0.0.1:${API_PORT}`
const ORIGIN = 'http://localhost:3000'
const ADMIN = { email: 'owner-e2e@oasis.example', password: 'a-long-e2e-password-123' }
const BUCKET = 'oasis-photos-sim'

let t: TestDb
let sim: AwsSim
let cert: SigningCert
let work: string
let bossSchema: string
let api: ChildProcess | undefined
let worker: ChildProcess | undefined
let jobs: Jobs | undefined
let output = ''
let headers: Record<string, string> = {}

async function until<T>(fn: () => Promise<T | undefined | false | null>, what: string, ms = 45_000): Promise<T> {
  const t0 = performance.now()
  for (;;) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; process output:\n${output.slice(-3000)}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

function start(script: string, env: Record<string, string>, nodeArgs: string[] = []): ChildProcess {
  const child = spawn('node_modules/.bin/tsx', [...nodeArgs, script], { cwd: process.cwd(), env })
  child.stdout?.on('data', (d: Buffer) => (output += d.toString()))
  child.stderr?.on('data', (d: Buffer) => (output += d.toString()))
  return child
}

async function stop(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
  if (child.exitCode === null) child.kill('SIGKILL')
}

const call = async (method: string, url: string, body?: unknown, extra: Record<string, string> = {}) => {
  const res = await fetch(`${API}/api/v1${url}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, text }
}

beforeAll(async () => {
  const realNow = new Date(Date.now() + 60_000)
  t = await createTestDb({ clock: new FixedClock(realNow), poolMax: 4 })
  await truncateAll(t.db)
  await runSeed({ db: t.db, clock: t.clock, profile: 'parity-ops' })
  // the tablet comes last: with no usable SMS device, invitations and resets go by email
  await sql`update sms_devices set enabled = false`.execute(t.db)
  bossSchema = `pgb_awse2e_${t.schema}`.slice(0, 63)
  await sql`drop schema if exists ${sql.id(bossSchema)} cascade`.execute(t.db)

  cert = generateSigningCert()
  work = mkdtempSync(path.join(tmpdir(), 'oasis-aws-e2e-'))
  writeFileSync(path.join(work, 'sns.pem'), cert.certPem)
  sim = new AwsSim({
    bucket: BUCKET,
    verifiedIdentities: ['oasis.example'],
    configurationSet: 'oasis-mail',
    cors: { origins: [ORIGIN], methods: ['POST', 'GET', 'HEAD'] },
  })
  await sim.start(SIM_PORT)

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    NODE_ENV: 'development',
    LOG_LEVEL: 'warn',
    DATABASE_URL: testDatabaseUrl(),
    DB_SEARCH_PATH: `${t.schema},public`,
    PGBOSS_SCHEMA: bossSchema,
    JOBS_ENABLED: 'true',
    HOST: '127.0.0.1',
    PORT: String(API_PORT),
    HOOKS_PORT: '0',
    PUBLIC_API_URL: API,
    PUBLIC_DASHBOARD_URL: ORIGIN,
    SMS_PROVIDER: 'sim',
    SMS_DISPATCH_MODE: 'off',
    // AWS, by configuration only
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: sim.opts.accessKeyId,
    AWS_SECRET_ACCESS_KEY: 'simulator-secret-access-key',
    AWS_EC2_METADATA_DISABLED: 'true',
    EMAIL_PROVIDER: 'ses',
    SES_ENDPOINT: sim.url,
    SES_FROM_ADDRESS: 'no-reply@oasis.example',
    SES_FROM_NAME: 'Oasis Auto Spa',
    SES_REPLY_TO: 'help@oasis.example',
    SES_CONFIGURATION_SET: 'oasis-mail',
    SES_SNS_TOPIC_ARNS: TOPIC,
    STORAGE_PROVIDER: 's3',
    S3_BUCKET: BUCKET,
    S3_ENDPOINT: sim.url,
    S3_FORCE_PATH_STYLE: 'true',
    S3_KEY_PREFIX: 'prod/',
    S3_SSE: 'AES256',
    NODE_OPTIONS: '--max-old-space-size=512',
  }
  api = start('src/server.ts', {
    ...env,
    BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
    BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
    OASIS_TEST_SNS_CERT_FILE: path.join(work, 'sns.pem'),
  }, ['--import', path.resolve('test/aws/helpers/sns-cert-preload.mjs')])
  await until(async () => (await fetch(`${API}/healthz`)).ok, 'the API')
  worker = start('src/worker.ts', env)
  await until(async () => output.includes('worker started') || (await sql<{ n: number }>`select count(*)::int as n from ${sql.table(`${bossSchema}.queue`)}`.execute(t.db)).rows[0]!.n > 0, 'the worker')

  // an operator's "run it now": enqueue email.send on the same pg-boss schema instead of waiting for its minute
  jobs = createJobs({
    connectionString: testDatabaseUrl(),
    schema: bossSchema,
    db: t.db,
    clock: t.clock,
    logger: createLogger({ level: 'warn' }),
    enabled: true,
    definitions: [],
    tz: 'America/New_York',
  })
  await jobs.start({ workers: false })

  const login = await fetch(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(ADMIN),
  })
  expect(login.status, await login.clone().text()).toBe(200)
  const csrf = ((await login.json()) as { csrfToken: string }).csrfToken
  headers = { cookie: login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), 'x-csrf-token': csrf, origin: ORIGIN }
}, 180_000)

afterAll(async () => {
  await jobs?.stop().catch(() => undefined)
  await stop(worker)
  await stop(api)
  await sim?.stop()
  if (t) {
    await sql`drop schema if exists ${sql.id(bossSchema)} cascade`.execute(t.db)
    await truncateAll(t.db)
    await t.close()
  }
  if (work) rmSync(work, { recursive: true, force: true })
}, 60_000)

const sentTo = (address: string) => sim.sentEmails.filter((m) => m.to.includes(address))

describe('photos on S3 (simulator), by configuration only', () => {
  it('presign -> form POST -> complete -> thumbnail job -> presigned GETs', async () => {
    const sharp = (await import('sharp')).default
    const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer()
    const appt = await t.db
      .selectFrom('appointments')
      .select('id')
      .where('status', 'not in', ['canceled', 'no_show'])
      .orderBy('scheduled_start')
      .executeTakeFirstOrThrow()

    const pre = await call('POST', `/appointments/${appt.id}/photos/presign`, { category: 'before', contentType: 'image/png', bytes: png.length }, { 'idempotency-key': `e2e-presign-${appt.id}` })
    expect(pre.status, pre.text).toBe(201)
    const upload = pre.body.upload as { key: string; url: string; fields: Record<string, string> }
    const photoId = pre.body.photoId as string
    expect(upload.url).toBe(`${sim.url}/${BUCKET}`)
    expect(upload.fields.key).toBe(`prod/${upload.key}`)
    expect(upload.fields['x-amz-server-side-encryption']).toBe('AES256')

    const form = new FormData()
    for (const [k, v] of Object.entries(upload.fields)) form.append(k, v)
    form.append('file', new Blob([png], { type: 'image/png' }), 'before.png')
    const post = await fetch(upload.url, { method: 'POST', body: form, headers: { origin: ORIGIN } })
    expect(post.status, await post.text()).toBe(204)
    expect(sim.objects.get(`prod/${upload.key}`)?.body.equals(png)).toBe(true)

    const done = await call('POST', `/appointments/${appt.id}/photos/${photoId}/complete`, {}, { 'idempotency-key': `e2e-complete-${photoId}` })
    expect(done.status, done.text).toBe(200)
    expect(done.body.photo).toMatchObject({ id: photoId, category: 'before', bytes: png.length })

    const thumbKey = await until(
      async () => (await t.db.selectFrom('appointment_photos').select('thumb_key').where('id', '=', photoId).executeTakeFirst())?.thumb_key,
      'the photos.thumbnail job',
    )
    expect(thumbKey).toBe(upload.key.replace(/\.png$/, '.thumb.webp'))
    const thumb = sim.objects.get(`prod/${thumbKey}`)
    expect(thumb?.contentType).toBe('image/webp')
    const meta = await sharp(thumb!.body).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(480)

    const file = await call('GET', `/appointments/${appt.id}`)
    expect(file.status).toBe(200)
    const view = JSON.stringify(file.body)
    const item = (file.body as { photos: Record<string, { items: Array<{ id: string; url: string; thumbUrl: string }> }> }).photos.before!.items.find((p) => p.id === photoId)
    expect(item, view.slice(0, 500)).toBeDefined()
    expect(item!.url).toContain(`${sim.url}/${BUCKET}/prod/`)
    expect(item!.url).toContain('X-Amz-Signature=')
    const original = await fetch(item!.url)
    expect(original.status).toBe(200)
    expect(Buffer.from(await original.arrayBuffer()).equals(png)).toBe(true)
    const small = await fetch(item!.thumbUrl)
    expect(small.headers.get('content-type')).toBe('image/webp')
    expect(Buffer.from(await small.arrayBuffer()).equals(thumb!.body)).toBe(true)
  }, 90_000)
})

describe('email through SES (simulator), by configuration only', () => {
  const expectEnvelope = (m: (typeof sim.sentEmails)[number], template: string) => {
    expect(m.fromHeader).toBe('"Oasis Auto Spa" <no-reply@oasis.example>')
    expect(m.replyTo).toEqual(['help@oasis.example'])
    expect(m.configurationSet).toBe('oasis-mail')
    expect(m.tags).toEqual({ template })
  }

  it('sends an invitation with the right From, Reply-To and configuration set', async () => {
    const role = await t.db.selectFrom('roles').select(['id', 'name']).where('name', '=', 'Crew').executeTakeFirstOrThrow()
    const r = await call('POST', '/employees', { first: 'Ines', last: 'Prado', phone: '(305) 555-0177', email: 'ines.e2e@oasis.example', roles: [role.id] })
    expect(r.status, r.text).toBe(201)
    expect(r.body.invite).toMatchObject({ sent: true, channel: 'email' })
    const [m] = sentTo('ines.e2e@oasis.example')
    expect(m).toBeDefined()
    expectEnvelope(m!, 'staff_invite')
    expect(m!.text).toContain(`${ORIGIN}/invite?token=`)
  })

  it('sends a password reset the same way', async () => {
    const r = await fetch(`${API}/api/v1/auth/password/forgot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: ADMIN.email }),
    })
    expect(r.status).toBeLessThan(300)
    const m = await until(async () => sentTo(ADMIN.email)[0], 'the reset email')
    expectEnvelope(m, 'password_reset')
    expect(m.text).toContain(`${ORIGIN}/reset-password?token=`)
  })

  it('sends a receipt; an SNS-signed bounce for it suppresses the next receipt to that address', async () => {
    const CUSTOMER = 'receipt.e2e@oasis.example'
    const inv = await t.db
      .selectFrom('invoices')
      .select(['id', 'customer_id'])
      .where('customer_id', 'is not', null)
      .orderBy('invoice_no')
      .executeTakeFirstOrThrow()
    await t.db.updateTable('customers').set({ email: CUSTOMER, sms_opted_in: false }).where('id', '=', inv.customer_id!).execute()

    const first = await call('POST', `/invoices/${inv.id}/receipt`, {}, { 'idempotency-key': `e2e-receipt-1-${inv.id}` })
    expect(first.status, first.text).toBe(200)
    await jobs!.enqueue('email.send', {})
    const m = await until(async () => sentTo(CUSTOMER)[0], 'the receipt email')
    expectEnvelope(m, 'receipt')
    const row = await t.db.selectFrom('outbox_emails').select(['state', 'provider_message_id', 'appointment_id']).where('to_email', '=', CUSTOMER).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ state: 'sent', provider_message_id: m.messageId })

    const env = notification(cert, sesEvent('Bounce', { messageId: m.messageId, recipient: CUSTOMER, at: new Date() }), { at: new Date() })
    const hook = await fetch(`${API}/hooks/ses`, { method: 'POST', headers: { 'content-type': 'text/plain; charset=UTF-8' }, body: JSON.stringify(env) })
    expect(hook.status, await hook.clone().text()).toBe(200)
    const s = await t.db.selectFrom('email_suppressions').selectAll().where('address', '=', CUSTOMER).executeTakeFirstOrThrow()
    expect(s).toMatchObject({ reason: 'bounce', bounce_type: 'Permanent', source_message_ids: [m.messageId] })
    const c = await t.db.selectFrom('customers').select('email_bounced_at').where('id', '=', inv.customer_id!).executeTakeFirstOrThrow()
    expect(c.email_bounced_at).not.toBeNull()
    if (row.appointment_id) {
      const act = await t.db.selectFrom('activity_log').select('text').where('appointment_id', '=', row.appointment_id).where('text', 'like', 'Receipt email%').execute()
      expect(act).toHaveLength(1)
    }

    const second = await call('POST', `/invoices/${inv.id}/receipt`, {}, { 'idempotency-key': `e2e-receipt-2-${inv.id}` })
    expect(second.status, second.text).toBe(200)
    await jobs!.enqueue('email.send', {})
    const skipped = await until(
      async () => (await t.db.selectFrom('outbox_emails').select(['state', 'error']).where('to_email', '=', CUSTOMER).where('state', '=', 'suppressed').executeTakeFirst()),
      'the second receipt to be skipped',
    )
    expect(skipped.error).toMatch(/^Not sent: r\*\*\*@oasis\.example is suppressed because it bounced \(Permanent \/ General\)/)
    expect(sentTo(CUSTOMER)).toHaveLength(1)
  }, 90_000)

  it('GET /system/integrations reports both integrations configured, with their last success', async () => {
    const r = await call('GET', '/system/integrations')
    expect(r.status).toBe(200)
    const rows = r.body.integrations as Array<{ key: string; configured: boolean; missing: string[]; lastSuccessAt: string | null; details: Record<string, unknown> }>
    const email = rows.find((x) => x.key === 'email')!
    const storage = rows.find((x) => x.key === 'storage')!
    expect(email).toMatchObject({ configured: true, missing: [] })
    expect(email.details).toMatchObject({ credentials: 'environment', endpointOverride: true, suppressedAddresses: 1 })
    expect(email.lastSuccessAt).not.toBeNull()
    expect(storage).toMatchObject({ configured: true, missing: [] })
    expect(storage.lastSuccessAt).not.toBeNull()
    expect(r.text).not.toContain('simulator-secret-access-key')
  })

  it('never asked anything but the simulator: every SES and S3 request carried the simulator key', () => {
    expect(sim.requests.length).toBeGreaterThan(0)
    expect(loadEnv({ DATABASE_URL: testDatabaseUrl(), AWS_EC2_METADATA_DISABLED: 'true' }).AWS_EC2_METADATA_DISABLED).toBe(true)
    expect(output).not.toMatch(/InvalidAccessKeyId|UnrecognizedClient|CredentialsProviderError/)
  })
})
