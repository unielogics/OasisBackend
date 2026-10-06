// Composition of the Payments module: the command service, the invoice gateway and the routes, over injected ports.
import type { AppDeps } from '../../app.js'
import type { ApiModule } from '../../http/modules.js'
import { createIdGenerator } from '../../platform/ids.js'
import { PaymentsService } from './commands.js'
import { createInvoiceGateway, type PaymentsGateway } from './gateway.js'
import { registerPaymentsRoutes } from './http/routes.js'
import { defaultPorts, type PaymentsPorts } from './ports.js'

export interface PaymentsModuleOptions {
  ports?: Partial<PaymentsPorts>
}

/** The gateway the scheduling module is handed at composition time (needs only a clock and an id generator). */
export function createGatewayFor(deps: Pick<AppDeps, 'clock' | 'newId'>): PaymentsGateway {
  return createInvoiceGateway({ clock: deps.clock, newId: deps.newId ?? createIdGenerator(deps.clock) })
}

export function paymentsModule(o: PaymentsModuleOptions = {}): ApiModule {
  return (app, deps) => {
    const ports = defaultPorts(o.ports)
    const newId = deps.newId ?? createIdGenerator(deps.clock)
    const service = new PaymentsService({ clock: deps.clock, newId, ports })
    registerPaymentsRoutes(app, service, ports)
  }
}
