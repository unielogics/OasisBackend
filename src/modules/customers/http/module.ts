import type { ApiModule } from '../../../http/modules.js'
import { registerCustomerBookingRoutes } from './routes.js'

export const customersModule: ApiModule = (app) => registerCustomerBookingRoutes(app)
