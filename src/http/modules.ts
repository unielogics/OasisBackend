// Registry of API modules. A vertical adds one import and one entry here; its routes are mounted under /api/v1 and
// every route must declare config.access (see ./access.ts). Webhook modules are mounted under /hooks.
import type { AppDeps } from '../app.js'
import { messagingAlertSource } from '../modules/messaging/adapters/alerts.js'
import { createMessagingModule } from '../modules/messaging/http/module.js'
import { messagingRuntimeFor, productionPaymentsPorts } from '../composition.js'
import { authModule, peopleModule } from '../modules/auth/module.js'
import { customersModule } from '../modules/customers/http/module.js'
import { paymentsModule, createGatewayFor } from '../modules/payments/module.js'
import { ledgerRevenueSource } from '../modules/payments/revenue.js'
import { createSchedulingModule } from '../modules/scheduling/module.js'
import { settingsModule } from '../modules/settings/http/module.js'
import type { AppInstance } from './types.js'

export type ApiModule = (app: AppInstance, deps: AppDeps) => void | Promise<void>

const runtimeOf = (deps: AppDeps): ReturnType<typeof messagingRuntimeFor> => messagingRuntimeFor(deps)

/**
 * Scheduling composed with the real invoice gateway (payments), cash-basis revenue from the ledger, the messaging
 * outbox (every notification is queued as an SMS) and the messaging alerts (new reply, device down).
 */
const schedulingModule: ApiModule = (app, deps) =>
  createSchedulingModule({
    invoices: createGatewayFor(deps),
    revenue: ledgerRevenueSource,
    messages: runtimeOf(deps).queue,
    externalAlerts: messagingAlertSource,
  })(app, deps)

/** Payments; receipts and payment links go through the messaging queue once configureProductionPayments ran (server.ts). */
const paymentsWired: ApiModule = (app, deps) => paymentsModule({ ports: productionPaymentsPorts() })(app, deps)

export const apiModules: ApiModule[] = [
  authModule,
  peopleModule,
  settingsModule,
  customersModule,
  schedulingModule,
  paymentsWired,
  createMessagingModule((deps) => runtimeOf(deps)),
]
export const hookModules: ApiModule[] = []
