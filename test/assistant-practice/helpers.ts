// What the practice suites share (ADR 0174 §4c): the practice deps over a messaging world (simulated model and judge, the tool
// registry, the facts, a READ-ONLY pool on the world's schema), sessions and turns made through the service, and a snapshot of the
// row counts of every table practice must never change.
import { afterAll } from 'vitest'
import { sql } from 'kysely'
import type { AiProvider } from '../../src/integrations/ports/ai.js'
import { buildShopFacts } from '../../src/modules/assistant/facts.js'
import { practiceConfig, runPracticeTurn, type PracticeDeps } from '../../src/modules/assistant/practice/runner.js'
import { createSession, createTurn, type NewSessionInput, type PracticeContext } from '../../src/modules/assistant/practice/service.js'
import { createToolRegistry } from '../../src/modules/assistant/tools/index.js'
import type { ToolRegistry } from '../../src/modules/assistant/contract.js'
import { createDb, type Db, type Executor } from '../../src/platform/db.js'
import type { World } from '../messaging-db/world.js'

export const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

/** A read-only pool on the world's schema, closed after the file. */
export function useReadOnly(w: World): () => Db {
  let db: Db | null = null
  afterAll(async () => {
    await db?.destroy()
  })
  return () => (db ??= createDb({ ...w.t.connection, poolMax: 2, readOnly: true, applicationName: 'oasis-practice-test' }))
}

export function practiceDeps(w: World, readDb: Db, o: { provider: AiProvider; judge: AiProvider; registry?: ToolRegistry }): PracticeDeps {
  return {
    db: w.t.db,
    readDb,
    clock: w.clock,
    newId: w.newId,
    env: w.env,
    cfg: practiceConfig(w.env),
    provider: o.provider,
    judge: o.judge,
    registry: o.registry ?? createToolRegistry({} as never),
    facts: buildShopFacts({ db: w.t.db, clock: w.clock, env: w.env }),
    log: quiet,
    retryBackoffMs: () => 5,
  }
}

export async function anyUserId(db: Executor): Promise<string> {
  return (await db.selectFrom('users').select('id').orderBy('id').executeTakeFirstOrThrow()).id
}

export async function practiceContext(w: World, envOverride: Partial<PracticeContext['env']> = {}): Promise<PracticeContext> {
  return {
    locationId: w.locationId,
    userId: await anyUserId(w.t.db),
    now: w.clock.now(),
    newId: w.newId,
    env: { ...w.env, AI_PRACTICE_ENABLED: true, ...envOverride },
  }
}

export async function newSession(w: World, input: NewSessionInput): Promise<string> {
  const c = await practiceContext(w)
  return (await w.t.db.transaction().execute((tx) => createSession(tx, c, input))).id
}

/** One practice text answered by the runner (the job's work), with the deps given. */
export async function say(w: World, d: PracticeDeps, sessionId: string, text: string): Promise<{ turnId: string; status: string | null }> {
  const c = await practiceContext(w)
  const turn = await w.t.db.transaction().execute((tx) => createTurn(tx, c, sessionId, text))
  return { turnId: turn.id, status: await runPracticeTurn(d, turn.id) }
}

/** Every table of the schema with its row count, practice's own tables (and the realtime events it publishes) left out. */
export async function rowCounts(db: Executor): Promise<Record<string, number>> {
  const tables = (
    await sql<{ tablename: string }>`select tablename from pg_tables where schemaname = current_schema()
      and tablename not in ('assistant_practice_sessions', 'assistant_practice_turns', 'realtime_events', 'schema_migrations')
      order by tablename`.execute(db)
  ).rows.map((r) => r.tablename)
  const out: Record<string, number> = {}
  for (const t of tables) out[t] = Number((await sql<{ n: string }>`select count(*) as n from ${sql.id(t)}`.execute(db)).rows[0]!.n)
  return out
}
