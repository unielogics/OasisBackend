// Route-module entry point of the personal-link API (ADR 0160, design section 5, wave W3c). The wiring (the messaging queue the
// step-up codes go through, the scheduling ports a link booking is created with) comes from src/http/modules.ts, the same objects the
// website's and the dashboard's modules use. Every route answers 404 while PUBLIC_LINKS_ENABLED is false (the default).
import type { AppDeps } from '../../../app.js'
import type { ApiModule } from '../../../http/modules.js'
import type { ScryptParams } from '../../auth/password.js'
import type { DbMessageQueue } from '../../messaging/queue.js'
import { resolvePorts } from '../../scheduling/module.js'
import type { SchedulingPorts } from '../../scheduling/ports.js'
import { registerLinkRoutes } from './http/routes.js'
import './problems.js'

export interface PublicLinksWiring {
  queue: DbMessageQueue
  scheduling: Partial<SchedulingPorts>
}

export function createPublicLinksModule(wire: (deps: AppDeps) => PublicLinksWiring, o: { scrypt?: ScryptParams } = {}): ApiModule {
  return (app, deps) => {
    const w = wire(deps)
    registerLinkRoutes({ app, queue: w.queue, scheduling: resolvePorts(deps, { ...w.scheduling, messages: w.queue }), scrypt: o.scrypt })
  }
}
