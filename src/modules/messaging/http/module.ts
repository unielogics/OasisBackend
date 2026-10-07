import type { AppDeps } from '../../../app.js'
import type { ApiModule } from '../../../http/modules.js'
import type { AppInstance } from '../../../http/types.js'
import type { MessagingRuntime } from '../runtime.js'
import { registerConsentRoutes } from './consent-routes.js'
import { registerDevRoutes } from './dev-routes.js'
import { registerDeviceRoutes } from './device-routes.js'
import { registerOutboxRoutes } from './outbox-routes.js'
import { registerThreadRoutes } from './thread-routes.js'

export function registerMessagingRoutes(app: AppInstance, rt: MessagingRuntime): void {
  registerThreadRoutes(app, rt)
  registerOutboxRoutes(app, rt)
  registerConsentRoutes(app, rt)
  registerDeviceRoutes(app, rt)
  if (app.env.ALLOW_DEV_ENDPOINTS) registerDevRoutes(app, rt)
}

/** The messaging routes under /api/v1. `runtimeFor` supplies the runtime shared with the rest of the process. */
export function createMessagingModule(
  runtimeFor: (deps: AppDeps, app: AppInstance) => MessagingRuntime,
): ApiModule {
  return (app, deps) => registerMessagingRoutes(app, runtimeFor(deps, app))
}
