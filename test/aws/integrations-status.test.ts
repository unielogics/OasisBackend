// GET /api/v1/system/integrations: provider, configured or not, exactly which settings are missing, last success and last error,
// and never a secret.
import { DateTime } from 'luxon'
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
    expect(body.integrations.map((r: Row) => r.key)).toEqual(['email', 'storage', 'sms', 'squarespace', 'square', 'ai'])
    expect(by(body, 'square')).toMatchObject({ provider: 'sim', live: false, configured: false })
    expect(by(body, 'square').missing.slice(0, 6)).toEqual([
      'SQUARE_PROVIDER=live',
      'SQUARE_ACCESS_TOKEN',
      'SQUARE_LOCATION_ID',
      'SQUARE_APPLICATION_ID',
      'SQUARE_WEBHOOK_SIGNATURE_KEY',
      'SQUARE_WEBHOOK_URL',
    ])
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

  it('the AI row: simulated and off by default, nothing reached', async () => {
    const ai = by((await status({})).json(), 'ai')
    expect(ai).toMatchObject({ provider: 'sim', live: false, configured: false, missing: ['AI_PROVIDER=bedrock'], lastSuccessAt: null, lastErrorAt: null, lastError: null })
    expect(ai.warnings).toEqual(['AI_ENABLED=false: the assistant answers no text'])
    expect(ai.details).toEqual({
      model: 'sim', modelLabel: null, region: null, enabled: false, envEnabled: false, settingEnabled: false, stage: 'allowlist', actionsEnabled: false,
      effortMode: 'off', turnsToday: 0, spendTodayUsd: 0, dailyBudgetUsd: 10, priceSource: 'model', credentials: 'instance-role',
    })
  })

  it('the AI row on Bedrock: model, stage, enabled, the last replied and failed turn (masked), today\'s turns and spend', async () => {
    app = await createTestApp({
      testDb: t,
      modules: [systemModule],
      env: { AI_PROVIDER: 'bedrock', AI_ENABLED: 'true', AI_DAILY_BUDGET_USD: '0.01', AWS_ACCESS_KEY_ID: KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET, AWS_EC2_METADATA_DISABLED: 'true' },
    })
    const loc = app.location.id
    await t.db
      .insertInto('settings')
      .values({ location_id: loc, key: 'assistant.enabled', value: JSON.stringify(true) as never, version: 2 })
      .onConflict((oc) => oc.columns(['location_id', 'key']).doUpdateSet({ value: JSON.stringify(true) as never }))
      .execute()
    const now = t.clock.now()
    const conv = app.app.newId()
    await t.db.insertInto('assistant_conversations').values({ id: conv, location_id: loc, phone_e164: '+12015550142' } as never).execute()
    const turn = (status: string, startedAt: Date, cost: number, error: string | null = null) => ({
      id: app!.app.newId(), conversation_id: conv, status, trust: 'known', provider: 'bedrock', model: 'us.anthropic.claude-sonnet-4-6',
      cost_micros: cost, error, started_at: startedAt, finished_at: new Date(startedAt.getTime() + 4000),
    })
    // start of today in the shop's time zone, so the test does not depend on the clock's hour
    const dayStart = DateTime.fromJSDate(now).setZone('America/New_York').startOf('day').toJSDate()
    const beforeToday = new Date(dayStart.getTime() - 3600_000)
    const today = new Date(Math.max(dayStart.getTime() + 60_000, now.getTime() - 3600_000))
    await t.db
      .insertInto('assistant_turns')
      .values([
        turn('replied', beforeToday, 900_000),
        turn('replied', today, 2_600),
        turn('failed', new Date(today.getTime() + 1000), 1_400, 'Bedrock Converse refused access (AccessDeniedException 403: client +12015550142 key ASIAABCDEFGHIJKLMNOP)'),
      ] as never)
      .execute()
    const ai = by((await app.app.inject({ method: 'GET', url: '/api/v1/system/integrations' })).json(), 'ai')
    expect(ai).toMatchObject({ provider: 'bedrock', live: true, configured: true, missing: [] })
    expect(ai.details).toMatchObject({
      model: 'us.anthropic.claude-sonnet-4-6', modelLabel: 'Claude Sonnet 4.6', region: 'us-east-1', enabled: true, envEnabled: true, settingEnabled: true, stage: 'allowlist',
      turnsToday: 2, spendTodayUsd: 0.004, dailyBudgetUsd: 0.01, priceSource: 'model', credentials: 'environment',
    })
    expect(ai.lastSuccessAt).toBe(new Date(today.getTime() + 4000).toISOString())
    expect(ai.lastErrorAt).toBe(new Date(today.getTime() + 5000).toISOString())
    expect(ai.lastError).toBe('Bedrock Converse refused access (AccessDeniedException 403: client +1******0142 key ASIA[redacted])')
    expect(ai.warnings).toEqual(['stage allowlist: the assistant answers only the allowlisted numbers'])
    // over the budget: said so
    await t.db.updateTable('assistant_turns').set({ cost_micros: 20_000 }).where('started_at', '=', today).execute()
    const over = by((await app.app.inject({ method: 'GET', url: '/api/v1/system/integrations' })).json(), 'ai')
    expect(over.warnings).toContain("today's spend reached AI_DAILY_BUDGET_USD (0.01): every text goes to the staff until tomorrow")
  })

  it('the AI row names a model outside the IAM grant list, and where the prices come from', async () => {
    app = await createTestApp({
      testDb: t,
      modules: [systemModule],
      env: {
        AI_PROVIDER: 'bedrock', AI_BEDROCK_MODEL_ID: 'us.anthropic.claude-haiku-4-5', AI_PRICE_OUTPUT_PER_MTOK: '30',
        AWS_ACCESS_KEY_ID: KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET, AWS_EC2_METADATA_DISABLED: 'true',
      },
    })
    const ai = by((await app.app.inject({ method: 'GET', url: '/api/v1/system/integrations' })).json(), 'ai')
    expect(ai.details).toMatchObject({ model: 'us.anthropic.claude-haiku-4-5', modelLabel: null, priceSource: 'mixed' })
    expect(ai.warnings).toContain(
      'AI_BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5 is not one of the models the app role may call (us.anthropic.claude-sonnet-5-5, us.anthropic.claude-opus-5-5, us.anthropic.claude-sonnet-4-6, us.anthropic.claude-opus-4-6-v1): Bedrock refuses it',
    )
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
    expect(awsCredentialSource(loadEnv({ ...base, AWS_SHARED_CREDENTIALS_FILE: '/run/credentials/oasis-api.service/aws-credentials', AWS_EC2_METADATA_DISABLED: 'true' }))).toBe('shared-credentials-file')
    expect(awsCredentialSource(loadEnv({ ...base, AWS_ACCESS_KEY_ID: KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET }))).toBe('environment')
    expect(() => loadEnv({ ...base, AWS_ACCESS_KEY_ID: KEY_ID })).toThrow(/AWS_SECRET_ACCESS_KEY/)
  })
  it('masks addresses, phone numbers and access key ids and truncates', () => {
    expect(safeError(null)).toBeNull()
    expect(safeError(`x ${'y'.repeat(400)}`)).toHaveLength(300)
    expect(safeError('to +13055550101 from ASIAABCDEFGHIJKLMNOP')).toBe('to +1******0101 from ASIA[redacted]')
  })
})
