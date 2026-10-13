// square_state: one row per location (ADR 0171) with what the connection test learned, the catch-up watermark and the last reconcile.
// Every fact in the row belongs to the Square it was learned from (`environment`: sim, sandbox or production). The code reads the row
// only through currentSquareState(), which ignores a row of another environment, and saveSquareState() starts the row afresh when the
// environment changes: a merchant id, watermark or 'events enabled' learned from the simulator or the sandbox never applies to
// production (a foreign-merchant check against the simulator's merchant would drop every real event).
import { sql } from 'kysely'
import type { Env } from '../../../config/env.js'
import type { Executor } from '../../../platform/db.js'
import type { SquareConnectionTest, SquareReconcileSummary } from './schema.js'
import './schema.js'

export type SquareStateRow = NonNullable<Awaited<ReturnType<typeof getSquareState>>>

export interface SquareStatePatch {
  square_location_id?: string | null
  merchant_id?: string | null
  events_enabled_at?: Date | null
  connected_at?: Date | null
  webhook_subscription_id?: string | null
  webhook_checked_at?: Date | null
  last_webhook_at?: Date | null
  watermark?: Date | null
  last_catchup_at?: Date | null
  last_catchup_events?: number
  last_catchup_claimed_at?: Date | null
  last_reconcile_at?: Date | null
  last_reconcile?: SquareReconcileSummary | null
  last_test_at?: Date | null
  last_test?: SquareConnectionTest | null
  last_error?: string | null
  last_error_at?: Date | null
}

export function squareEnvironment(env: Pick<Env, 'SQUARE_PROVIDER' | 'SQUARE_ENVIRONMENT'>): 'sandbox' | 'production' | 'sim' {
  return env.SQUARE_PROVIDER === 'sim' ? 'sim' : env.SQUARE_ENVIRONMENT
}

/** The location's row as stored, whatever environment it describes (tests and diagnostics; the code uses currentSquareState). */
export async function getSquareState(db: Executor, locationId: string) {
  return db.selectFrom('square_state').selectAll().where('location_id', '=', locationId).executeTakeFirst()
}

/** The location's row only when it was learned from the Square this process talks to; a row of another environment reads as none. */
export async function currentSquareState(db: Executor, locationId: string, env: Pick<Env, 'SQUARE_PROVIDER' | 'SQUARE_ENVIRONMENT'>) {
  const row = await getSquareState(db, locationId)
  return row && row.environment === squareEnvironment(env) ? row : undefined
}

/** Every learned column, and its value in a fresh row: what an environment change resets (unless the save sets it). */
const LEARNED = {
  square_location_id: null,
  merchant_id: null,
  events_enabled_at: null,
  connected_at: null,
  webhook_subscription_id: null,
  webhook_checked_at: null,
  last_webhook_at: null,
  watermark: null,
  last_catchup_at: null,
  last_catchup_events: 0,
  last_catchup_claimed_at: null,
  last_reconcile_at: null,
  last_reconcile: null,
  last_test_at: null,
  last_test: null,
  last_error: null,
  last_error_at: null,
} as const satisfies Record<keyof SquareStatePatch, null | number>

/**
 * Inserts or updates the location's row with the fields given (JSON fields serialised); the environment is always refreshed. When
 * the stored environment differs, every learned column the patch does not set goes back to its fresh value (one statement, no race).
 */
export async function saveSquareState(
  db: Executor,
  locationId: string,
  env: Pick<Env, 'SQUARE_PROVIDER' | 'SQUARE_ENVIRONMENT'>,
  now: Date,
  patch: SquareStatePatch,
): Promise<void> {
  const { last_reconcile, last_test, ...plain } = patch
  const values = {
    ...plain,
    ...(last_reconcile !== undefined ? { last_reconcile: last_reconcile === null ? null : JSON.stringify(last_reconcile) } : {}),
    ...(last_test !== undefined ? { last_test: last_test === null ? null : JSON.stringify(last_test) } : {}),
    environment: squareEnvironment(env),
    updated_at: now,
  }
  const resets = Object.fromEntries(
    (Object.keys(LEARNED) as Array<keyof typeof LEARNED>)
      .filter((k) => patch[k] === undefined)
      .map((k) => [
        k,
        sql`case when square_state.environment = excluded.environment then ${sql.ref(`square_state.${k}`)} else ${sql.lit(LEARNED[k])} end`,
      ]),
  )
  await db
    .insertInto('square_state')
    .values({ location_id: locationId, created_at: now, ...values })
    .onConflict((oc) => oc.column('location_id').doUpdateSet({ ...resets, ...values } as never))
    .execute()
}
