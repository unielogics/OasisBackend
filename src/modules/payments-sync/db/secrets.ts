// Integration credentials at rest: AES-256-GCM with the SECRETS_KEY (base64, 32 bytes). The stored form is
// "<key id>:<iv>:<tag>:<ciphertext>" (all base64url) so the key can be rotated later without losing old rows: the key id is
// the first 8 hex characters of the key's SHA-256, and decrypt names the key that is missing instead of failing opaquely.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { AppError } from '../../../platform/errors.js'

const ALGO = 'aes-256-gcm'
/** Node accepts a GCM tag of 4 to 16 bytes unless the length is pinned; a short tag is a guessable one. */
const TAG_BYTES = 16

export interface SecretBox {
  readonly keyId: string
  encrypt(plain: string): string
  decrypt(stored: string): string
}

export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8)
}

function parseKey(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64 encoded')
  return key
}

/** Several keys can be given (current first) to decrypt rows written before a rotation. */
export function createSecretBox(keys: readonly string[]): SecretBox {
  if (keys.length === 0) throw new Error('SECRETS_KEY is not configured')
  const parsed = keys.map(parseKey)
  const byId = new Map(parsed.map((k) => [keyIdOf(k), k]))
  const current = parsed[0]!
  const keyId = keyIdOf(current)
  return {
    keyId,
    encrypt(plain) {
      const iv = randomBytes(12)
      const cipher = createCipheriv(ALGO, current, iv)
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return [
        keyId,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        body.toString('base64url'),
      ].join(':')
    },
    decrypt(stored) {
      const [id, iv, tag, body] = stored.split(':')
      if (!id || !iv || !tag || body === undefined) throw new Error('malformed encrypted value')
      const key = byId.get(id)
      if (!key) throw new Error(`no SECRETS_KEY with id ${id} is configured`)
      const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64url'), { authTagLength: TAG_BYTES })
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString(
        'utf8',
      )
    },
  }
}

/** SECRETS_KEY from the environment, or a 503 that names the variable. */
export function secretBoxFromEnv(env: { SECRETS_KEY?: string | undefined }): SecretBox {
  if (!env.SECRETS_KEY) {
    throw new AppError('SERVICE_UNAVAILABLE', {
      detail: 'SECRETS_KEY is not configured, so integration credentials cannot be stored',
    })
  }
  return createSecretBox([env.SECRETS_KEY])
}
