// Route-module entry point of kiosk mode (ADR 0180): /api/v1/kiosk/* and the activity report contract, over the app's Identity.
import type { ApiModule } from '../../http/modules.js'
import { identityProvider } from '../auth/module.js'
import { registerKioskRoutes } from './routes.js'

export const kioskModule: ApiModule = (app, deps) => registerKioskRoutes(app, identityProvider(deps))
