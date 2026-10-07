import { z } from 'zod'
import type { BudgetConfig } from './budget.js'
import { defaultDispatcherConfig, type DispatcherConfig } from './dispatcher.js'
import { DEFAULT_HEALTH, type HealthConfig } from './health.js'
import { DEFAULT_QUIET_HOURS, type QuietHoursConfig } from '../policy/quietHours.js'

// Maps the environment contract to dispatcher settings. The first four variables already exist in src/config/env.ts;
// the rest are new and all optional.

const hhmm = /^([01]?\d|2[0-3]):([0-5]\d)$/

export function parseQuietHours(value: string | undefined, timeZone: string): QuietHoursConfig {
  const v = (value ?? '').trim().toLowerCase()
  if (v === '') return { ...DEFAULT_QUIET_HOURS, timeZone }
  if (v === 'off' || v === 'none' || v === 'false')
    return { ...DEFAULT_QUIET_HOURS, enabled: false, timeZone }
  const [from, to] = v.split('-').map((s) => s.trim())
  const a = hhmm.exec(from ?? '')
  const b = hhmm.exec(to ?? '')
  if (!a || !b) throw new Error(`SMS_QUIET_HOURS must look like 21:00-08:00 or "off", got "${value}"`)
  return {
    enabled: true,
    startMinute: Number(a[1]) * 60 + Number(a[2]),
    endMinute: Number(b[1]) * 60 + Number(b[2]),
    timeZone,
  }
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BUSINESS_TZ: z.string().default('America/New_York'),
  SMS_ALLOWLIST: z.string().default(''),
  SMS_QUIET_HOURS: z.string().optional(),
  SMSGATE_MAX_PER_WINDOW: z.coerce.number().int().positive().default(30),
  SMSGATE_WINDOW_MINUTES: z.coerce.number().int().positive().default(30),
  SMSGATE_RESERVED_P0: z.coerce.number().int().min(0).default(6),
  SMSGATE_SAFETY_MARGIN: z.coerce.number().int().min(0).default(0),
  SMSGATE_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(3000),
  SMSGATE_MAX_SEGMENTS: z.coerce.number().int().min(1).default(8),
  SMSGATE_HEARTBEAT_STALE_SECONDS: z.coerce.number().int().min(60).default(600),
  SMSGATE_ONLINE_WITHIN_SECONDS: z.coerce.number().int().min(30).default(180),
  SMSGATE_SIM_NUMBER: z.coerce.number().int().min(1).max(3).optional(),
})

export type DispatchEnvValues = z.infer<typeof schema>

/** Settings of the dispatcher and the health monitor from already parsed values (the app's Env has the same fields). */
export function dispatcherConfigFromValues(
  deviceId: string,
  e: DispatchEnvValues,
  device: {
    minIntervalMs?: number | null
    maxPerWindow?: number | null
    windowMinutes?: number | null
    simSlot?: number | null
  } = {},
): { dispatcher: DispatcherConfig; health: HealthConfig } {
  const maxPerWindow = device.maxPerWindow ?? e.SMSGATE_MAX_PER_WINDOW
  const budget: BudgetConfig = {
    maxPerWindow,
    windowMs: (device.windowMinutes ?? e.SMSGATE_WINDOW_MINUTES) * 60_000,
    reservedForP0: Math.min(e.SMSGATE_RESERVED_P0, Math.max(0, maxPerWindow - 1)),
    safetyMargin: e.SMSGATE_SAFETY_MARGIN,
  }
  const allowlist = e.SMS_ALLOWLIST.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    dispatcher: defaultDispatcherConfig({
      deviceId,
      budget,
      minIntervalMs: device.minIntervalMs ?? e.SMSGATE_MIN_INTERVAL_MS,
      maxSegments: e.SMSGATE_MAX_SEGMENTS,
      simSlot: device.simSlot ?? e.SMSGATE_SIM_NUMBER,
      quietHours: parseQuietHours(e.SMS_QUIET_HOURS, e.BUSINESS_TZ),
      environment: e.NODE_ENV,
      allowlist,
    }),
    health: {
      ...DEFAULT_HEALTH,
      offlineAfterMs: e.SMSGATE_HEARTBEAT_STALE_SECONDS * 1000,
      onlineWithinMs: e.SMSGATE_ONLINE_WITHIN_SECONDS * 1000,
    },
  }
}

export function dispatcherConfigFromEnv(
  deviceId: string,
  source: Record<string, string | undefined> = process.env,
): { dispatcher: DispatcherConfig; health: HealthConfig } {
  return dispatcherConfigFromValues(deviceId, schema.parse(source))
}
