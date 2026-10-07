import { z } from 'zod'
import { squarespaceEnvSchema } from '../integrations/squarespace/config.js'

const provider = <T extends [string, ...string[]]>(...v: T) => z.enum(v)
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal'])
const PROXY_ADDRESS = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+)(?:\/\d{1,3})?$/i

/**
 * Which proxy hops may set X-Forwarded-For. Never "everyone": fastify's `true` believes the LEFT-most entry, which behind nginx's
 * $proxy_add_x_forwarded_for is whatever the client typed. So `true` means exactly one trusted hop (the proxy in front of the app,
 * whose appended entry is the real client); a number is a hop count; anything else is a comma-separated list of addresses, CIDR
 * ranges or loopback/linklocal/uniquelocal.
 */
const trustProxy = z
  .string()
  .default('false')
  .transform((raw, ctx): boolean | number | string[] => {
    const v = raw.trim().toLowerCase()
    if (v === 'false' || v === '0' || v === '') return false
    if (v === 'true') return 1
    if (/^\d{1,2}$/.test(v)) return Number(v)
    const list = v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    if (list.length > 0 && list.every((x) => PROXY_KEYWORDS.has(x) || PROXY_ADDRESS.test(x))) return list
    ctx.addIssue({
      code: 'custom',
      message:
        'use false, a number of proxy hops, or a comma-separated list of addresses, CIDR ranges or loopback',
    })
    return z.NEVER
  })

// The Squarespace tuning variables live with the adapter (src/integrations/squarespace/config.ts); only the ones the shared
// contract below does not already declare are picked up here, so there is one definition of each.
const squarespaceTuning = squarespaceEnvSchema.pick({
  SQSP_USER_AGENT: true,
  SQSP_OVERLAP_SECONDS: true,
  SQSP_RECONCILE_DAYS: true,
  SQSP_REQUESTS_PER_MINUTE: true,
  SQSP_MAX_REQUESTS_PER_RUN: true,
  SQSP_INCLUDE_TEST_ORDERS: true,
  SQSP_MEMBERSHIP_GRACE_DAYS: true,
  SQSP_MATCH_CONFIDENCE_THRESHOLD: true,
  SQSP_VARIANCE_ALERT_CENTS: true,
  SQSP_LINK_WINDOW_DAYS: true,
  SQSP_LINK_AMOUNT_TOLERANCE_CENTS: true,
  SQSP_PRODUCT_MAP: true,
  SQSP_WEBHOOK_SECRET: true,
}).shape

const validSecretsKey = (v: string | undefined): boolean => !!v && Buffer.from(v, 'base64').length === 32

