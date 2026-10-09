// GET /api/v1/system/integrations: for each outside service (email, photo storage, SMS, Squarespace) which provider the process
// runs, whether it is configured for live use, exactly which settings are missing, and the last success and last error the
// database knows about. Nothing secret leaves: credentials are reported by source only, error text is masked and truncated.
import { sql } from 'kysely'
import type { Env } from '../../config/env.js'
import { access } from '../../http/access.js'
import type { AppInstance } from '../../http/types.js'
import { z } from '../../http/zod.js'
import { sesTopicArns } from '../../integrations/email/env.js'
import type { Executor } from '../../platform/db.js'
import { maskText } from '../../platform/logging.js'
import '../messaging/schema.js'
import '../payments-sync/db/schema.js'
import '../../platform/jobs-schema.js'

const iso = z.iso.datetime({ offset: true })

export const IntegrationStatus = z.object({
  key: z.enum(['email', 'storage', 'sms', 'squarespace']),
  label: z.string(),
  provider: z.string(),
  /** The provider talks to the real service (not a simulator). */
  live: z.boolean(),
  /** Live and nothing required is missing. */
  configured: z.boolean(),
  /** Settings that must be set (or actions taken) before this integration works live; names of variables or steps. */
  missing: z.array(z.string()),
  /** Recommended settings that are absent, and conditions worth knowing; never blocking. */
  warnings: z.array(z.string()),
  lastSuccessAt: iso.nullable(),
  lastErrorAt: iso.nullable(),
  lastError: z.string().nullable(),
  /** Non-secret facts (region, bucket, sender, counts). Credentials appear only as their source. */
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
})
export type IntegrationStatus = z.infer<typeof IntegrationStatus>

export const IntegrationsResponse = z.object({ generatedAt: iso, integrations: z.array(IntegrationStatus) })

export type AwsCredentialSource = 'environment' | 'profile' | 'shared-credentials-file' | 'instance-role' | 'none'

/** Where the AWS SDK will find credentials, decided from the environment alone (instance metadata is never contacted). */
export function awsCredentialSource(env: Env): AwsCredentialSource {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return 'environment'
  if (env.AWS_PROFILE) return 'profile'
  // the deploy kit's runtime=user: the oasis-app key in /etc/oasis/aws-credentials, handed over by systemd LoadCredential
  if (env.AWS_SHARED_CREDENTIALS_FILE) return 'shared-credentials-file'
  return env.AWS_EC2_METADATA_DISABLED ? 'none' : 'instance-role'
}

/** Masks email addresses and phone numbers, and AWS access key ids, and keeps the first 300 characters. */
export function safeError(s: string | null | undefined): string | null {
  if (!s) return null
  return maskText(s)
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{8,}\b/g, '$1[redacted]')
    .slice(0, 300)
}

const at = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null)
const latest = (...ds: Array<Date | null | undefined>): Date | null =>
  ds.reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null)

function awsCredentials(env: Env, missing: string[], warnings: string[]): AwsCredentialSource {
  const src = awsCredentialSource(env)
  if (src === 'none') missing.push('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY')
  if (src === 'instance-role')
    warnings.push(
      'AWS credentials are left to the EC2 instance role (pnpm aws:provision --runtime role associates oasis-app-profile), which is not checked here; pnpm verify:aws --instance-profile checks it',
    )
  return src
}

async function jobRun(db: Executor, name: string) {
  return db
    .selectFrom('job_runs')
    .select(['last_success_at', 'last_error_at', 'last_error'])
    .where('name', '=', name)
    .executeTakeFirst()
}

