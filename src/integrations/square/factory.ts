// squareApiFor(env): the SquareApi port for this process (ADR 0171). SQUARE_PROVIDER=live talks to Square for SQUARE_ENVIRONMENT, or
// to SQUARE_API_BASE (a pnpm sim:square simulator); SQUARE_PROVIDER=sim talks to one in-process simulator per process, through the
// same client, so retries, idempotency keys, wire parsing and errors behave exactly as live. Nothing leaves the process in sim mode.
import type { SquareApi } from '../ports/square.js'
import { createSquareApi } from './api/index.js'
import { SquareClient, type Sleeper, type SquareRequestInfo } from './client.js'
import { SIM_ACCESS_TOKEN, squareBaseUrl, squareLocationId, type SquareEnv } from './config.js'
import { simFetch } from './sim/fetch.js'
import { SquareSimApi } from './sim/api.js'
import { SquareSimStore } from './sim/store.js'
import { systemClock, type Clock } from '../../platform/clock.js'

export interface SquareApiOptions {
  fetch?: typeof fetch
  sleeper?: Sleeper
  onRequest?: (info: SquareRequestInfo) => void
  /** Overrides SQUARE_WRITES_ENABLED (setup scripts and the connection test pass true only for setup calls). */
  writesEnabled?: boolean
}

let shared: { api: SquareSimApi; store: SquareSimStore } | undefined

/** The process's in-process simulator (SQUARE_PROVIDER=sim), created on first use with the configured location. */
export function sharedSquareSim(env?: Pick<SquareEnv, 'SQUARE_LOCATION_ID' | 'SQUARE_PROVIDER'>, clock: Clock = systemClock): { api: SquareSimApi; store: SquareSimStore } {
  if (!shared) {
    const store = new SquareSimStore(clock, { locationId: env ? squareLocationId(env as SquareEnv) : undefined })
    shared = { store, api: new SquareSimApi(store, { tokens: [SIM_ACCESS_TOKEN] }) }
  }
  return shared
}

/** Forgets the in-process simulator (tests). */
export function resetSharedSquareSim(): void {
  shared = undefined
}

export function squareClientFor(env: SquareEnv, o: SquareApiOptions = {}): SquareClient {
  const common = {
    apiVersion: env.SQUARE_API_VERSION,
    timeoutMs: env.SQUARE_TIMEOUT_MS,
    maxAttempts: env.SQUARE_MAX_ATTEMPTS,
    sleeper: o.sleeper,
    onRequest: o.onRequest,
    writesEnabled: o.writesEnabled ?? env.SQUARE_WRITES_ENABLED,
  }
  if (env.SQUARE_PROVIDER === 'sim')
    return new SquareClient({ ...common, baseUrl: 'http://square-sim.invalid', accessToken: SIM_ACCESS_TOKEN, fetch: o.fetch ?? simFetch(sharedSquareSim(env).api) })
  if (!env.SQUARE_ACCESS_TOKEN) throw new Error('SQUARE_ACCESS_TOKEN is not set (required when SQUARE_PROVIDER=live)')
  return new SquareClient({ ...common, baseUrl: squareBaseUrl(env), accessToken: env.SQUARE_ACCESS_TOKEN, fetch: o.fetch })
}

export function squareApiFor(env: SquareEnv, o: SquareApiOptions = {}): SquareApi {
  return createSquareApi(squareClientFor(env, o))
}
