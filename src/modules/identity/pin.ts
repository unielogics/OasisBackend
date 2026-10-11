// The client's website PIN (ADR 0160, design section 5): the shape and blocklist a new PIN must pass, and its hash. The stored hash is
// scrypt (src/modules/auth/password.ts, its PHC-style string) over HMAC-SHA256(PIN_PEPPER, "<customerId>:<pin>"): the pepper lives
// only in the Secrets Manager secret, so a database copy alone cannot be brute-forced over the 10^4..10^6 PIN space, and binding
// the customer id makes equal PINs of two clients hash apart and a hash useless on another row. Verification always does the same
// scrypt work: against a dummy hash of the same cost when the client has no PIN, so the time never tells whether one exists.
import { createHmac } from 'node:crypto'
import { decodePinPepper } from '../../config/env.js'
import { PasswordHasher, type ScryptParams } from '../auth/password.js'

export const PIN_MIN_LENGTH = 4
export const PIN_MAX_LENGTH = 6
const PIN_SHAPE = /^\d{4,6}$/

/**
 * The most common 4-digit PINs (the published PIN-frequency studies: the top of the list is 1234, 1111, 0000, 1212, 7777, ...).
 * Runs, repeats and years are refused by rule as well, whatever their length.
 */
export const COMMON_PINS: ReadonlySet<string> = new Set(
  (
    '1234 1111 0000 1212 7777 1004 2000 4444 2222 6969 9999 3333 5555 6666 1122 1313 8888 4321 2001 1010 ' +
    '2580 0852 1123 1231 1984 1986 2468 1357 0123 1239 1000 1020 2121 4545 5150 1515 1414 2020 2525 3636 ' +
    '0007 0101 0911 1001 1101 1200 1221 1225 1269 1324 1342 1369 1478 1590 1597 1701 1776 1818 1919 1999 ' +
    '2002 2011 2112 2211 2323 2345 2424 2512 2727 3000 3131 3232 3434 3456 3535 3690 4040 4200 4242 4567 ' +
    '5252 5678 6262 6789 7007 7070 7272 7410 7531 7676 7890 8008 8520 8642 9090 9191 9696 9876 0258 0369 ' +
    '1029 1210 0420 0069 1066 1945 0001 0007 2580 1470'
  ).split(' '),
)

/** Every digit one more (or one less) than the one before, wrapping 9 to 0: 1234, 456789, 7890, 3210, 0987. */
function isRun(pin: string): boolean {
  const d = [...pin].map(Number)
  const step = (d[1]! - d[0]! + 10) % 10
  if (step !== 1 && step !== 9) return false
  return d.every((x, i) => i === 0 || (x - d[i - 1]! + 10) % 10 === step)
}

/**
 * Why `pin` cannot be a PIN, or null when it can: 4 to 6 digits; not all one digit, not a run, not a common PIN, not a year from
 * 1940 to 2015, not the last digits of the client's own number (as many as the PIN has).
 */
export function pinProblem(pin: string, ownPhone: string | null): string | null {
  if (!PIN_SHAPE.test(pin)) return `Use ${PIN_MIN_LENGTH} to ${PIN_MAX_LENGTH} digits.`
  if (/^(\d)\1+$/.test(pin)) return 'Don’t use one digit over and over.'
  if (isRun(pin)) return 'Don’t use digits in a row like 1234.'
  if (COMMON_PINS.has(pin)) return 'That PIN is too common. Choose another.'
  if (pin.length === 4 && Number(pin) >= 1940 && Number(pin) <= 2015) return 'Don’t use a year. Choose another PIN.'
  const digits = (ownPhone ?? '').replace(/\D/g, '')
  if (digits.length >= pin.length && digits.endsWith(pin)) return 'Don’t use the end of your phone number.'
  return null
}

/** The PIN hasher of the process: scrypt over the peppered HMAC, and the same work for a client without a PIN. */
export class PinHasher {
  private readonly scrypt: PasswordHasher

  constructor(
    private readonly pepper: Buffer,
    params?: ScryptParams,
  ) {
    if (pepper.length !== 32) throw new Error('PIN pepper must be 32 bytes')
    this.scrypt = new PasswordHasher(params)
  }

  /** HMAC(pepper, customerId:pin): what scrypt hashes. Never stored, never logged. */
  private material(customerId: string, pin: string): string {
    return createHmac('sha256', this.pepper).update(`${customerId}:${pin}`).digest('base64url')
  }

  hash(customerId: string, pin: string): Promise<string> {
    return this.scrypt.hash(this.material(customerId, pin))
  }

  /** Compares in constant time (timingSafeEqual inside the scrypt hasher). */
  verify(customerId: string, pin: string, stored: string): Promise<boolean> {
    return this.scrypt.verify(this.material(customerId, pin), stored)
  }

  /** The same HMAC and scrypt work as verify(), against a dummy hash of the same cost; always false. */
  async verifyNone(customerId: string, pin: string): Promise<false> {
    await this.scrypt.dummyVerify(this.material(customerId, pin))
    return false
  }
}

/** The hasher for the environment's PIN_PEPPER (loadEnv supplies a fixed development value while links are off outside production). */
export function pinHasherFromEnv(env: { PIN_PEPPER?: string | undefined }, params?: ScryptParams): PinHasher {
  const key = env.PIN_PEPPER ? decodePinPepper(env.PIN_PEPPER) : null
  if (!key) throw new Error('PIN_PEPPER is not configured (32 bytes: gen-secrets.sh PIN_PEPPER, in the Secrets Manager secret)')
  return new PinHasher(key, params)
}
