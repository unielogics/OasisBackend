// Process-wide wiring for the Square module (ADR 0171). Jobs receive only db, clock and logger, so the environment and the SquareApi
// come from here: the injected ones (tests, an embedding process) or the process environment parsed once and squareApiFor(env).
import { loadEnv, type Env } from '../../config/env.js'
import type { SquareApi } from '../../integrations/ports/square.js'
import { squareApiFor, type SquareApiOptions } from '../../integrations/square/factory.js'
import { noopSquareIngest, type SquareIngest } from './ingest.js'

export interface SquareRuntimeOverrides {
  env?: Env
  /** Builds the API for an environment (tests point it at a simulator). */
  api?: (env: Env, o?: SquareApiOptions) => SquareApi
  /** The ingest handlers later waves install (payments, refunds, memberships, cards). */
  ingest?: SquareIngest
}

let overrides: SquareRuntimeOverrides = {}
let cachedEnv: Env | undefined

export function configureSquareRuntime(o: SquareRuntimeOverrides): void {
  overrides = o
}

export function squareEnv(): Env {
  return overrides.env ?? (cachedEnv ??= loadEnv())
}

export function squareApi(env: Env = squareEnv(), o: SquareApiOptions = {}): SquareApi {
  return (overrides.api ?? squareApiFor)(env, o)
}

export function squareIngest(): SquareIngest {
  return overrides.ingest ?? noopSquareIngest
}
