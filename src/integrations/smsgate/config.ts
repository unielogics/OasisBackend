import { z } from 'zod'
import type { SmsPriority } from '../ports/sms.js'

export type PriorityMap = Record<SmsPriority, number>

export interface SmsGateConfig {
  /** Device local server, e.g. http://100.64.0.7:8080 (tailnet IP; WireGuard encrypts the hop). */
  baseUrl: string
  username: string
  password: string
  /** HMAC key shared with the app (Settings > Webhooks > Signing key). */
  webhookSecret: string
  /** Newer app builds serve /messages; older ones only /message. Both are accepted by the 1.77 app. */
  messagesPath: string
  webhooksPath: string
  healthPath: string
  settingsPath: string
  timeoutMs: number
  /** Accepted webhook clock skew. The device retries up to ~14 times over about two days, so the default is 24 h. */
  webhookToleranceSec: number
  /** Re-POST attempts after an ambiguous failure when the device reports the id as unknown. */
  resendAttempts: number
  resendDelayMs: number
  /** Send `message` (deprecated) instead of `textMessage` for very old app builds. */
  legacyMessageField: boolean
  /** Maps our lane (0..3) to the device `priority` (a byte). Values of 100 and above bypass the device's own limits. */
  priorityMap: PriorityMap
  defaultSimNumber?: number
  /** Push the signing key to the device through PATCH /settings during registerWebhooks. */
  syncSigningKey: boolean
  /** Allow http:// webhook targets (only the app's "insecure" build accepts them). */
  allowInsecureWebhookUrl: boolean
  webhookIdPrefix: string
}

export const DEFAULT_PRIORITY_MAP: PriorityMap = { 0: 50, 1: 0, 2: 0, 3: -50 }

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

const envSchema = z.object({
  SMSGATE_DEVICE_URL: z.string().url(),
  SMSGATE_USERNAME: z.string().min(1),
  SMSGATE_PASSWORD: z.string().min(1),
  SMSGATE_WEBHOOK_SECRET: z.string().min(1),
  SMSGATE_API_PATH: z.string().default('/messages'),
  SMSGATE_TIMEOUT_MS: z.coerce.number().int().min(500).default(10_000),
  SMSGATE_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().min(30).default(86_400),
  SMSGATE_RESEND_ATTEMPTS: z.coerce.number().int().min(0).max(3).default(1),
  SMSGATE_SIM_NUMBER: z.coerce.number().int().min(1).max(3).optional(),
  SMSGATE_LEGACY_MESSAGE_FIELD: bool.default('false'),
  SMSGATE_SYNC_SIGNING_KEY: bool.default('false'),
  SMSGATE_ALLOW_INSECURE_WEBHOOK_URL: bool.default('false'),
})

export function smsGateConfigFromEnv(source: Record<string, string | undefined> = process.env): SmsGateConfig {
  const e = envSchema.parse(source)
  return {
    baseUrl: e.SMSGATE_DEVICE_URL.replace(/\/+$/, ''),
    username: e.SMSGATE_USERNAME,
    password: e.SMSGATE_PASSWORD,
    webhookSecret: e.SMSGATE_WEBHOOK_SECRET,
    messagesPath: e.SMSGATE_API_PATH,
    webhooksPath: '/webhooks',
    healthPath: '/health',
    settingsPath: '/settings',
    timeoutMs: e.SMSGATE_TIMEOUT_MS,
    webhookToleranceSec: e.SMSGATE_WEBHOOK_TOLERANCE_SECONDS,
    resendAttempts: e.SMSGATE_RESEND_ATTEMPTS,
    resendDelayMs: 1000,
    legacyMessageField: e.SMSGATE_LEGACY_MESSAGE_FIELD,
    priorityMap: DEFAULT_PRIORITY_MAP,
    defaultSimNumber: e.SMSGATE_SIM_NUMBER,
    syncSigningKey: e.SMSGATE_SYNC_SIGNING_KEY,
    allowInsecureWebhookUrl: e.SMSGATE_ALLOW_INSECURE_WEBHOOK_URL,
    webhookIdPrefix: 'oasis-',
  }
}

export function smsGateConfig(partial: Pick<SmsGateConfig, 'baseUrl' | 'username' | 'password' | 'webhookSecret'> & Partial<SmsGateConfig>): SmsGateConfig {
  return {
    messagesPath: '/messages',
    webhooksPath: '/webhooks',
    healthPath: '/health',
    settingsPath: '/settings',
    timeoutMs: 10_000,
    webhookToleranceSec: 86_400,
    resendAttempts: 1,
    resendDelayMs: 1000,
    legacyMessageField: false,
    priorityMap: DEFAULT_PRIORITY_MAP,
    syncSigningKey: false,
    allowInsecureWebhookUrl: false,
    webhookIdPrefix: 'oasis-',
    ...partial,
    baseUrl: partial.baseUrl.replace(/\/+$/, ''),
  }
}
