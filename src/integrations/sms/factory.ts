import { systemClock, type Clock } from '../../platform/clock.js'
import type { SmsProvider } from '../ports/sms.js'
import { smsGateConfigFromEnv } from '../smsgate/config.js'
import { SmsGateProvider } from '../smsgate/provider.js'
import { SimulatorProvider } from './simulator.js'

/**
 * SMS_PROVIDER=sim builds the in-process simulator (no other variable needed); SMS_PROVIDER=smsgate builds the real
 * adapter and needs SMSGATE_DEVICE_URL, SMSGATE_USERNAME, SMSGATE_PASSWORD and SMSGATE_WEBHOOK_SECRET.
 */
export function createSmsProvider(env: Record<string, string | undefined> = process.env, clock: Clock = systemClock): SmsProvider {
  const kind = env.SMS_PROVIDER ?? 'sim'
  if (kind === 'sim') return new SimulatorProvider({ clock, signingKey: env.SMSGATE_WEBHOOK_SECRET ?? 'sim-signing-key', autoProgress: 'instant' })
  if (kind === 'smsgate') return new SmsGateProvider(smsGateConfigFromEnv(env), { clock })
  throw new Error(`Unknown SMS_PROVIDER "${kind}" (expected sim or smsgate)`)
}