async function emailStatus(db: Executor, env: Env): Promise<IntegrationStatus> {
  const live = env.EMAIL_PROVIDER === 'ses'
  const missing: string[] = []
  const warnings: string[] = []
  if (!live) missing.push('EMAIL_PROVIDER=ses')
  if (!env.SES_FROM_ADDRESS) missing.push('SES_FROM_ADDRESS')
  const credentials = awsCredentials(env, missing, warnings)
  if (!env.SES_CONFIGURATION_SET)
    warnings.push('SES_CONFIGURATION_SET is not set: SES publishes no bounce, complaint or delivery events')
  const topics = sesTopicArns(env)
  if (topics.length === 0) warnings.push('SES_SNS_TOPIC_ARNS is not set: /hooks/ses refuses every bounce and complaint notification')
  if (env.SES_ENDPOINT) warnings.push('SES_ENDPOINT overrides the SES endpoint (simulator use only)')
  if (!live) warnings.push('EMAIL_PROVIDER=sim: email is written to .eml files and nothing is delivered')

  const ok = await db.selectFrom('outbox_emails').select(sql<Date | null>`max(sent_at)`.as('t')).where('state', '=', 'sent').executeTakeFirst()
  const bad = await db
    .selectFrom('outbox_emails')
    .select(['error', 'error_at'])
    .where('error', 'is not', null)
    .where('error_at', 'is not', null)
    .orderBy('error_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  const supp = await db
    .selectFrom('email_suppressions')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('cleared_at', 'is', null)
    .executeTakeFirst()
  const feedback = await db
    .selectFrom('webhook_log')
    .select(sql<Date | null>`max(received_at)`.as('t'))
    .where('provider', '=', 'ses')
    .executeTakeFirst()
  return {
    key: 'email',
    label: 'Email (Amazon SES)',
    provider: env.EMAIL_PROVIDER,
    live,
    configured: live && missing.length === 0,
    missing,
    warnings,
    lastSuccessAt: at(ok?.t),
    lastErrorAt: at(bad?.error_at),
    lastError: safeError(bad?.error),
    details: {
      region: env.AWS_REGION,
      from: env.SES_FROM_ADDRESS ?? null,
      fromName: env.SES_FROM_NAME,
      replyTo: env.SES_REPLY_TO ?? null,
      configurationSet: env.SES_CONFIGURATION_SET ?? null,
      feedbackTopics: topics.length,
      lastFeedbackAt: at(feedback?.t),
      suppressedAddresses: supp?.n ?? 0,
      endpointOverride: !!env.SES_ENDPOINT,
      credentials,
    },
  }
}

async function storageStatus(db: Executor, env: Env): Promise<IntegrationStatus> {
  const live = env.STORAGE_PROVIDER === 's3'
  const missing: string[] = []
  const warnings: string[] = []
  if (!live) missing.push('STORAGE_PROVIDER=s3')
  if (!env.S3_BUCKET) missing.push('S3_BUCKET')
  const credentials = awsCredentials(env, missing, warnings)
  if (!env.S3_KEY_PREFIX) warnings.push('S3_KEY_PREFIX is empty: objects are written at the bucket root (the provisioned policy allows only prod/)')
  if (env.S3_ENDPOINT) warnings.push('S3_ENDPOINT overrides the S3 endpoint (simulator or S3-compatible store)')
  if (!live) warnings.push('STORAGE_PROVIDER=fs: photos are kept on this host')

  const photo = await db
    .selectFrom('appointment_photos')
    .select(sql<Date | null>`max(created_at)`.as('t'))
    .where('status', '=', 'ready')
    .where('s3_key', 'is not', null)
    .executeTakeFirst()
  const thumb = await jobRun(db, 'photos.thumbnail')
  const retention = await jobRun(db, 'photos.retention')
  const errs = [thumb, retention].filter((r) => r?.last_error_at).sort((a, b) => +b!.last_error_at! - +a!.last_error_at!)
  return {
    key: 'storage',
    label: 'Photo storage (Amazon S3)',
    provider: env.STORAGE_PROVIDER,
    live,
    configured: live && missing.length === 0,
    missing,
    warnings,
    lastSuccessAt: at(latest(photo?.t ?? null, thumb?.last_success_at)),
    lastErrorAt: at(errs[0]?.last_error_at),
    lastError: safeError(errs[0]?.last_error),
    details: {
      region: env.AWS_REGION,
      bucket: env.S3_BUCKET ?? null,
      keyPrefix: env.S3_KEY_PREFIX,
      encryption: env.S3_SSE,
      endpointOverride: !!env.S3_ENDPOINT,
      pathStyle: env.S3_FORCE_PATH_STYLE === 'true',
      credentials,
    },
  }
}

async function smsStatus(db: Executor, env: Env): Promise<IntegrationStatus> {
  const devices = await db
    .selectFrom('sms_devices')
    .select(['provider', 'enabled', 'status', 'last_error', 'updated_at', 'webhooks_registered_at'])
    .execute()
  const enabled = devices.filter((d) => d.enabled)
  const real = enabled.filter((d) => d.provider === 'smsgate')
  const live = env.SMS_PROVIDER === 'smsgate' || real.length > 0
  const missing: string[] = []
  const warnings: string[] = []
  if (real.length === 0) missing.push('an SMS Gate tablet (oasis-admin.sh sms-add-device, or POST /api/v1/integrations/sms/devices)')
  if (!env.SMSGATE_WEBHOOK_PUBLIC_URL) missing.push('SMSGATE_WEBHOOK_PUBLIC_URL')
  if (!env.SECRETS_KEY) missing.push('SECRETS_KEY')
  if (real.length > 0 && real.every((d) => !d.webhooks_registered_at)) warnings.push('the tablet has no webhooks registered (oasis-admin.sh sms-register-webhooks)')
  if (real.some((d) => d.status === 'offline')) warnings.push('a tablet is offline')
  if (env.SMS_PROVIDER !== 'smsgate') warnings.push(`SMS_PROVIDER=${env.SMS_PROVIDER}`)
  const sent = await db
    .selectFrom('sms_outbox')
    .select(sql<Date | null>`max(coalesce(sent_at, accepted_at))`.as('t'))
    .where('state', 'in', ['accepted', 'sent', 'delivered'])
    .executeTakeFirst()
  const failed = await db
    .selectFrom('sms_outbox')
    .select(['failed_at', 'last_error'])
    .where('failed_at', 'is not', null)
    .orderBy('failed_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  const deviceError = enabled.filter((d) => d.last_error).sort((a, b) => +b.updated_at - +a.updated_at)[0]
  const useDevice = deviceError && (!failed?.failed_at || deviceError.updated_at > failed.failed_at)
  return {
    key: 'sms',
    label: 'SMS (SMS Gate tablet)',
    provider: env.SMS_PROVIDER,
    live,
    configured: live && missing.length === 0,
    missing,
    warnings,
    lastSuccessAt: at(sent?.t),
    lastErrorAt: at(useDevice ? deviceError.updated_at : failed?.failed_at),
    lastError: safeError(useDevice ? deviceError.last_error : failed?.last_error),
    details: {
      devices: enabled.length,
      tablets: real.length,
      online: real.filter((d) => d.status === 'online').length,
      webhookUrlSet: !!env.SMSGATE_WEBHOOK_PUBLIC_URL,
    },
  }
}

async function squarespaceStatus(db: Executor, env: Env): Promise<IntegrationStatus> {
  const conn = await db
    .selectFrom('sqsp_connections')
    .select(['status', 'api_key_enc', 'last_error', 'last_verified_at', 'updated_at'])
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst()
  const stored = !!conn?.api_key_enc && conn.status !== 'disconnected'
  const live = env.SQSP_PROVIDER === 'live'
  const missing: string[] = []
  const warnings: string[] = []
  if (!live) missing.push('SQSP_PROVIDER=live')
  if (!stored && !env.SQSP_API_KEY)
    missing.push('a Squarespace API key (PUT /api/v1/integrations/squarespace/connection, or SQSP_API_KEY)')
  if (stored && !env.SECRETS_KEY) missing.push('SECRETS_KEY (the stored key cannot be read without it)')
  if (conn?.status === 'error') warnings.push('the stored connection is in error')
  const sync = await db
    .selectFrom('sqsp_sync_state')
    .select(['last_success_at', 'last_error', 'last_run_at', 'status'])
    .execute()
  const lastOk = latest(...sync.map((s) => s.last_success_at), conn?.last_verified_at)
  const errs = sync.filter((s) => s.last_error && s.last_run_at).sort((a, b) => +b.last_run_at! - +a.last_run_at!)
  const err = errs[0]
  const connErr = conn?.last_error ? conn : undefined
  const useConn = connErr && (!err || connErr.updated_at > err.last_run_at!)
  return {
    key: 'squarespace',
    label: 'Squarespace (orders and payments, read only)',
    provider: env.SQSP_PROVIDER,
    live,
    configured: live && missing.length === 0,
    missing,
    warnings,
    lastSuccessAt: at(lastOk),
    lastErrorAt: at(useConn ? connErr.updated_at : err?.last_run_at),
    lastError: safeError(useConn ? connErr.last_error : err?.last_error),
    details: {
      connection: stored ? 'stored' : env.SQSP_API_KEY ? 'environment' : 'none',
      connectionStatus: conn?.status ?? null,
      apiBaseOverride: env.SQSP_API_BASE !== 'https://api.squarespace.com',
    },
  }
}

export async function integrationsStatus(db: Executor, env: Env, now: Date) {
  return {
    generatedAt: now.toISOString(),
    integrations: [
      await emailStatus(db, env),
      await storageStatus(db, env),
      await smsStatus(db, env),
      await squarespaceStatus(db, env),
    ],
  }
}

export function registerIntegrationRoutes(app: AppInstance): void {
  app.get(
    '/system/integrations',
    {
      config: { access: access.perm('set.billing') },
      schema: {
        tags: ['system'],
        summary: 'Outside services: provider, configured or not, missing settings, last success and last error',
        description:
          'One row per integration (email, storage, sms, squarespace). `missing` names exactly what must be set (environment variables, or a step such as registering a tablet) before the integration works live; `warnings` are recommended settings and conditions. Secrets are never returned: AWS credentials appear only as their source (`environment`, `profile`, `shared-credentials-file`, `instance-role`, `none`) and error texts are masked.',
        response: { 200: IntegrationsResponse },
      },
    },
    async () => integrationsStatus(app.db, app.env, app.clock.now()),
  )
}
