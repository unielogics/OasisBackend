import type { Env } from '../../config/env.js'
import { dispatcherConfigFromValues, type DispatchEnvValues } from './dispatch/config.js'
import type { DispatcherConfig } from './dispatch/dispatcher.js'
import type { PlanConfig } from './dispatch/enqueue.js'
import type { HealthConfig } from './dispatch/health.js'

export interface DeviceTuning {
  id: string
  simSlotDefault: number | null
  minIntervalMs: number | null
  maxPerWindow: number | null
  windowMinutes: number | null
}

/** Everything the messaging runtime reads from the environment, in one place. */
export interface MessagingConfig {
  env: Env
  tz: string
  /** RESCHEDULE_LINK_ENABLED: {link} sentences survive in templates only when true. */
  linksEnabled: boolean
  businessPhone?: string
  /** Where the tablet reaches the hooks listener, without the device key (SMSGATE_WEBHOOK_PUBLIC_URL). */
  webhookPublicUrl?: string
  webhookToleranceSec: number
  tickIntervalMs: number
  /** The policy half of the dispatcher settings, for code that enqueues without a device in hand. */
  plan: PlanConfig
  dispatch(device: DeviceTuning): { dispatcher: DispatcherConfig; health: HealthConfig }
}

export function messagingConfig(env: Env): MessagingConfig {
  const base = dispatcherConfigFromValues('', env as DispatchEnvValues)
  return {
    env,
    tz: env.BUSINESS_TZ,
    linksEnabled: env.RESCHEDULE_LINK_ENABLED,
    ...(env.BUSINESS_PHONE ? { businessPhone: env.BUSINESS_PHONE } : {}),
    ...(env.SMSGATE_WEBHOOK_PUBLIC_URL
      ? { webhookPublicUrl: env.SMSGATE_WEBHOOK_PUBLIC_URL.replace(/\/+$/, '') }
      : {}),
    webhookToleranceSec: env.SMSGATE_WEBHOOK_TOLERANCE_SECONDS,
    tickIntervalMs: env.SMS_TICK_INTERVAL_MS,
    plan: {
      deviceId: null,
      maxSegments: base.dispatcher.maxSegments,
      simSlot: base.dispatcher.simSlot,
      quietHours: base.dispatcher.quietHours,
      environment: base.dispatcher.environment,
      allowlist: base.dispatcher.allowlist,
    },
    dispatch: (d) =>
      dispatcherConfigFromValues(d.id, env as DispatchEnvValues, {
        minIntervalMs: d.minIntervalMs,
        maxPerWindow: d.maxPerWindow,
        windowMinutes: d.windowMinutes,
        simSlot: d.simSlotDefault,
      }),
  }
}
