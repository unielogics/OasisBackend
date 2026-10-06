// Production wiring that connects modules built independently of each other. src/server.ts and the composition test
// both call this, so the test exercises exactly what runs in production.
import { syncChecklistTemplate } from './modules/scheduling/checklist-sync.js'
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
