import { randomInt } from 'node:crypto'
import { V7Generator } from 'uuidv7'
import type { Clock } from './clock.js'

export const NIL_UUID = '00000000-0000-0000-0000-000000000000'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s)

export type NewId = () => string

/**
 * UUIDv7 generator driven by the injected clock: ids are time-ordered, strictly increasing within the process
 * and reproducible under a frozen clock (only the random tail differs).
 */
export function createIdGenerator(clock: Clock): NewId {
  const gen = new V7Generator()
  return () => gen.generateOrResetCore(clock.now().getTime(), 10_000).toString()
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Unambiguous base32 code from a CSPRNG (reschedule links use at least 12 characters, about 60 bits). */
export function shortCode(length = 12): string {
  if (!Number.isInteger(length) || length < 1) throw new RangeError('length must be a positive integer')
  let out = ''
  for (let i = 0; i < length; i++) out += CROCKFORD[randomInt(32)]
  return out
}
