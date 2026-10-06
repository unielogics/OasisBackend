import { z } from 'zod'

/**
 * Squarespace settings parsed from an env-like record. Kept here (not in src/config/env.ts, which the integrator owns)
 * so the adapter is testable on its own. SQSP_PROVIDER / SQSP_API_BASE / SQSP_API_KEY / SQSP_POLL_INTERVAL_SECONDS
 * already exist in the shared env contract; the rest are new (see docs/integrations/squarespace.md).
 */
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

export const squarespaceEnvSchema = z.object({
  SQSP_PROVIDER: z.enum(['sim', 'live']).default('sim'),
  SQSP_API_BASE: z.string().url().default('https://api.squarespace.com'),
  SQSP_API_KEY: z.string().min(1).optional(),
  SQSP_USER_AGENT: z.string().min(1).default('OasisAutoSpa-Sync/1.0'),
  SQSP_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(120),
  SQSP_OVERLAP_SECONDS: z.coerce.number().int().min(0).default(300),
  SQSP_RECONCILE_DAYS: z.coerce.number().int().min(1).max(365).default(45),
  SQSP_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(300).default(240),
  SQSP_MAX_REQUESTS_PER_RUN: z.coerce.number().int().min(1).default(120),
  SQSP_INCLUDE_TEST_ORDERS: bool.default('false'),
  SQSP_MEMBERSHIP_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(7),
  SQSP_MATCH_CONFIDENCE_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.8),
  SQSP_VARIANCE_ALERT_CENTS: z.coerce.number().int().min(0).default(100),
  SQSP_LINK_WINDOW_DAYS: z.coerce.number().int().min(1).max(60).default(14),
  SQSP_LINK_AMOUNT_TOLERANCE_CENTS: z.coerce.number().int().min(0).default(1),
  SQSP_PRODUCT_MAP: z.string().optional(),
  SQSP_WEBHOOK_SECRET: z
    .string()
    .regex(/^([0-9a-fA-F]{2})+$/, 'hex string')
    .optional(),
})

export type SquarespaceEnv = z.infer<typeof squarespaceEnvSchema>

export function loadSquarespaceEnv(env: Record<string, string | undefined>): SquarespaceEnv {
  const parsed = squarespaceEnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(
      `invalid Squarespace configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  }
  if (parsed.data.SQSP_PROVIDER === 'live' && !parsed.data.SQSP_API_KEY) {
    throw new Error('invalid Squarespace configuration: SQSP_API_KEY: required when SQSP_PROVIDER=live')
  }
  return parsed.data
}
