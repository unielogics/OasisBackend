import { SimulatorProvider } from '../../src/integrations/sms/simulator.js'
import { FixedClock } from '../../src/platform/clock.js'
import {
  defaultDispatcherConfig,
  DeviceHealthMonitor,
  Dispatcher,
  InMemoryDeviceRepository,
  InMemoryOutboxRepository,
  InMemoryProcessedEvents,
  SmsEventIngestor,
  type DispatcherConfig,
  type HealthConfig,
  DEFAULT_HEALTH,
} from '../../src/modules/messaging/dispatch/index.js'
import type { SmsRecipient } from '../../src/modules/messaging/policy/canSend.js'

export const NOON = '2026-06-13T12:00:00-04:00'
export const DEVICE = 'dev-1'

export function recipient(n: number | string = 1, over: Partial<SmsRecipient> = {}): SmsRecipient {
  const digits = String(n).padStart(4, '0')
  return { kind: 'customer', id: `c${n}`, phone: `+1786555${digits}`, smsOptIn: true, activeOptOut: false, synthetic: false, consentSource: 'web_form', ...over }
}

export interface HarnessOptions {
  start?: string
  config?: Partial<DispatcherConfig>
  health?: Partial<HealthConfig>
  autoProgress?: 'instant' | 'manual'
}

export function harness(opts: HarnessOptions = {}) {
  const clock = new FixedClock(opts.start ?? NOON)
  const provider = new SimulatorProvider({ clock, autoProgress: opts.autoProgress ?? 'manual', signingKey: 'k' })
  const outbox = new InMemoryOutboxRepository()
  const devices = new InMemoryDeviceRepository()
  // Silence thresholds are huge by default so tests that jump the clock do not need a heartbeat; health tests override them.
  const monitor = new DeviceHealthMonitor(devices, clock, { ...DEFAULT_HEALTH, onlineWithinMs: 1e12, offlineAfterMs: 1e12, ...opts.health })
  const config = defaultDispatcherConfig({ deviceId: DEVICE, minIntervalMs: 0, maxPerTick: 100, ...opts.config })
  const dispatcher = new Dispatcher(provider, outbox, monitor, clock, config)
  const processed = new InMemoryProcessedEvents()
  const received: unknown[] = []
  const ingestor = new SmsEventIngestor(processed, dispatcher, clock, async (e) => {
    received.push(e)
  })
  return { clock, provider, outbox, devices, monitor, dispatcher, processed, ingestor, received, config }
}

export type Harness = ReturnType<typeof harness>

export async function enqueue(h: Harness, id: string, klass: Parameters<Harness['dispatcher']['enqueue']>[0]['klass'], text = 'hello', who: number | string = id) {
  const r = await h.dispatcher.enqueue({ messageId: id, klass, text, recipient: recipient(typeof who === 'number' ? who : Math.abs(hash(who))) })
  if (r.status !== 'queued' && r.status !== 'held') throw new Error(`enqueue ${id}: ${r.status}`)
  return r
}

function hash(s: string): number {
  let n = 0
  for (const ch of s) n = (n * 31 + ch.charCodeAt(0)) % 9000
  return n + 1000
}
