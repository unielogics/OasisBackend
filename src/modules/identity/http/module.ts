import type { ApiModule } from '../../../http/modules.js'
import { registerIdentityStaffRoutes } from './staff-routes.js'

/** The identity core's staff routes (ADR 0160). The personal-link routes for clients come in wave W3, behind PUBLIC_LINKS_ENABLED. */
export const identityModule: ApiModule = (app) => registerIdentityStaffRoutes(app)
