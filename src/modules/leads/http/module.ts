import type { ApiModule } from '../../../http/modules.js'
import { registerLeadRoutes } from './routes.js'

/** The staff's leads list (ADR 0160, wave W3b). */
export const leadsModule: ApiModule = (app) => registerLeadRoutes(app)
