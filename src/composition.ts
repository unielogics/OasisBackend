// Production wiring that connects modules built independently of each other. src/server.ts and the composition test
// both call this, so the test exercises exactly what runs in production.
import type { AppDeps } from './app.js'
import type { StorageProvider } from './integrations/ports/storage.js'
import { messagingAlertSource } from './modules/messaging/adapters/alerts.js'
import { createDbPaymentOutbox } from './modules/messaging/adapters/payments.js'
import { MessagingClosureNotifier, MessagingEmergencyNotifier } from './modules/messaging/adapters/settings.js'
import { MessagingRuntime, runtimeFor, type LoggerLike } from './modules/messaging/runtime.js'
import { createGatewayFor } from './modules/payments/module.js'
import { createPaymentMessenger } from './modules/payments/messenger.js'
import { ledgerRevenueSource } from './modules/payments/revenue.js'
import { noMemberships, type SchedulingPorts } from './modules/scheduling/ports.js'
import { syncChecklistTemplate } from './modules/scheduling/checklist-sync.js'
import { ActivityClosureNotifier, ActivityEmergencyNotifier } from './modules/settings/db-adapters/index.js'
import { configureSettings } from './modules/settings/http/runtime.js'
import type { Clock } from './platform/clock.js'
import { createIdGenerator, type NewId } from './platform/ids.js'
import type { Db } from './platform/db.js'

type MessagingDeps = Pick<AppDeps, 'db' | 'clock' | 'env'> & { newId?: NewId }

const unusedStorage = (): StorageProvider => ({
  createUpload: () => Promise.reject(new Error('storage is not used by the messaging module')),
  head: () => Promise.reject(new Error('storage is not used by the messaging module')),
  getDownloadUrl: () => Promise.reject(new Error('storage is not used by the messaging module')),
  delete: () => Promise.reject(new Error('storage is not used by the messaging module')),
})

/**
 * The scheduling ports a customer's SMS reply is confirmed through (the real invoice gateway and the messaging queue);
 * storage is never touched by a confirm.
 */
export function schedulingPortsFor(deps: MessagingDeps, rt: MessagingRuntime): SchedulingPorts {
  return {
    invoices: createGatewayFor({ clock: deps.clock, newId: deps.newId ?? createIdGenerator(deps.clock) }),
    messages: rt.queue,
    memberships: noMemberships,
    externalAlerts: messagingAlertSource,
    revenue: ledgerRevenueSource,
    storage: unusedStorage(),
  }
}

/** The messaging runtime of this process, keyed by the Env object so every module (and the hooks listener) shares one. */
export function messagingRuntimeFor(deps: MessagingDeps & object, o: { logger?: LoggerLike; key?: object } = {}): MessagingRuntime {
  const newId = deps.newId ?? createIdGenerator(deps.clock)
  const self: { rt?: MessagingRuntime } = {}
  const rt = runtimeFor(
    {
      db: deps.db as Db,
      clock: deps.clock,
      newId,
      env: deps.env,
      ...(o.logger ? { logger: o.logger } : {}),
      schedulingPorts: () => schedulingPortsFor(deps, self.rt!),
    },
    o.key ?? deps.env,
  )
  self.rt = rt
  return rt
}

export interface ProductionSettingsDeps {
  clock: Clock
  newId: NewId
  /** With the messaging runtime, closure notices and the emergency fan-out are really queued as SMS or email. */
  messaging?: MessagingRuntime
}

export function configureProductionSettings(deps: ProductionSettingsDeps): void {
  const rt = deps.messaging
  configureSettings({
    // Without messaging the notices only leave an activity-log line and an audit row.
    closureNotifier: (locationId) => (rt ? new MessagingClosureNotifier(rt, locationId) : new ActivityClosureNotifier(locationId)),
    emergencyNotifier: rt ? new MessagingEmergencyNotifier(rt) : new ActivityEmergencyNotifier(),
    // A checklist template edit reaches the jobs that have not started (stable task ids; cleaning/completed are untouched).
    checklistSync: async (tx, ch) => {
      await syncChecklistTemplate(
        tx,
        { clock: deps.clock, newId: deps.newId, locationId: ch.locationId },
        { service: ch.service, plan: ch.plan },
      )
    },
  })
}

/** The payment messenger over the messaging queue: receipts and payment links really go out. */
export function paymentMessengerFor(rt: MessagingRuntime): ReturnType<typeof createPaymentMessenger> {
  return createPaymentMessenger(createDbPaymentOutbox(rt))
}