// Fail-fast, typed environment contract. `*_PROVIDER=sim` needs no other variable for that integration.
export const envSchema = z
  .object({
    NODE_ENV: provider('development', 'test', 'production').default('development'),
    PORT: z.coerce.number().int().default(4000),
    HOST: z.string().default('127.0.0.1'),
    LOG_LEVEL: provider('fatal', 'error', 'warn', 'info', 'debug', 'trace').default('info'),
    DATABASE_URL: z.string().url(),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
    DB_SEARCH_PATH: z.string().optional(), // per-worker test schemas only; leave unset elsewhere
    PGBOSS_SCHEMA: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/i)
      .default('pgboss'),
    SESSION_SECRET: z.string().min(32).optional(),
    SESSION_COOKIE_NAME: z.string().default('oasis_sid'),
    SECRETS_KEY: z.string().optional(), // base64 32 bytes; encrypts integration credentials at rest
    COOKIE_SECURE: bool.default('false'),
    TRUST_PROXY: trustProxy, // false | hops | address list; see trustProxy above
    PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
    PUBLIC_DASHBOARD_URL: z.string().url().default('http://localhost:3000'),
    ALLOWED_ORIGINS: z.string().default(''), // extra comma-separated browser origins allowed on unsafe methods
    RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).default(300),
    SSE_HEARTBEAT_MS: z.coerce.number().int().min(50).default(20_000),
    BUSINESS_TZ: z.string().default('America/New_York'),
    BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),
    CLOCK_FREEZE_AT: z.string().optional(), // parity/test only; refused when NODE_ENV=production
    ALLOW_DEV_ENDPOINTS: bool.default('false'),
    DEV_AUTH_BYPASS: bool.default('false'), // local development only: every request is a signed-in user with all permissions
    JOBS_ENABLED: bool.default('true'),
    RESCHEDULE_LINK_ENABLED: bool.default('false'),

    SQSP_PROVIDER: provider('sim', 'live').default('sim'),
    SQSP_API_BASE: z.string().url().default('https://api.squarespace.com'),
    SQSP_API_KEY: z.string().optional(),
    SQSP_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(120),
    ...squarespaceTuning,
    // Days past the grace period with no renewal before a membership is inferred canceled (lagged); 0 never infers it.
    SQSP_LAPSE_CANCEL_DAYS: z.coerce.number().int().min(0).default(60),

    SMS_PROVIDER: provider('sim', 'smsgate').default('sim'),
    SMSGATE_DEVICE_URL: z.string().url().optional(),
    SMSGATE_USERNAME: z.string().optional(),
    SMSGATE_PASSWORD: z.string().optional(),
    SMSGATE_WEBHOOK_SECRET: z.string().optional(),
    SMSGATE_MAX_PER_WINDOW: z.coerce.number().int().positive().default(30), // per SMSGATE_WINDOW_MINUTES
    SMSGATE_WINDOW_MINUTES: z.coerce.number().int().positive().default(30),
    SMS_ALLOWLIST: z.string().default(''), // comma-separated E.164; empty = unrestricted in production only
    // Messaging runtime (src/modules/messaging). All optional; docs/integrations/smsgate.md section 4 lists the defaults.
    SMS_DISPATCH_MODE: provider('jobs', 'inline', 'off').default('jobs'), // who drains sms_outbox: pg-boss worker, this API process, nobody
    SMS_TICK_INTERVAL_MS: z.coerce.number().int().min(250).default(2000),
    SMS_QUIET_HOURS: z.string().optional(), // "21:00-08:00" (default) or "off"; holds non-transactional classes only
    SMSGATE_WEBHOOK_PUBLIC_URL: z.string().url().optional(), // https://<host>.<tailnet>.ts.net/hooks/smsgate (the tablet appends /<deviceKey>)
    SMSGATE_API_PATH: z.string().default('/messages'),
    SMSGATE_TIMEOUT_MS: z.coerce.number().int().min(500).default(10_000),
    SMSGATE_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).default(86_400),
    SMSGATE_RESEND_ATTEMPTS: z.coerce.number().int().min(0).max(3).default(1),
    SMSGATE_SIM_NUMBER: z.coerce.number().int().min(1).max(3).optional(),
    SMSGATE_LEGACY_MESSAGE_FIELD: bool.default('false'),
    SMSGATE_SYNC_SIGNING_KEY: bool.default('false'),
    SMSGATE_ALLOW_INSECURE_WEBHOOK_URL: bool.default('false'),
    SMSGATE_RESERVED_P0: z.coerce.number().int().min(0).default(6),
    SMSGATE_SAFETY_MARGIN: z.coerce.number().int().min(0).default(0),
    SMSGATE_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(3000),
    SMSGATE_MAX_SEGMENTS: z.coerce.number().int().min(1).default(8),
    SMSGATE_HEARTBEAT_STALE_SECONDS: z.coerce.number().int().min(60).default(600),
    SMSGATE_ONLINE_WITHIN_SECONDS: z.coerce.number().int().min(30).default(180),
    BUSINESS_PHONE: z.string().optional(), // shown in the HELP reply
    HOOKS_HOST: z.string().default('127.0.0.1'), // the tailnet-facing hooks listener (src/server.ts)
    HOOKS_PORT: z.coerce.number().int().min(0).default(3002), // 0 disables the second listener

    EMAIL_PROVIDER: provider('sim', 'ses').default('sim'),
    AWS_REGION: z.string().default('us-east-1'),
    SES_FROM_ADDRESS: z.string().email().optional(),
    SES_FROM_NAME: z.string().default('Oasis Auto Spa'),
    SES_REPLY_TO: z.string().email().optional(),
    SES_CONFIGURATION_SET: z.string().optional(),
    EMAIL_CONSOLE_DIR: z.string().default('./.data/mail'), // where the sim driver writes .eml files

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
    need(
      !!e.CLOCK_FREEZE_AT && Number.isNaN(Date.parse(e.CLOCK_FREEZE_AT)),
      'CLOCK_FREEZE_AT',
      'must be an ISO-8601 instant',
    )
    need(e.NODE_ENV === 'production' && e.DEV_AUTH_BYPASS, 'DEV_AUTH_BYPASS', 'must not be set in production')
    need(e.NODE_ENV === 'production' && !e.SESSION_SECRET, 'SESSION_SECRET', 'required in production')
    // The session cookie, the __Host- prefix and HSTS all follow COOKIE_SECURE; production is HTTPS only.
    need(e.NODE_ENV === 'production' && !e.COOKIE_SECURE, 'COOKIE_SECURE', 'must be true in production')
    need(
      e.NODE_ENV === 'production' && e.ALLOW_DEV_ENDPOINTS,
      'ALLOW_DEV_ENDPOINTS',
      'must not be set in production',
    )
    need(
      e.NODE_ENV === 'production' && !validSecretsKey(e.SECRETS_KEY),
      'SECRETS_KEY',
      'required in production: base64 of 32 random bytes (it seals device and API credentials)',
    )
    for (const name of ['PUBLIC_DASHBOARD_URL', 'PUBLIC_API_URL'] as const)
      need(
        e.NODE_ENV === 'production' && !e[name].startsWith('https://'),
        name,
        'must be an https:// URL in production (it is the origin the browser may call from and the host of the links we text)',
      )
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
