// What the identity services need from the process: the database, the clock and ids, the PIN hasher (with the environment's
// pepper), the messaging queue the step-up codes go through, the shared hourly ceiling on texted codes and a logger. The link API
// (wave W3) builds one per app; tests build one with a cheap scrypt cost.
import type { Env } from '../../config/env.js'
import type { Clock } from '../../platform/clock.js'
import type { Db } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import type { ScryptParams } from '../auth/password.js'
import type { EnqueueArgs, EnqueueOutcome } from '../messaging/queue.js'
import type { Tx } from '../../platform/db.js'
import { PinHasher, pinHasherFromEnv } from './pin.js'

export interface IdentityQueue {
  enqueueFor(tx: Tx, a: EnqueueArgs): Promise<EnqueueOutcome>
}

export interface IdentityLog {
  warn(obj: unknown, msg?: string): void
}

export interface IdentityDeps {
  db: Db
  clock: Clock
  newId: NewId
  pins: PinHasher
  queue: IdentityQueue
  /** PUBLIC_OTP_TEXTS_PER_HOUR: the website's codes and the link pages' codes share it. */
  otpTextsPerHour: number
  log: IdentityLog
}

const quiet: IdentityLog = { warn: () => undefined }

export function identityDeps(o: {
  db: Db
  clock: Clock
  newId: NewId
  env: Pick<Env, 'PIN_PEPPER' | 'PUBLIC_OTP_TEXTS_PER_HOUR'>
  queue: IdentityQueue
  log?: IdentityLog
  scrypt?: ScryptParams
}): IdentityDeps {
  return {
    db: o.db,
    clock: o.clock,
    newId: o.newId,
    pins: pinHasherFromEnv(o.env, o.scrypt),
    queue: o.queue,
    otpTextsPerHour: o.env.PUBLIC_OTP_TEXTS_PER_HOUR,
    log: o.log ?? quiet,
  }
}
