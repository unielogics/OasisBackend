import { z } from 'zod'

/**
 * Square settings (ADR 0171, docs/integrations/square.md section 2). The shape is merged into the shared environment contract
 * (src/config/env.ts, `...squareEnvShape`) and its cross-field rules run in the contract's superRefine (`squareEnvIssues`), so there
 * is one definition of each variable. Everything is off by default: `SQUARE_PROVIDER=sim` talks to the in-process simulator only,
 * `SQUARE_WRITES_ENABLED=false` (observe-only), `PAYMENT_PROCESSOR=squarespace`, `SQUARE_POS_API_ENABLED=false`.
 */
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')
const optional = <T extends z.ZodTypeAny>(t: T) => z.preprocess((v) => (v === '' ? undefined : v), t.optional())

/** The Square API version every request pins (Square-Version header). Changing it is a reviewed change (ADR 0171). */
export const SQUARE_API_VERSION = '2026-09-16'

export const SQUARE_BASE_URLS = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
} as const

/** The simulator's location and merchant when nothing is configured (SQUARE_PROVIDER=sim). */
export const SIM_LOCATION_ID = 'LSIMOASIS0001'
export const SIM_MERCHANT_ID = 'MSIMOASIS0001'
export const SIM_ACCESS_TOKEN = 'sim-square-access-token'

export const squareEnvShape = {
  /** sim: the in-process simulator, nothing leaves the process. live: Square (or SQUARE_API_BASE). */
  SQUARE_PROVIDER: z.enum(['sim', 'live']).default('sim'),
  SQUARE_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  SQUARE_APPLICATION_ID: optional(z.string().min(1)),
  /** Personal access token (or OAuth token) of the merchant. Secret: only in the Secrets Manager secret. */
  SQUARE_ACCESS_TOKEN: optional(z.string().min(8)),
  SQUARE_LOCATION_ID: optional(z.string().min(1)),
  /** Signature key of our webhook subscription, and the previous one during a rotation. Secrets. */
  SQUARE_WEBHOOK_SIGNATURE_KEY: optional(z.string().min(8)),
  SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS: optional(z.string().min(8)),
  /** The exact URL registered with Square (https://<domain>/hooks/square): part of every signature, never taken from a request. */
  SQUARE_WEBHOOK_URL: optional(z.string().url()),
  SQUARE_API_VERSION: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').default(SQUARE_API_VERSION),
  /** Overrides the API host (a `pnpm sim:square` simulator). Unset: by SQUARE_ENVIRONMENT. */
  SQUARE_API_BASE: optional(z.string().url()),
  SQUARE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
  SQUARE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(8).default(4),
  /** false = observe-only: webhooks, catch-up, mirror and matching; no call that changes anything at Square (ADR 0171 D11). */
  SQUARE_WRITES_ENABLED: bool.default('false'),
  /**
   * Memberships billed by Square, the last stage of turning writes on (plan rollout 4, ADR 0171 wave Q3b): the tier prices are synced
   * to Square's catalog and the membership page can join with a card. Needs SQUARE_WRITES_ENABLED; off by default.
   */
  SQUARE_MEMBERSHIPS_ENABLED: bool.default('false'),
  /** The Point of Sale app switch from the dashboard (iPad). Production only. */
  SQUARE_POS_API_ENABLED: bool.default('false'),
  /** Seconds a counter payment waits before auto-matching (a subscription event or a POS callback may explain it first). */
  SQUARE_MATCH_DELAY_SECONDS: z.coerce.number().int().min(0).max(3600).default(90),
  /**
   * Counter (POS) payments are recorded automatically only on strong evidence (plan decision 5): `evidence` (the default) needs the
   * invoice number in the note, a POS intent, a staff "Square reader" entry of that amount, or one open invoice of that balance backed
   * by the client's identity. `amount` also records a payment whose amount alone matches exactly one open invoice of the day (owner's
   * choice; off by default).
   */
  SQUARE_POS_AUTOMATCH: z.enum(['evidence', 'amount']).default('evidence'),
  /** Which processor new links, cards, memberships and refunds use: the cutover switch (ADR 0171 D11). */
  PAYMENT_PROCESSOR: z.enum(['squarespace', 'square']).default('squarespace'),
}

export const squareEnvSchema = z.object(squareEnvShape)
export type SquareEnv = z.infer<typeof squareEnvSchema>

