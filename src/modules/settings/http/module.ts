// Route module for the Settings vertical: hours and rules, closures, emergency, VIP, arrival, services and the bundle.
// Registered in src/http/modules.ts; src/server.ts wires the ports with configureSettings().
import type { ApiModule } from '../../../http/modules.js'
import { registerCatalogRoutes } from '../../catalog/http/routes.js'
import { registerVipClientRoutes } from '../../customers/http/vip-clients.js'
import { registerBundleRoute } from './bundle-routes.js'
import { registerClosureRoutes } from './closure-routes.js'
import { registerEmergencyRoutes } from './emergency-routes.js'
import { registerHoursRoutes } from './hours-routes.js'
import { createRuntime, type SettingsPorts } from './runtime.js'
import { registerVipRoutes } from './vip-routes.js'
import './problems.js'

export function createSettingsModule(overrides?: Partial<SettingsPorts>): ApiModule {
  return (app, deps) => {
    const rt = createRuntime(app, deps, overrides)
    registerHoursRoutes(rt)
    registerClosureRoutes(rt)
    registerEmergencyRoutes(rt)
    registerVipRoutes(rt)
    registerVipClientRoutes(rt)
    registerCatalogRoutes(rt)
    registerBundleRoute(rt)
  }
}

export const settingsModule: ApiModule = createSettingsModule()
