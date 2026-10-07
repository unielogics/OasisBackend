// Route-module entry point of the Operations vertical. The ports default to in-memory implementations (invoices,
// outbound messages, memberships, external alerts) so the module runs on its own; the payments, messaging and
// memberships verticals plug the real ones in through createSchedulingModule({ ... }).
import type { AppDeps } from '../../app.js'
import type { ApiModule } from '../../http/modules.js'
import type { AppInstance } from '../../http/types.js'
import type { StorageProvider } from '../../integrations/ports/storage.js'
import { createStorageProvider } from '../../integrations/storage/config.js'
import { createIdGenerator } from '../../platform/ids.js'
import { registerAppointmentRoutes } from './http/appointment-routes.js'
import { registerOpsRoutes } from './http/ops-routes.js'
import { registerPolicyRoutes } from './http/policy-routes.js'
import { createDbDepositSettlement } from './settlement.js'
import {
  InMemoryInvoiceGateway,
  InMemoryMessageQueue,
  noExternalAlerts,
  noMemberships,
  type SchedulingPorts,
} from './ports.js'

/** A StorageProvider that is built on first use, so registering routes never needs storage credentials. */
function lazyStorage(deps: AppDeps): StorageProvider {
  let inner: StorageProvider | undefined
  const get = (): StorageProvider => (inner ??= createStorageProvider(deps.env, { clock: deps.clock }))
  return {
    createUpload: (p) => get().createUpload(p),
    head: (k) => get().head(k),
    getDownloadUrl: (k, ttl) => get().getDownloadUrl(k, ttl),
    delete: (k) => get().delete(k),
  }
}

export function resolvePorts(deps: AppDeps, given: Partial<SchedulingPorts> = {}): SchedulingPorts {
  return {
    invoices: given.invoices ?? new InMemoryInvoiceGateway(),
    messages: given.messages ?? new InMemoryMessageQueue(),
    memberships: given.memberships ?? noMemberships,
    externalAlerts: given.externalAlerts ?? noExternalAlerts,
    revenue: given.revenue,
    storage: given.storage ?? lazyStorage(deps),
    // Cancel and no-show settle the money held through the payments commands. Against a database without that invoice (the
    // in-memory gateway) the settlement finds nothing to do.
    deposits:
      given.deposits ??
      createDbDepositSettlement({ clock: deps.clock, newId: deps.newId ?? createIdGenerator(deps.clock) }),
  }
}

export function registerSchedulingRoutes(app: AppInstance, ports: SchedulingPorts): void {
  registerOpsRoutes(app, ports)
  registerAppointmentRoutes(app, ports)
  registerPolicyRoutes(app)
}

export function createSchedulingModule(given: Partial<SchedulingPorts> = {}): ApiModule {
  return (app, deps) => {
    const ports = resolvePorts(deps, given)
    if (deps.env.NODE_ENV === 'production') {
      if (!given.invoices) app.log.warn('scheduling: no InvoiceGateway wired, invoices are held in memory')
      if (!given.messages)
        app.log.warn('scheduling: no MessageQueue wired, outbound SMS are only recorded in memory')
    }
    registerSchedulingRoutes(app, ports)
  }
}

export const schedulingModule: ApiModule = createSchedulingModule()
