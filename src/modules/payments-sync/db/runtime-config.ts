// Process-wide wiring seam for the read side. Jobs (pg-boss handlers only receive db, clock and logger) and the HTTP module
// both build their runtime through createSqspRuntime(); tests (and an embedding process) call configureSqspRuntime() once to
// inject the Squarespace source, fetch or sleeper, or a fixed environment.
import { loadEnv, type Env } from '../../../config/env.js'
import type { Clock } from '../../../platform/clock.js'
import type { Db } from '../../../platform/db.js'
import { createIdGenerator, type NewId } from '../../../platform/ids.js'
import { SqspRuntime, type SqspRuntimeDeps } from './runtime.js'

export interface RuntimeOverrides {
  env?: Env
  sleeper?: SqspRuntimeDeps['sleeper']
  fetch?: SqspRuntimeDeps['fetch']
  sourceFactory?: SqspRuntimeDeps['sourceFactory']
}

let overrides: RuntimeOverrides = {}
let cachedEnv: Env | undefined

export function configureSqspRuntime(o: RuntimeOverrides): void {
  overrides = o
}

/** The environment for code that has no AppDeps (jobs): the injected one, else the process environment, parsed once. */
export function sqspEnv(): Env {
  return overrides.env ?? (cachedEnv ??= loadEnv())
}

export function createSqspRuntime(d: { db: Db; clock: Clock; newId?: NewId; env?: Env }): SqspRuntime {
  return new SqspRuntime({
    db: d.db,
    clock: d.clock,
    newId: d.newId ?? createIdGenerator(d.clock),
    env: d.env ?? sqspEnv(),
    sleeper: overrides.sleeper,
    fetch: overrides.fetch,
    sourceFactory: overrides.sourceFactory,
  })
}
