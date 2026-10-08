// GET /api/v1/system/integrations: provider, configured or not, exactly which settings are missing, last success and last error,
// and never a secret.
import { afterEach, describe, expect, it } from 'vitest'
import { systemModule } from '../../src/modules/system/index.js'
import { awsCredentialSource, safeError } from '../../src/modules/system/integrations.js'
import { loadEnv } from '../../src/config/env.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { useTestDb } from '../helpers/db.js'

const t = useTestDb()
let app: TestApp | undefined
afterEach(async () => {
  await app?.close()
  app = undefined
})

const KEY_ID = 'AKIAEXAMPLEKEY123456'
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')

async function status(env: Record<string, string>, headers: Record<string, string> = {}) {
  app = await createTestApp({ testDb: t, modules: [systemModule], env })
  const res = await app.app.inject({ method: 'GET', url: '/api/v1/system/integrations', headers })
  return res
}

type Row = { key: string; provider: string; live: boolean; configured: boolean; missing: string[]; warnings: string[]; lastSuccessAt: string | null; lastErrorAt: string | null; lastError: string | null; details: Record<string, unknown> }
const by = (body: { integrations: Row[] }, key: string): Row => body.integrations.find((r) => r.key === key)!

describe('GET /system/integrations', () => {
  it('on the simulators lists what each integration still needs to go live', async () => {
    const res = await status({})
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.integrations.map((r: Row) => r.key)).toEqual(['email', 'storage', 'sms', 'squarespace'])
    expect(by(body, 'email')).toMatchObject({ provider: 'sim', live: false, configured: false, missing: ['EMAIL_PROVIDER=ses', 'SES_FROM_ADDRESS'] })
    expect(by(body, 'storage')).toMatchObject({ provider: 'fs', live: false, configured: false, missing: ['STORAGE_PROVIDER=s3', 'S3_BUCKET'] })
    expect(by(body, 'sms').missing).toEqual([
      'an SMS Gate tablet (oasis-admin.sh sms-add-device, or POST /api/v1/integrations/sms/devices)',
      'SMSGATE_WEBHOOK_PUBLIC_URL',
      'SECRETS_KEY',
    ])
    expect(by(body, 'squarespace').missing).toEqual([
      'SQSP_PROVIDER=live',
      'a Squarespace API key (PUT /api/v1/integrations/squarespace/connection, or SQSP_API_KEY)',
    ])
    expect(by(body, 'email').details.credentials).toBe('instance-role')
  })

  it('is configured when SES and S3 have everything, reports credentials by source only and returns no secret', async () => {
    const res = await status({
      EMAIL_PROVIDER: 'ses',
      SES_FROM_ADDRESS: 'no-reply@oasis.example',
      SES_CONFIGURATION_SET: 'oasis-mail',
      SES_SNS_TOPIC_ARNS: 'arn:aws:sns:us-east-1:123456789012:oasis-ses-events',
      STORAGE_PROVIDER: 's3',
      S3_BUCKET: 'oasis-photos-123456789012',
      S3_KEY_PREFIX: 'prod/',
      AWS_ACCESS_KEY_ID: KEY_ID,
      AWS_SECRET_ACCESS_KEY: SECRET,
      AWS_EC2_METADATA_DISABLED: 'true',
    })
    const body = res.json()
    expect(by(body, 'email')).toMatchObject({ provider: 'ses', live: true, configured: true, missing: [], warnings: [] })
    expect(by(body, 'email').details).toMatchObject({ from: 'no-reply@oasis.example', configurationSet: 'oasis-mail', feedbackTopics: 1, credentials: 'environment' })
    expect(by(body, 'storage')).toMatchObject({ provider: 's3', live: true, configured: true, missing: [], warnings: [] })
    expect(by(body, 'storage').details).toMatchObject({ bucket: 'oasis-photos-123456789012', keyPrefix: 'prod/', credentials: 'environment' })
    expect(res.body).not.toContain(SECRET)
    expect(res.body).not.toContain(KEY_ID)
    expect(res.body).not.toContain('123456789012:oasis-ses-events')
  })

  it('names the missing credentials when the instance role is switched off and no key is set', async () => {
    const body = (await status({ STORAGE_PROVIDER: 's3', S3_BUCKET: 'b', AWS_EC2_METADATA_DISABLED: 'true' })).json()
    expect(by(body, 'storage')).toMatchObject({ configured: false, missing: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] })
    expect(by(body, 'email').missing).toEqual(['EMAIL_PROVIDER=ses', 'SES_FROM_ADDRESS', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])
  })

  it('Squarespace live works with only the stored connection (no SQSP_API_KEY)', async () => {
    app = await createTestApp({ testDb: t, modules: [systemModule], env: { SQSP_PROVIDER: 'live', SECRETS_KEY } })
    await t.db
      .insertInto('sqsp_connections')
      .values({ id: app.app.newId(), location_id: app.location.id, api_key_enc: 'k1:iv:tag:ciphertext', status: 'connected', last_verified_at: t.clock.now() } as never)
      .execute()
    const body = (await app.app.inject({ method: 'GET', url: '/api/v1/system/integrations' })).json()
    expect(by(body, 'squarespace')).toMatchObject({ provider: 'live', configured: true, missing: [], lastSuccessAt: t.clock.now().toISOString() })
    expect(by(body, 'squarespace').details.connection).toBe('stored')
    expect(JSON.stringify(body)).not.toContain('ciphertext')
  })

  it('reports the last email success and the last error, masked', async () => {
    app = await createTestApp({ testDb: t, modules: [systemModule] })
    const now = t.clock.now()
    const earlier = new Date(now.getTime() - 3600_000)
    await t.db
      .insertInto('outbox_emails')
      .values([
        { id: app.app.newId(), location_id: app.location.id, to_email: 'a@example.test', template: 'receipt', vars: '{}' as never, state: 'sent', sent_at: earlier },
        {
          id: app.app.newId(),
          location_id: app.location.id,
          to_email: 'jane@example.test',
          template: 'receipt',
          vars: '{}' as never,
          state: 'failed',
          error: `SES SendEmail failed (MessageRejected: Email address is not verified: jane@example.test, key ${KEY_ID})`,
          error_at: now,
        },
      ])
      .execute()
    const email = by((await app.app.inject({ method: 'GET', url: '/api/v1/system/integrations' })).json(), 'email')
    expect(email.lastSuccessAt).toBe(earlier.toISOString())
    expect(email.lastErrorAt).toBe(now.toISOString())
    expect(email.lastError).toBe('SES SendEmail failed (MessageRejected: Email address is not verified: j***@example.test, key AKIA[redacted])')
  })

  it('requires set.billing', async () => {
    expect((await status({}, { 'x-test-permissions': 'pay.reports' })).statusCode).toBe(403)
  })
})

describe('helpers', () => {
  const base = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db' }
  it('decides the credential source from the environment alone', () => {
    expect(awsCredentialSource(loadEnv(base))).toBe('instance-role')
    expect(awsCredentialSource(loadEnv({ ...base, AWS_EC2_METADATA_DISABLED: 'true' }))).toBe('none')
    expect(awsCredentialSource(loadEnv({ ...base, AWS_PROFILE: 'oasis' }))).toBe('profile')
    expect(awsCredentialSource(loadEnv({ ...base, AWS_ACCESS_KEY_ID: KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET }))).toBe('environment')
    expect(() => loadEnv({ ...base, AWS_ACCESS_KEY_ID: KEY_ID })).toThrow(/AWS_SECRET_ACCESS_KEY/)
  })
  it('masks addresses, phone numbers and access key ids and truncates', () => {
    expect(safeError(null)).toBeNull()
    expect(safeError(`x ${'y'.repeat(400)}`)).toHaveLength(300)
    expect(safeError('to +13055550101 from ASIAABCDEFGHIJKLMNOP')).toBe('to +1******0101 from ASIA[redacted]')
  })
})
