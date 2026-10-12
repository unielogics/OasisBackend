import type { ApiModule } from '../../../http/modules.js'
import { registerSquareRoutes } from './routes.js'

/** Square (ADR 0171): the status and Test connection routes under /api/v1; the webhook is squareHookModule under /hooks. */
export const squareModule: ApiModule = (app) => registerSquareRoutes(app)
export { squareHookModule } from './hook.js'
