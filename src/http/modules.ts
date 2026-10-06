// Registry of API modules. A vertical adds one import and one entry here; its routes are mounted under /api/v1 and
// every route must declare config.access (see ./access.ts). Webhook modules are mounted under /hooks.
import type { AppDeps } from '../app.js'
import { authModule, peopleModule } from '../modules/auth/module.js'
import { customersModule } from '../modules/customers/http/module.js'
import { paymentsModule, createGatewayFor } from '../modules/payments/module.js'
import { ledgerRevenueSource } from '../modules/payments/revenue.js'
import { createSchedulingModule } from '../modules/scheduling/module.js'
import { settingsModule } from '../modules/settings/http/module.js'
import type { AppInstance } from './types.js'

export type ApiModule = (app: AppInstance, deps: AppDeps) => void | Promise<void>

/** Scheduling composed with the real invoice gateway (payments) and cash-basis revenue from the ledger. */
const schedulingModule: ApiModule = (app, deps) =>
  createSchedulingModule({ invoices: createGatewayFor(deps), revenue: ledgerRevenueSource })(app, deps)

export const apiModules: ApiModule[] = [
  authModule,
  peopleModule,
  settingsModule,
  customersModule,
  schedulingModule,
  paymentsModule(),
]
export const hookModules: ApiModule[] = []
