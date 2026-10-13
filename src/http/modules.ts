// Registry of API modules. A vertical adds one import and one entry here; its routes are mounted under /api/v1 and
// every route must declare config.access (see ./access.ts). Webhook modules are mounted under /hooks.
import type { AppDeps } from '../app.js'
import { sesHookModule } from '../modules/messaging/email/hook.js'
import { createMessagingModule } from '../modules/messaging/http/module.js'
import { messagingRuntimeFor, productionExternalAlerts, productionPaymentsPorts } from '../composition.js'
import { assistantModule } from '../modules/assistant/http/module.js'
import { authModule, peopleModule } from '../modules/auth/module.js'
import { customersModule } from '../modules/customers/http/module.js'
import { identityModule } from '../modules/identity/http/module.js'
import { leadsModule } from '../modules/leads/http/module.js'
import { paymentsModule, createGatewayFor } from '../modules/payments/module.js'
import { ledgerRevenueSource } from '../modules/payments/revenue.js'
import { membershipsModule } from '../modules/memberships/module.js'
import { dbMembershipPort } from '../modules/memberships/port.js'
import { squarespaceHookModule, squarespaceModule } from '../modules/payments-sync/http/module.js'
import { createSquareModule, squareHookModule } from '../modules/square/http/module.js'
import { createPublicModule } from '../modules/public/module.js'
import { createPublicLinksModule, type PublicLinksWiring } from '../modules/public/links/module.js'
import { createSchedulingModule } from '../modules/scheduling/module.js'
import { statusTextsFor } from '../modules/status-texts/index.js'
import { settingsModule } from '../modules/settings/http/module.js'
import { systemModule } from '../modules/system/index.js'
import type { AppInstance } from './types.js'

export type ApiModule = (app: AppInstance, deps: AppDeps) => void | Promise<void>

const runtimeOf = (deps: AppDeps): ReturnType<typeof messagingRuntimeFor> => messagingRuntimeFor(deps)

/**
 * Scheduling composed with the real invoice gateway (payments), cash-basis revenue from the ledger, the messaging
 * outbox (every notification is queued as an SMS), the real memberships port and the combined alert source
 * (new reply, device down, card money awaiting Squarespace, orders in the manual queue), and the status texts as the car moves
 * (ADR 0160: checked in, picked up; off until Settings -> Reminders turns them on).
 */
const schedulingModule: ApiModule = (app, deps) =>
  createSchedulingModule({
    invoices: createGatewayFor(deps),
    revenue: ledgerRevenueSource,
    messages: runtimeOf(deps).queue,
    memberships: dbMembershipPort,
    externalAlerts: productionExternalAlerts,
    statusTexts: statusTextsFor(runtimeOf(deps)),
  })(app, deps)

/**
 * Payments; receipts and payment links go through the messaging queue once configureProductionPayments ran (server.ts),
 * and the reconciliation lists and the card hint read the Squarespace sync tables.
 */
const paymentsWired: ApiModule = (app, deps) => paymentsModule({ ports: productionPaymentsPorts() })(app, deps)

/**
 * The public website's routes (ADR 0150): the same invoice gateway, membership port, alert source and messaging queue as the
 * scheduling module, so a web booking is exactly a dashboard booking made by "Website".
 */
const publicModule: ApiModule = createPublicModule((deps) => ({
  queue: runtimeOf(deps).queue,
  scheduling: {
    invoices: createGatewayFor(deps),
    revenue: ledgerRevenueSource,
    memberships: dbMembershipPort,
    externalAlerts: productionExternalAlerts,
  },
}))

/**
 * The personal-link API (ADR 0160, /api/v1/public/links/*, 404 while PUBLIC_LINKS_ENABLED is false): the website's wiring, so a link
 * booking is a dashboard booking made by "Personal link" and its codes go through the same queue.
 */
export const publicLinksWiring = (deps: AppDeps): PublicLinksWiring => ({
  queue: runtimeOf(deps).queue,
  scheduling: {
    invoices: createGatewayFor(deps),
    revenue: ledgerRevenueSource,
    memberships: dbMembershipPort,
    externalAlerts: productionExternalAlerts,
  },
})
export const publicLinksModule: ApiModule = createPublicLinksModule(publicLinksWiring)

/** Square (ADR 0171); the card link and the fee texts go through the messaging queue (wave Q3a). */
export const squareModule: ApiModule = createSquareModule((deps) => ({ queue: runtimeOf(deps).queue }))

export const apiModules: ApiModule[] = [
  authModule,
  peopleModule,
  settingsModule,
  // Settings → Oasis AI: knowledge and PDFs; the practice, corrections and review contracts (ADR 0174)
  assistantModule,
  customersModule,
  identityModule,
  leadsModule,
  schedulingModule,
  paymentsWired,
  createMessagingModule((deps) => runtimeOf(deps)),
  squarespaceModule,
  squareModule,
  membershipsModule,
  publicModule,
  publicLinksModule,
  systemModule,
]
export const hookModules: ApiModule[] = [squarespaceHookModule, squareHookModule, sesHookModule]
