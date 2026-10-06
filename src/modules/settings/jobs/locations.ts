import type { Executor } from '../../../platform/db.js'

export interface JobLocation {
  id: string
  timezone: string
}

/** Locations a job sweeps; one row today, every row when a second location exists. */
export async function listLocations(db: Executor, only?: string): Promise<JobLocation[]> {
  let q = db.selectFrom('locations').select(['id', 'timezone']).orderBy('created_at').orderBy('id')
  if (only) q = q.where('id', '=', only)
  return q.execute()
}
