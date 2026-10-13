// The shop's kiosk unlock code (ADR 0180): the rules a new code must pass, its generator and its hash.
//
// The code is exactly 8 digits and never starts with 0218: typing 0218 first on the keypad reveals the manager's email/password card
// (dashboard only; the server never sees it). Repeats, runs, repeating patterns, dates and a short list of common codes are refused,
// and so are the last 3 codes (checked against the stored hashes by the service).
//
// The stored hash is scrypt (src/modules/auth/password.ts, its PHC-style string) over HMAC-SHA256(kiosk key, "<location id>:<code>"),
// the same shape as the website PINs (identity/pin.ts). The kiosk key is HMAC-SHA256(SESSION_SECRET, "oasis-kiosk-code-key:v1"):
// SESSION_SECRET is already required in production, so there is no new secret to provision, and a database copy alone cannot be
// brute-forced over the 10^8 space. Rotating SESSION_SECRET invalidates the code (Settings then asks for a new one).
import { createHmac, randomInt } from 'node:crypto'
import { PasswordHasher, type ScryptParams } from '../auth/password.js'

export const KIOSK_CODE_LENGTH = 8
/** Typed first on the keypad, these four digits reveal the email/password card; no code may start with them. */
export const KIOSK_REVEAL_PREFIX = '0218'
/** A new code may not be one of the last this many codes. */
export const KIOSK_CODE_HISTORY = 3

const SHAPE = /^\d{8}$/

/** Codes people pick that the pattern rules do not catch. */
const COMMON_CODES: ReadonlySet<string> = new Set([
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
function isRun(code: string): boolean {
  const d = [...code].map(Number)
  const step = (d[1]! - d[0]! + 10) % 10
  if (step !== 1 && step !== 9) return false
  return d.every((x, i) => i === 0 || (x - d[i - 1]! + 10) % 10 === step)
}

/** Repeats with a period of 1 to 4 digits (12121212, 12312312, 12341234), or four doubled digits (11223344). */
function isPattern(code: string): boolean {
  for (let p = 1; p <= 4; p++) if ([...code].every((c, i) => i < p || c === code[i - p])) return true
  return code[0] === code[1] && code[2] === code[3] && code[4] === code[5] && code[6] === code[7]
}

function isRealDate(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2099 || m < 1 || m > 12 || d < 1) return false
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** YYYYMMDD or MMDDYYYY, from 1900 to 2099. */
function isDate(code: string): boolean {
  const n = (a: number, b: number) => Number(code.slice(a, b))
  return isRealDate(n(0, 4), n(4, 6), n(6, 8)) || isRealDate(n(4, 8), n(0, 2), n(2, 4))
}

/** Why `code` cannot be the shop's code, or null when it can (the reuse rule is checked by the service against the stored hashes). */
export function codeProblem(code: string): string | null {
  if (!SHAPE.test(code)) return `Use exactly ${KIOSK_CODE_LENGTH} digits.`
  if (code.startsWith(KIOSK_REVEAL_PREFIX))
    return `The code can't start with ${KIOSK_REVEAL_PREFIX}. Those digits open the manager sign-in.`
  if (/^(\d)\1+$/.test(code)) return 'Don’t use one digit over and over.'
  if (isRun(code)) return 'Don’t use digits in a row like 12345678.'
  if (isPattern(code)) return 'Don’t use a repeating pattern like 12121212.'
  if (isDate(code)) return 'Don’t use a date. Choose another code.'
  if (COMMON_CODES.has(code)) return 'That code is too common. Choose another.'
  return null
}

export const REUSED_CODE_PROBLEM = 'That code was used recently. Choose a new one.'

const fourDigits = (): string => String(randomInt(0, 10_000)).padStart(4, '0')

/** A random code that passes every rule. `four` supplies 4 digits per call (tests). */
export function generateCode(four: () => string = fourDigits): string {
  for (let i = 0; i < 1000; i++) {
    const code = `${four()}${four()}`
    if (codeProblem(code) === null) return code
  }
  throw new Error('Could not generate a kiosk code')
}

/** Stands in for SESSION_SECRET outside production (tests, local development). Not a secret. */
const DEV_SESSION_SECRET = 'oasis-dev-only-kiosk-session-secret-not-a-secret'

/** HMAC-SHA256(SESSION_SECRET, "oasis-kiosk-code-key:v1"): 32 bytes. Production without SESSION_SECRET is refused. */
export function kioskKey(env: { NODE_ENV: string; SESSION_SECRET?: string }): Buffer {
  const secret = env.SESSION_SECRET
  if (!secret && env.NODE_ENV === 'production') throw new Error('SESSION_SECRET is required for the kiosk code key')
  return createHmac('sha256', secret || DEV_SESSION_SECRET)
    .update('oasis-kiosk-code-key:v1')
    .digest()
}

export class KioskCodeHasher {
  private readonly scrypt: PasswordHasher

  constructor(
    private readonly key: Buffer,
    params?: ScryptParams,
  ) {
    if (key.length !== 32) throw new Error('The kiosk code key must be 32 bytes')
    this.scrypt = new PasswordHasher(params)
  }

  /** HMAC(key, locationId:code): what scrypt hashes. Never stored, never logged. */
  private material(locationId: string, code: string): string {
    return createHmac('sha256', this.key).update(`${locationId}:${code}`).digest('base64url')
  }

  hash(locationId: string, code: string): Promise<string> {
    return this.scrypt.hash(this.material(locationId, code))
  }

  /** Constant-time comparison inside the scrypt hasher. */
  verify(locationId: string, code: string, stored: string): Promise<boolean> {
    return this.scrypt.verify(this.material(locationId, code), stored)
  }
}
