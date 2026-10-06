import { buildApp, type AppDeps, type AppInstance } from '../../src/app.js'
import { loadEnv, type Env } from '../../src/config/env.js'
import { createPermissiveAuthorizer, type Authorizer } from '../../src/http/authorizer.js'
import type { ApiModule } from '../../src/http/modules.js'
import { FixedClock } from '../../src/platform/clock.js'
import type { Db } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { ensureLocation, type Location } from '../../src/platform/locations.js'
import { RealtimeHub } from '../../src/platform/realtime.js'
import { testDatabaseUrl } from './env.js'
import type { TestDb } from './db.js'

export interface TestApp {
  app: AppInstance
  db: Db
  clock: FixedClock
  env: Env
  location: Location
  hub: RealtimeHub | null
  logs: Array<Record<string, unknown>>
  close(): Promise<void>
}

export interface CreateTestAppOptions {
  testDb: TestDb
  authorizer?: (location: Location) => Authorizer
  modules?: ApiModule[]
  hookModules?: ApiModule[]
  env?: Record<string, string>
  /** Start a realtime hub (dedicated LISTEN connection) so GET /api/v1/events works. */
  hub?: boolean | { pollMs?: number }
  deps?: Partial<AppDeps>
}

/** Builds the real app against the worker schema with a frozen clock, a permissive authorizer and captured logs. */
export async function createTestApp(o: CreateTestAppOptions): Promise<TestApp> {
  const clock = o.testDb.clock as FixedClock
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    LOG_LEVEL: 'info',
    SSE_HEARTBEAT_MS: '20000',
    ...o.env,
  })
  const newId = createIdGenerator(clock)
  const location = await ensureLocation(o.testDb.db, newId)
  const logs: Array<Record<string, unknown>> = []
  const hub = o.hub
    ? new RealtimeHub({
        db: o.testDb.db,
        connection: o.testDb.connection,
        pollMs: typeof o.hub === 'object' ? o.hub.pollMs : 200,
      })
    : null
  await hub?.start()
  const app = await buildApp({
    env,
    db: o.testDb.db,
    clock,
    newId,
    hub,
    authorizer: o.authorizer
      ? o.authorizer(location)
      : createPermissiveAuthorizer({ locationId: location.id }),
    modules: o.modules ?? [],
    hookModules: o.hookModules ?? [],
    logStream: { write: (line: string) => void logs.push(JSON.parse(line) as Record<string, unknown>) },
    ...o.deps,
  })
  return {
    app,
    db: o.testDb.db,
    clock,
    env,
    location,
    hub,
    logs,
    close: async () => {
      await hub?.close()
      await app.close()
    },
  }
}
