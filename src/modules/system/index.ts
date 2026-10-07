import type { ApiModule } from '../../http/modules.js'
import { registerSystemRoutes } from './routes.js'

export { JobsStatusResponse } from './routes.js'

/** Operator-facing endpoints: job status. Registered in src/http/modules.ts. */
export const systemModule: ApiModule = (app) => {
  registerSystemRoutes(app)
}
