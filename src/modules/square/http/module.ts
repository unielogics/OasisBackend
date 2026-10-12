import type { ApiModule } from '../../../http/modules.js'
import type { AppDeps } from '../../../app.js'
import { squareQueue, type SquareQueue } from '../runtime.js'
import { registerBillingSettingsRoutes } from './billing-routes.js'
import { registerSquareCardRoutes } from './card-routes.js'
import { registerSquarePaymentRoutes } from './payment-routes.js'
import { registerSquareRoutes } from './routes.js'

export interface SquareModuleWiring {
  /** The messaging queue the card texts go through (the card link, a fee charged). Default: the process's (configureSquareQueue). */
  queue?: SquareQueue
}

/**
 * Square (ADR 0171): the status and Test connection routes, the "Square payments to match" queue, the POS app switch and the cards on
 * file (saved cards, card links, charges, fees; wave Q3a) and Settings, Billing & integrations (wave Q3 dashapi) under /api/v1; the
 * webhook is squareHookModule under /hooks.
 */
export function createSquareModule(wiring?: (deps: AppDeps) => SquareModuleWiring): ApiModule {
  return (app, deps) => {
    const w = wiring?.(deps)
    registerSquareRoutes(app)
    registerSquarePaymentRoutes(app)
    registerSquareCardRoutes(app, { queue: () => w?.queue ?? squareQueue() })
    registerBillingSettingsRoutes(app)
  }
}

export const squareModule: ApiModule = createSquareModule()
export { squareHookModule } from './hook.js'
