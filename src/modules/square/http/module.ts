import type { ApiModule } from '../../../http/modules.js'
import { registerSquarePaymentRoutes } from './payment-routes.js'
import { registerSquareRoutes } from './routes.js'

/**
 * Square (ADR 0171): the status and Test connection routes, the "Square payments to match" queue and the POS app switch under
 * /api/v1; the webhook is squareHookModule under /hooks.
 */
export const squareModule: ApiModule = (app) => {
  registerSquareRoutes(app)
  registerSquarePaymentRoutes(app)
}
export { squareHookModule } from './hook.js'
