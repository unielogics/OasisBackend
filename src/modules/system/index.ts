import type { ApiModule } from '../../http/modules.js'
import { registerEmailSuppressionRoutes } from './integrations-email.js'
import { registerIntegrationRoutes } from './integrations.js'
import { registerSystemRoutes } from './routes.js'

export { JobsStatusResponse } from './routes.js'

/** Operator-facing endpoints: job status, integration status, the email suppression list. Registered in src/http/modules.ts. */
export const systemModule: ApiModule = (app) => {
  registerSystemRoutes(app)
  registerIntegrationRoutes(app)
  registerEmailSuppressionRoutes(app)
}
