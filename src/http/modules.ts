// Registry of API modules. A vertical adds one import and one entry here; its routes are mounted under /api/v1 and
// every route must declare config.access (see ./access.ts). Webhook modules are mounted under /hooks.
import type { AppDeps } from '../app.js'
import { authModule, peopleModule } from '../modules/auth/module.js'
import { customersModule } from '../modules/customers/http/module.js'
import { paymentsModule, createGatewayFor } from '../modules/payments/module.js'
import { ledgerRevenueSource } from '../modules/payments/revenue.js'
import { membershipsModule } from '../modules/memberships/module.js'
import { dbMembershipPort } from '../modules/memberships/port.js'
import { sqspCardHints, sqspExternalAlerts, sqspUnmatched } from '../modules/payments-sync/db/queries.js'
import { squarespaceHookModule, squarespaceModule } from '../modules/payments-sync/http/module.js'
import { createSchedulingModule } from '../modules/scheduling/module.js'
import { settingsModule } from '../modules/settings/http/module.js'
import type { AppInstance } from './types.js'

export type ApiModule = (app: AppInstance, deps: AppDeps) => void | Promise<void>

/**
 * Scheduling composed with the real invoice gateway (payments), cash-basis revenue from the ledger, the real memberships port and
 * the Squarespace alert source (alert 12: card money awaiting Squarespace, orders waiting in the manual queue).
 */
const schedulingModule: ApiModule = (app, deps) =>
  createSchedulingModule({
    invoices: createGatewayFor(deps),
    revenue: ledgerRevenueSource,
    memberships: dbMembershipPort,
    externalAlerts: sqspExternalAlerts,
  })(app, deps)

export const apiModules: ApiModule[] = [
  authModule,
  peopleModule,
  settingsModule,
  customersModule,
  schedulingModule,
  // the reconciliation lists and the card hint read the Squarespace sync tables
  paymentsModule({ ports: { unmatched: sqspUnmatched, cardHints: sqspCardHints } }),
  squarespaceModule,
  membershipsModule,
]
export const hookModules: ApiModule[] = [squarespaceHookModule]
