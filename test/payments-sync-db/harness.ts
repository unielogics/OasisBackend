// Rig for the Squarespace read side over real Postgres and the simulator: one frozen clock shared by the database
// (app_now()), the simulator, the client and the sleeper, so a 429 storm or a three-week gap runs in milliseconds.
import { beforeEach } from 'vitest'
import type { Env } from '../../src/config/env.js'
import { loadEnv } from '../../src/config/env.js'
import { SquarespaceClient } from '../../src/integrations/squarespace/client.js'
import { SlidingWindowLimiter } from '../../src/integrations/squarespace/limiter.js'
import { FakeSleeper } from '../../src/integrations/squarespace/sleeper.js'
import { SquarespaceSimApi } from '../../src/integrations/squarespace/sim/api.js'
import { SquarespaceSimStore } from '../../src/integrations/squarespace/sim/store.js'
import { configureSqspRuntime } from '../../src/modules/payments-sync/db/runtime-config.js'
import { createSqspRuntime } from '../../src/modules/payments-sync/db/runtime-config.js'
import type { SqspRuntime } from '../../src/modules/payments-sync/db/runtime.js'
import { FixedClock } from '../../src/platform/clock.js'
import type { Db } from '../../src/platform/db.js'
import { createIdGenerator, type NewId } from '../../src/platform/ids.js'
import { ensureLocation, type Location } from '../../src/platform/locations.js'
import { useTestDb, type TestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { simFetch } from '../integrations/squarespace/helpers.js'

export const DAY_START = '2026-10-06T14:00:00.000Z'
export const SIM_KEY = 'sim-api-key'
export const SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')

export const H = 3_600_000
export const D = 86_400_000

export function testEnv(over: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    SQSP_PROVIDER: 'live',
    SQSP_API_KEY: SIM_KEY,
    SECRETS_KEY,
    ...over,
  })
}

export interface Rig {
  t: TestDb
  db: Db
  clock: FixedClock
  newId: NewId
  location: Location
  locationId: string
  store: SquarespaceSimStore
  api: SquarespaceSimApi
  sleeper: FakeSleeper
  client: SquarespaceClient
  rt: SqspRuntime
  env: Env
  /** Advance the shared clock. */
  advance(ms: number): void
}

export interface RigOptions {
  pageSize?: number
  env?: Record<string, string>
}

/** Registers beforeEach hooks that give every test a fresh simulator, runtime and location. */
export function useRig(o: RigOptions = {}): () => Rig {
  const clock = new FixedClock(DAY_START)
  const t = useTestDb({ clock })
  let rig: Rig
  beforeEach(async () => {
    const newId = createIdGenerator(clock)
    const location = await ensureLocation(t.db, newId)
    const store = new SquarespaceSimStore(clock, { pageSize: o.pageSize ?? 3, order: 'asc', currency: 'USD' })
    const api = new SquarespaceSimApi(store, clock, { apiKeys: [SIM_KEY] })
    const sleeper = new FakeSleeper(clock)
    const client = new SquarespaceClient({
      auth: { kind: 'api_key', apiKey: SIM_KEY },
      clock,
      sleeper,
      fetch: simFetch(api),
      userAgent: 'OasisTest/1.0',
      limiter: new SlidingWindowLimiter(clock, sleeper, 240, 60_000),
    })
    const env = testEnv(o.env)
    configureSqspRuntime({ env, sleeper, sourceFactory: () => client })
    const rt = createSqspRuntime({ db: t.db, clock, newId, env })
    rig = {
      t,
      db: t.db,
      clock,
      newId,
      location,
      locationId: location.id,
      store,
      api,
      sleeper,
      client,
      rt,
      env,
      advance: (ms) => clock.advance(ms),
    }
  })
  return () => rig
}
