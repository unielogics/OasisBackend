// Shared rig of the Square database tests: a simulator per test (its own store and clock), the runtime pointed at it, and signed
// deliveries for /hooks/square.
import { afterEach } from 'vitest'
import type { Env } from '../../src/config/env.js'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { SquareClient } from '../../src/integrations/square/client.js'
import { SQUARE_SIGNATURE_HEADER, signSquareWebhook } from '../../src/integrations/square/webhook.js'
import { SquareSimApi, SquareSimStore, simFetch, type SimEventRecord } from '../../src/integrations/square/sim/index.js'
import type { SquareApi } from '../../src/integrations/ports/square.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import type { Clock } from '../../src/platform/clock.js'

export const HOOK_URL = 'https://oasis.example.com/hooks/square'
export const HOOK_KEY = 'sq-test-signature-key-current'
export const HOOK_KEY_PREVIOUS = 'sq-test-signature-key-previous'
export const SIM_LOCATION = 'LSIMTEST0001'

export const squareEnvVars = {
  SQUARE_WEBHOOK_URL: HOOK_URL,
  SQUARE_WEBHOOK_SIGNATURE_KEY: HOOK_KEY,
  SQUARE_LOCATION_ID: SIM_LOCATION,
}

/** A live-looking environment pointed at nothing (the API comes from the simulator through the runtime override). */
export const liveEnvVars = {
  ...squareEnvVars,
  SQUARE_PROVIDER: 'live',
  SQUARE_ACCESS_TOKEN: 'test-token-not-real-0001',
  SQUARE_APPLICATION_ID: 'sandbox-sq0idb-test',
}

export function simFor(clock: Clock) {
  const store = new SquareSimStore(clock, { locationId: SIM_LOCATION })
  const sim = new SquareSimApi(store, { tokens: ['sim-token-000001'] })
  const api: SquareApi = createSquareApi(
    new SquareClient({ baseUrl: 'http://sim', accessToken: 'sim-token-000001', fetch: simFetch(sim), sleeper: { sleep: async () => undefined } }),
  )
  return { store, sim, api }
}

/** Points the Square runtime (jobs, inline hook) at this api and env until the test ends. */
export function useSquareRuntime(): (o: { env?: Env; api: SquareApi; ingest?: Parameters<typeof configureSquareRuntime>[0]['ingest'] }) => void {
  afterEach(() => configureSquareRuntime({}))
  return (o) => configureSquareRuntime({ env: o.env, api: () => o.api, ingest: o.ingest })
}

export function signed(event: SimEventRecord | Record<string, unknown>, o: { key?: string; url?: string } = {}) {
  const rawBody = JSON.stringify(event)
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'Square Connect v2',
      'square-environment': 'Sandbox',
      [SQUARE_SIGNATURE_HEADER]: signSquareWebhook(o.key ?? HOOK_KEY, o.url ?? HOOK_URL, rawBody),
    },
  }
}

export function fakeJobs(o: { fail?: boolean } = {}) {
  const calls: Array<{ name: string; data: unknown; opts: unknown }> = []
  return {
    calls,
    jobs: {
      start: async () => undefined,
      stop: async () => undefined,
      health: async () => ({ ok: true, detail: '' }),
      enqueue: async (name: string, data?: object, opts?: object) => {
        if (o.fail) throw new Error('queue down')
        calls.push({ name, data, opts })
        return 'job-1'
      },
    },
  }
}
