// Production wiring that connects modules built independently of each other. src/server.ts and the composition test
// both call this, so the test exercises exactly what runs in production.
import { dbMembershipPort } from './modules/memberships/port.js'
import { sqspExternalAlerts } from './modules/payments-sync/db/queries.js'
import { createGatewayFor } from './modules/payments/module.js'
import { ledgerRevenueSource } from './modules/payments/revenue.js'
import { syncChecklistTemplate } from './modules/scheduling/checklist-sync.js'
import { configureSchedulingJobs } from './modules/scheduling/jobs.js'
import { ActivityClosureNotifier, ActivityEmergencyNotifier } from './modules/settings/db-adapters/index.js'
import { configureSettings } from './modules/settings/http/runtime.js'
import type { Clock } from './platform/clock.js'
import type { NewId } from './platform/ids.js'

export function configureProductionSettings(deps: { clock: Clock; newId: NewId }): void {
  configureSettings({
    // Notifications record to the activity log and audit until the SMS and email wave replaces these two.
    closureNotifier: (locationId) => new ActivityClosureNotifier(locationId),
    emergencyNotifier: new ActivityEmergencyNotifier(),
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

/**
 * The worker's alerts scan (appointments.late_scan) computes the same "Needs attention" set the API serves, so it gets the same
 * real ports: the invoice gateway, ledger revenue, the memberships port (alert 9) and the Squarespace alert source (alert 12).
 * Without this the scan would run on the in-memory defaults and announce a different alert set than the board shows.
 */
export function configureProductionSchedulingJobs(deps: { clock: Clock; newId: NewId }): void {
  configureSchedulingJobs({
    invoices: createGatewayFor(deps),
    revenue: ledgerRevenueSource,
    memberships: dbMembershipPort,
    externalAlerts: sqspExternalAlerts,
  })
}
