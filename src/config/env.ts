import { z } from 'zod'

const provider = <T extends [string, ...string[]]>(...v: T) => z.enum(v)
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

// Fail-fast, typed environment contract. `*_PROVIDER=sim` needs no other variable for that integration.
export const envSchema = z
  .object({
    NODE_ENV: provider('development', 'test', 'production').default('development'),
    PORT: z.coerce.number().int().default(4000),
    LOG_LEVEL: provider('fatal', 'error', 'warn', 'info', 'debug', 'trace').default('info'),
    DATABASE_URL: z.string().url(),
    SESSION_SECRET: z.string().min(32).optional(),
    SESSION_COOKIE_NAME: z.string().default('oasis_sid'),
    SECRETS_KEY: z.string().optional(), // base64 32 bytes; encrypts integration credentials at rest
    COOKIE_SECURE: bool.default('false'),
    TRUST_PROXY: bool.default('false'),
    PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
    PUBLIC_DASHBOARD_URL: z.string().url().default('http://localhost:3000'),
    BUSINESS_TZ: z.string().default('America/New_York'),
    BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
    CLOCK_FREEZE_AT: z.string().optional(), // parity/test only; refused when NODE_ENV=production
    ALLOW_DEV_ENDPOINTS: bool.default('false'),
    JOBS_ENABLED: bool.default('true'),
    RESCHEDULE_LINK_ENABLED: bool.default('false'),

    SQSP_PROVIDER: provider('sim', 'live').default('sim'),
    SQSP_API_BASE: z.string().url().default('https://api.squarespace.com'),
    SQSP_API_KEY: z.string().optional(),
    SQSP_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(120),

    SMS_PROVIDER: provider('sim', 'smsgate').default('sim'),
    SMSGATE_DEVICE_URL: z.string().url().optional(),
    SMSGATE_USERNAME: z.string().optional(),
    SMSGATE_PASSWORD: z.string().optional(),
    SMSGATE_WEBHOOK_SECRET: z.string().optional(),
    SMSGATE_MAX_PER_WINDOW: z.coerce.number().int().positive().default(30), // per SMSGATE_WINDOW_MINUTES
    SMSGATE_WINDOW_MINUTES: z.coerce.number().int().positive().default(30),
    SMS_ALLOWLIST: z.string().default(''), // comma-separated E.164; empty = unrestricted in production only

    EMAIL_PROVIDER: provider('sim', 'ses').default('sim'),
    AWS_REGION: z.string().default('us-east-1'),
    SES_FROM_ADDRESS: z.string().email().optional(),

    STORAGE_PROVIDER: provider('fs', 's3').default('fs'),
    STORAGE_FS_ROOT: z.string().default('./.data/files'),
    S3_BUCKET: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    const need = (cond: boolean, path: string, msg: string) =>
      cond && ctx.addIssue({ code: 'custom', path: [path], message: msg })
    need(
      e.NODE_ENV === 'production' && !!e.CLOCK_FREEZE_AT,
      'CLOCK_FREEZE_AT',
      'must not be set in production',
    )
    need(e.NODE_ENV === 'production' && !e.SESSION_SECRET, 'SESSION_SECRET', 'required in production')
    need(e.SQSP_PROVIDER === 'live' && !e.SQSP_API_KEY, 'SQSP_API_KEY', 'required when SQSP_PROVIDER=live')
    need(e.SMS_PROVIDER === 'smsgate' && !e.SMSGATE_DEVICE_URL, 'SMSGATE_DEVICE_URL', 'required for smsgate')
    need(e.SMS_PROVIDER === 'smsgate' && !e.SMSGATE_USERNAME, 'SMSGATE_USERNAME', 'required for smsgate')
    need(e.SMS_PROVIDER === 'smsgate' && !e.SMSGATE_PASSWORD, 'SMSGATE_PASSWORD', 'required for smsgate')
    need(
      e.SMS_PROVIDER === 'smsgate' && !e.SMSGATE_WEBHOOK_SECRET,
      'SMSGATE_WEBHOOK_SECRET',
      'required for smsgate',
    )
    need(
      e.EMAIL_PROVIDER === 'ses' && !e.SES_FROM_ADDRESS,
      'SES_FROM_ADDRESS',
      'required when EMAIL_PROVIDER=ses',
    )
    need(e.STORAGE_PROVIDER === 's3' && !e.S3_BUCKET, 'S3_BUCKET', 'required when STORAGE_PROVIDER=s3')
  })

export type Env = z.infer<typeof envSchema>

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid environment:\n${lines.join('\n')}`)
  }
  return parsed.data
}
