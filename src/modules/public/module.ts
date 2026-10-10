// Route-module entry point of the public website's API (ADR 0150). The wiring (the messaging queue, the scheduling ports a web
// booking is created with) comes from src/http/modules.ts, the same objects the dashboard's modules use; tests pass the production
// list (apiModules) and get exactly that.
import type { AppDeps } from '../../app.js'
import type { ApiModule } from '../../http/modules.js'
import type { DbMessageQueue } from '../messaging/queue.js'
import { resolvePorts } from '../scheduling/module.js'
import type { SchedulingPorts } from '../scheduling/ports.js'
import { registerPublicRoutes } from './http/routes.js'
import './problems.js'
import './schema.js'

export interface PublicWiring {
  queue: DbMessageQueue
  scheduling: Partial<SchedulingPorts>
}

export function createPublicModule(wire: (deps: AppDeps) => PublicWiring): ApiModule {
  return (app, deps) => {
    const w = wire(deps)
    registerPublicRoutes({ app, queue: w.queue, scheduling: resolvePorts(deps, { ...w.scheduling, messages: w.queue }) })
  }
}
