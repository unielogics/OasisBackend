import type { ApiModule } from '../../../http/modules.js'
import { registerSqspRoutes } from './routes.js'

export const squarespaceModule: ApiModule = (app) => registerSqspRoutes(app)
export { squarespaceHookModule } from './hook.js'
