// What the Square membership code runs with outside a request (the jobs) and around a request's Square calls: the database, the
// clock, ids, the environment, the Square API, the location and a logger.
import type { Env } from '../../../config/env.js'
import type { SquareApi } from '../../../integrations/ports/square.js'
import type { Clock } from '../../../platform/clock.js'
import type { Db } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import type { SquareLogger } from '../../square/ingest.js'

export interface SquareSteps {
  db: Db
  clock: Clock
  newId: NewId
  env: Env
  api: SquareApi
  locationId: string
  logger?: SquareLogger
}
