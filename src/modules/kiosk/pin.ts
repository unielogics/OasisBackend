// Employee kiosk PINs (ADR 0180 amendment, owner 2026-10-14): the rules a new PIN must pass, its generator and its lookup.
//
// A PIN is exactly 8 digits and never starts with 0218: typing 0218 first on the keypad reveals the manager's email/password card
// (dashboard only; the server never sees it). Repeats, runs, repeating patterns, dates and a short list of common PINs are refused;
// the service adds "not used by anyone else in the shop" (a neutral "Choose another PIN") and "not one of this employee's last 3".
//
// The stored lookup is hex HMAC-SHA256(kiosk PIN key, "<location id>:<pin>") with the key = HMAC-SHA256(SESSION_SECRET,
// "oasis-kiosk-pin-key:v1"): deterministic, so a typed PIN finds its employee by an index and is unique within the shop, while a
// database copy alone cannot be brute-forced over the 10^8 space (it needs SESSION_SECRET too). SESSION_SECRET is already required in
// production, so there is no new secret; rotating it makes every PIN stop working (managers set new ones).
import { createHmac, randomInt } from 'node:crypto'

export const KIOSK_PIN_LENGTH = 8
/** Typed first on the keypad, these four digits reveal the email/password card; no PIN may start with them. */
export const KIOSK_REVEAL_PREFIX = '0218'
/** A new PIN may not be one of the employee's last this many PINs (the current one included). */
export const KIOSK_PIN_HISTORY = 3

const SHAPE = /^\d{8}$/

/** PINs people pick that the pattern rules do not catch. */
const COMMON_PINS: ReadonlySet<string> = new Set([
  '12344321',
  '43211234',
  '13572468',
  '24681357',
  '14725836',
  '14789632',
  '15935728',
  '74108520',
  '12348765',
  '87651234',
  '11112222',
  '12345670',
  '13579246',
  '15975346',
  '78963214',
  '96385274',
  '19283746',
  '10203040',
])

/** Every digit one more (or one less) than the one before, wrapping 9 to 0. */
function isRun(pin: string): boolean {
  const d = [...pin].map(Number)
  const step = (d[1]! - d[0]! + 10) % 10
  if (step !== 1 && step !== 9) return false
  return d.every((x, i) => i === 0 || (x - d[i - 1]! + 10) % 10 === step)
}

/** Repeats with a period of 1 to 4 digits (12121212, 12312312, 12341234), or four doubled digits (11223344). */
function isPattern(pin: string): boolean {
  for (let p = 1; p <= 4; p++) if ([...pin].every((c, i) => i < p || c === pin[i - p])) return true
  return pin[0] === pin[1] && pin[2] === pin[3] && pin[4] === pin[5] && pin[6] === pin[7]
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2099 || m < 1 || m > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** YYYYMMDD or MMDDYYYY, from 1900 to 2099. */
function isDate(pin: string): boolean {
  const n = (a: number, b: number) => Number(pin.slice(a, b))
  return isRealDate(n(0, 4), n(4, 6), n(6, 8)) || isRealDate(n(4, 8), n(0, 2), n(2, 4))
}

/** Why `pin` cannot be a kiosk PIN, or null when it can (uniqueness and the last-3 rule are the service's, against the stored lookups). */
export function pinProblem(pin: string): string | null {
  if (!SHAPE.test(pin)) return `Use exactly ${KIOSK_PIN_LENGTH} digits.`
  if (pin.startsWith(KIOSK_REVEAL_PREFIX))
    return `The PIN can't start with ${KIOSK_REVEAL_PREFIX}. Those digits open the manager sign-in.`
  if (/^(\d)\1+$/.test(pin)) return 'Don’t use one digit over and over.'
  if (isRun(pin)) return 'Don’t use digits in a row like 12345678.'
  if (isPattern(pin)) return 'Don’t use a repeating pattern like 12121212.'
  if (isDate(pin)) return 'Don’t use a date. Choose another PIN.'
  if (COMMON_PINS.has(pin)) return 'That PIN is too common. Choose another.'
  return null
}

/** The employee had this PIN recently. */
export const REUSED_PIN_PROBLEM = 'That PIN was used recently. Choose a new one.'
/** Somebody else in the shop has it: neutral on purpose (it never says who, or even that someone does). */
export const TAKEN_PIN_PROBLEM = 'Choose another PIN.'

const fourDigits = (): string => String(randomInt(0, 10_000)).padStart(4, '0')

/** A random PIN that passes every rule. `four` supplies 4 digits per call (tests). */
export function generatePin(four: () => string = fourDigits): string {
  for (let i = 0; i < 1000; i++) {
    const pin = `${four()}${four()}`
    if (pinProblem(pin) === null) return pin
  }
  throw new Error('Could not generate a kiosk PIN')
}

/** Stands in for SESSION_SECRET outside production (tests, local development). Not a secret. */
const DEV_SESSION_SECRET = 'oasis-dev-only-kiosk-session-secret-not-a-secret'

/** HMAC-SHA256(SESSION_SECRET, "oasis-kiosk-pin-key:v1"): 32 bytes. Production without SESSION_SECRET is refused. */
export function kioskKey(env: { NODE_ENV: string; SESSION_SECRET?: string }): Buffer {
  const secret = env.SESSION_SECRET
  if (!secret && env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required for the kiosk PIN key')
  return createHmac('sha256', secret || DEV_SESSION_SECRET)
    .update('oasis-kiosk-pin-key:v1')
    .digest()
}

/** The stored lookup of a PIN at a location: hex HMAC-SHA256(key, "<location id>:<pin>"). Never logged. */
export function pinLookup(key: Buffer, locationId: string, pin: string): string {
  if (key.length !== 32) throw new Error('The kiosk PIN key must be 32 bytes')
  return createHmac('sha256', key).update(`${locationId}:${pin}`).digest('hex')
}
