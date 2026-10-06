// Password hashing with node:crypto scrypt (no native dependency), stored as a PHC-style string so the algorithm and its
// cost travel with the hash and can be migrated:  $scrypt$ln=15,r=8,p=3$<salt b64>$<hash b64>
// Verification reads the parameters from the stored string (within sane bounds), so raising the defaults later only
// needs needsRehash() + a rewrite at the next successful login.
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'

export interface ScryptParams {
  /** log2 of the CPU/memory cost N. */
  ln: number
  r: number
  p: number
}

/** OWASP's scrypt guidance (N=2^15, r=8, p=3: 32 MiB per hash). */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { ln: 15, r: 8, p: 3 }
const KEY_LEN = 32
const SALT_LEN = 16
const MAX_LN = 20
const PREFIX = '$scrypt$'

const run = (password: string, salt: Buffer, keyLen: number, o: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(password.normalize('NFKC'), salt, keyLen, o, (e, key) => (e ? reject(e) : resolve(key))),
  )

const optionsOf = (p: ScryptParams): ScryptOptions => ({
  N: 2 ** p.ln,
  r: p.r,
  p: p.p,
  maxmem: 160 * 2 ** p.ln * p.r + 4 * 1024 * 1024,
})

export interface ParsedHash {
  params: ScryptParams
  salt: Buffer
  hash: Buffer
}

export function parseHash(stored: string): ParsedHash | null {
  if (!stored.startsWith(PREFIX)) return null
  const [, , paramText, saltB64, hashB64, ...rest] = stored.split('$')
  if (rest.length || !paramText || !saltB64 || !hashB64) return null
  const m = /^ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})$/.exec(paramText)
  if (!m) return null
  const params = { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) }
  if (params.ln < 4 || params.ln > MAX_LN || params.r < 1 || params.r > 16 || params.p < 1 || params.p > 16)
    return null
  const salt = Buffer.from(saltB64, 'base64')
  const hash = Buffer.from(hashB64, 'base64')
  if (salt.length < 8 || hash.length < 16) return null
  return { params, salt, hash }
}

export class PasswordHasher {
  constructor(readonly params: ScryptParams = DEFAULT_SCRYPT_PARAMS) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LEN)
    const key = await run(password, salt, KEY_LEN, optionsOf(this.params))
    const { ln, r, p } = this.params
    return `${PREFIX}ln=${ln},r=${r},p=${p}$${salt.toString('base64')}$${key.toString('base64')}`
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parseHash(stored)
    if (!parsed) return false
    const key = await run(password, parsed.salt, parsed.hash.length, optionsOf(parsed.params))
    return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash)
  }

  /** True when the stored hash uses another algorithm or weaker/different cost than the current parameters. */
  needsRehash(stored: string): boolean {
    const parsed = parseHash(stored)
    if (!parsed) return true
    const { ln, r, p } = parsed.params
    return ln !== this.params.ln || r !== this.params.r || p !== this.params.p
  }

  /** Burns the same work as a real verification so an unknown account cannot be told apart by response time. */
  async dummyVerify(password: string): Promise<void> {
    if (!this.dummy) this.dummy = this.hash('oasis-dummy-password')
    await this.verify(password, await this.dummy)
  }
  private dummy: Promise<string> | undefined
}

export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 128

/** Returns an error message, or null when the password is acceptable. */
export function passwordProblem(password: string, context: { email?: string | null } = {}): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`
  if (context.email && password.toLowerCase() === context.email.toLowerCase())
    return 'The password cannot be your email address.'
  if (/^(.)\1+$/.test(password)) return 'Choose a less repetitive password.'
  return null
}