type IssueSink = (cond: boolean, path: string, message: string) => void

/**
 * The cross-field rules, run by the environment contract's superRefine:
 * - live requires the token, location, application id, webhook signature key and webhook URL;
 * - production with PAYMENT_PROCESSOR=square requires SQUARE_PROVIDER=live, SQUARE_ENVIRONMENT=production and no SQUARE_API_BASE
 *   other than Square's production host (real clients never see a sandbox or simulator checkout; review Q4 SQ-SEM-3);
 * - the POS app switch only with the production environment, live;
 * - in production the webhook URL is https and ends in /hooks/square.
 */
export function squareEnvIssues(e: SquareEnv & { NODE_ENV: string }, need: IssueSink): void {
  if (e.SQUARE_PROVIDER === 'live') {
    for (const k of [
      'SQUARE_ACCESS_TOKEN',
      'SQUARE_LOCATION_ID',
      'SQUARE_APPLICATION_ID',
      'SQUARE_WEBHOOK_SIGNATURE_KEY',
      'SQUARE_WEBHOOK_URL',
    ] as const)
      need(!e[k], k, 'required when SQUARE_PROVIDER=live')
  }
  const prod = e.NODE_ENV === 'production'
  need(
    prod && e.PAYMENT_PROCESSOR === 'square' && e.SQUARE_PROVIDER !== 'live',
    'SQUARE_PROVIDER',
    'must be live in production when PAYMENT_PROCESSOR=square',
  )
  need(
    prod && e.PAYMENT_PROCESSOR === 'square' && e.SQUARE_ENVIRONMENT !== 'production',
    'SQUARE_ENVIRONMENT',
    'must be production in production when PAYMENT_PROCESSOR=square (real clients never see a sandbox checkout)',
  )
  need(
    prod && e.PAYMENT_PROCESSOR === 'square' && !!e.SQUARE_API_BASE && e.SQUARE_API_BASE.replace(/\/+$/, '') !== SQUARE_BASE_URLS.production,
    'SQUARE_API_BASE',
    `must be unset (or ${SQUARE_BASE_URLS.production}) in production when PAYMENT_PROCESSOR=square (never a sandbox or a simulator)`,
  )
  need(
    e.SQUARE_POS_API_ENABLED && (e.SQUARE_ENVIRONMENT !== 'production' || e.SQUARE_PROVIDER !== 'live'),
    'SQUARE_POS_API_ENABLED',
    'only with SQUARE_PROVIDER=live and SQUARE_ENVIRONMENT=production (the Point of Sale API has no sandbox)',
  )
  need(
    prod && !!e.SQUARE_WEBHOOK_URL && !/^https:\/\/[^/]+\/hooks\/square$/.test(e.SQUARE_WEBHOOK_URL),
    'SQUARE_WEBHOOK_URL',
    'must be https://<domain>/hooks/square in production (the exact URL registered with Square)',
  )
  need(
    !!e.SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS && !e.SQUARE_WEBHOOK_SIGNATURE_KEY,
    'SQUARE_WEBHOOK_SIGNATURE_KEY',
    'set the current key too: the previous one is only accepted during a rotation',
  )
}

/** The API origin for an environment (no /v2): SQUARE_API_BASE when set, else Square's host for SQUARE_ENVIRONMENT. */
export function squareBaseUrl(e: Pick<SquareEnv, 'SQUARE_API_BASE' | 'SQUARE_ENVIRONMENT'>): string {
  return (e.SQUARE_API_BASE ?? SQUARE_BASE_URLS[e.SQUARE_ENVIRONMENT]).replace(/\/+$/, '')
}

/** Live and nothing the client needs is missing (the jobs that call Square run only then). */
export function squareLiveConfigured(e: SquareEnv): boolean {
  return e.SQUARE_PROVIDER === 'live' && !!e.SQUARE_ACCESS_TOKEN && !!e.SQUARE_LOCATION_ID
}

/** The Square location the integration works for: SQUARE_LOCATION_ID, or the simulator's in sim mode. */
export function squareLocationId(e: SquareEnv): string | undefined {
  return e.SQUARE_LOCATION_ID ?? (e.SQUARE_PROVIDER === 'sim' ? SIM_LOCATION_ID : undefined)
}
