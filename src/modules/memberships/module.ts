import type { ApiModule } from '../../http/modules.js'
import { registerMembershipRoutes } from './http/routes.js'

export const membershipsModule: ApiModule = (app) => registerMembershipRoutes(app)
