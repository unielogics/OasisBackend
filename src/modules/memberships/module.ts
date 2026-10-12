import type { ApiModule } from '../../http/modules.js'
import { registerMembershipRoutes } from './http/routes.js'
import { registerSquareMembershipRoutes } from './square/http/routes.js'

/** The memberships API, and the billing actions of memberships billed by Square (ADR 0171 wave Q3b). */
export const membershipsModule: ApiModule = (app) => {
  registerMembershipRoutes(app)
  registerSquareMembershipRoutes(app)
}
