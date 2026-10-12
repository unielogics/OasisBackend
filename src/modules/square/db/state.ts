// square_state: one row per location (ADR 0171) with what the connection test learned, the catch-up watermark and the last reconcile.
import type { Env } from '../../../config/env.js'
import type { Executor } from '../../../platform/db.js'
import type { SquareConnectionTest, SquareReconcileSummary } from './schema.js'
import './schema.js'

export type SquareStateRow = NonNullable<Awaited<ReturnType<typeof getSquareState>>>

export interface SquareStatePatch {
  square_location_id?: string | null
  merchant_id?: string | null
  events_enabled_at?: Date | null
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

export async function getSquareState(db: Executor, locationId: string) {
  return db.selectFrom('square_state').selectAll().where('location_id', '=', locationId).executeTakeFirst()
}

/** Inserts or updates the location's row with the fields given (JSON fields serialised); the environment is always refreshed. */
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
  await db
    .insertInto('square_state')
    .values({ location_id: locationId, created_at: now, ...values })
    .onConflict((oc) => oc.column('location_id').doUpdateSet(values))
    .execute()
}
