// One SmsProvider per sms_devices row: the real SMS Gate adapter for provider=smsgate, and an in-process simulator device
// for provider=sim (its signed webhooks are fed straight back into the webhook handler, so every verification and
// persistence step runs exactly as it does for the tablet).
import type { Clock } from '../../platform/clock.js'
import type { SmsProvider } from '../../integrations/ports/sms.js'
import { SimulatorProvider } from '../../integrations/sms/simulator.js'
import { smsGateConfig } from '../../integrations/smsgate/config.js'
import type { SimDelivery } from '../../integrations/smsgate/sim-device.js'
import { SmsGateProvider } from '../../integrations/smsgate/provider.js'
import type { MessagingConfig } from './config.js'
import type { DeviceRow, DeviceSecrets } from './db/devices.js'

export interface ProviderRegistryOptions {
  config: MessagingConfig
  clock: Clock
  secrets: (row: DeviceRow) => DeviceSecrets
  /** Receives every webhook a simulated device emits. */
  onSimDelivery: (device: DeviceRow, delivery: SimDelivery) => void
  /** Replaces provider construction (tests, spikes). */
  override?: (row: DeviceRow, secrets: DeviceSecrets) => SmsProvider | undefined
  simAutoProgress?: 'instant' | 'manual'
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

interface Cached {
  provider: SmsProvider
  stamp: number
}

export class ProviderRegistry {
  private readonly cache = new Map<string, Cached>()

  constructor(private readonly o: ProviderRegistryOptions) {}

  forDevice(row: DeviceRow): SmsProvider {
    const stamp = row.updated_at.getTime()
    const hit = this.cache.get(row.id)
    if (hit && (row.provider === 'sim' || hit.stamp === stamp)) return hit.provider
    const secrets = this.o.secrets(row)
    const provider = this.o.override?.(row, secrets) ?? this.build(row, secrets)
    this.cache.set(row.id, { provider, stamp })
    return provider
  }

  /** The in-process simulator behind a provider=sim device (control: inject inbound, fail, outage), when there is one. */
  sim(row: DeviceRow): SimulatorProvider | undefined {
    const p = this.forDevice(row)
    return p instanceof SimulatorProvider ? p : undefined
  }

  forget(deviceId: string): void {
    this.cache.delete(deviceId)
  }

  private build(row: DeviceRow, secrets: DeviceSecrets): SmsProvider {
    const { env } = this.o.config
    if (row.provider === 'sim') {
      const sim = new SimulatorProvider({
        clock: this.o.clock,
        signingKey: secrets.webhookSecret,
        autoProgress: this.o.simAutoProgress ?? 'instant',
        toleranceSec: this.o.config.webhookToleranceSec,
        onWebhook: (d) => this.o.onSimDelivery(row, d),
      })
      // The simulated device only emits to registered webhooks; register the local route once.
      void sim.registerWebhooks(`http://sim.invalid/hooks/smsgate/${row.device_key}`, secrets.webhookSecret)
      return sim
    }
    return new SmsGateProvider(
      smsGateConfig({
        baseUrl: row.base_url!,
        username: row.username!,
        password: secrets.password!,
        webhookSecret: secrets.webhookSecret,
        messagesPath: env.SMSGATE_API_PATH,
        timeoutMs: env.SMSGATE_TIMEOUT_MS,
        webhookToleranceSec: env.SMSGATE_WEBHOOK_TOLERANCE_SECONDS,
        resendAttempts: env.SMSGATE_RESEND_ATTEMPTS,
        legacyMessageField: env.SMSGATE_LEGACY_MESSAGE_FIELD,
        syncSigningKey: env.SMSGATE_SYNC_SIGNING_KEY,
        allowInsecureWebhookUrl: env.SMSGATE_ALLOW_INSECURE_WEBHOOK_URL,
        ...((row.sim_slot_default ?? env.SMSGATE_SIM_NUMBER)
          ? { defaultSimNumber: (row.sim_slot_default ?? env.SMSGATE_SIM_NUMBER)! }
          : {}),
      }),
      { clock: this.o.clock, ...(this.o.fetch ? { fetch: this.o.fetch } : {}) },
    )
  }
}
