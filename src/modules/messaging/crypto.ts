// Credentials at rest: AES-256-GCM with the key in SECRETS_KEY (base64, 32 bytes). Format `v1.<iv>.<tag>.<ciphertext>`,
// each part base64url. Outside production a missing key falls back to a fixed development key so a laptop works without
// setup; production refuses to encrypt or decrypt without a real key.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const PREFIX = 'v1'
const DEV_KEY = createHash('sha256').update('oasis-development-secrets-key').digest()

export interface SecretBox {
  encrypt(plain: string): string
  decrypt(sealed: string): string
}

export function keyFromEnv(secretsKey: string | undefined, nodeEnv: string): Buffer {
  if (!secretsKey) {
    if (nodeEnv === 'production')
      throw new Error('SECRETS_KEY is required in production to store device credentials')
    return DEV_KEY
  }
  const key = Buffer.from(secretsKey, 'base64')
  if (key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes, base64 encoded')
  return key
}

export function createSecretBox(secretsKey: string | undefined, nodeEnv: string): SecretBox {
  // Resolved on first use, so an app that never stores a credential (the OpenAPI build, a sim-only demo) boots without a key.
  let resolved: Buffer | undefined
  const keyOf = (): Buffer => (resolved ??= keyFromEnv(secretsKey, nodeEnv))
  return {
    encrypt(plain) {
      const key = keyOf()
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return [
        PREFIX,
        iv.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
        ct.toString('base64url'),
      ].join('.')
    },
    decrypt(sealed) {
      const key = keyOf()
      const [v, iv, tag, ct] = sealed.split('.')
      if (v !== PREFIX || !iv || !tag || !ct) throw new Error('Unrecognised secret format')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(tag, 'base64url'))
      return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
    },
  }
}
