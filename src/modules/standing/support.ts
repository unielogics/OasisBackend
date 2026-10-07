// Small shared pieces of the standing module: the feature flag, the system actor the jobs act as, and a savepoint helper.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { getSetting } from '../../platform/settings.js'
import type { Actor } from '../scheduling/context.js'
import './problems.js'

export async function featureEnabled(db: Executor, locationId: string): Promise<boolean> {
  return (await getSetting(db, locationId, 'features.standing_waitlist')).value
}

/** 409 FEATURE_DISABLED unless the shop turned standing appointments and the waitlist on. */
export async function requireFeature(db: Executor, locationId: string): Promise<void> {
  if (!(await featureEnabled(db, locationId))) throw new AppError('FEATURE_DISABLED')
}

/** The hands of the jobs: it may book and confirm, never override. Its id is not a users row, so nothing stores it as one. */
export function systemActor(locationId: string, name = 'Standing appointments'): Actor {
  return {
    auth: {
      userId: 'system:standing',
      employeeId: null,
      locationId,
      permissions: new Set(['sched.edit', 'jobs.status']),
      actorName: name,
    },
    audit: { actor: { name } },
  }
}

let savepointN = 0

/** Runs fn under a savepoint: an error rolls back only fn's writes and is returned instead of thrown (AppError only). */
export async function attempt<T>(
  tx: Tx,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: AppError }> {
  const name = `sp_${++savepointN}`
  await sql.raw(`savepoint ${name}`).execute(tx)
  try {
    const value = await fn()
    await sql.raw(`release savepoint ${name}`).execute(tx)
    return { ok: true, value }
  } catch (e) {
    await sql.raw(`rollback to savepoint ${name}`).execute(tx)
    if (e instanceof AppError) return { ok: false, error: e }
    throw e
  }
}
