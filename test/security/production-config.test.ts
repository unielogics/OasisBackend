// Adversarial review (rv/sec): what does a production boot insist on? A deployment that forgets one variable must fail to
// start, not run with a cookie that travels over HTTP or credentials sealed with a key that is not secret.
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { createSecretBox } from '../../src/modules/messaging/crypto.js'

const secure = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x',
  NODE_ENV: 'production',
  SESSION_SECRET: 's'.repeat(40),
  COOKIE_SECURE: 'true',
  SECRETS_KEY: Buffer.alloc(32, 9).toString('base64'),
  PUBLIC_DASHBOARD_URL: 'https://app.oasis.test',
  PUBLIC_API_URL: 'https://app.oasis.test',
}

describe('SEC-06 production configuration', () => {
  it('boots with a complete, secure configuration', () => {
    expect(() => loadEnv(secure)).not.toThrow()
  })

  it.each([
    ['COOKIE_SECURE', { COOKIE_SECURE: 'false' }],
    ['COOKIE_SECURE', { COOKIE_SECURE: undefined }],
    ['SECRETS_KEY', { SECRETS_KEY: undefined }],
    ['SECRETS_KEY', { SECRETS_KEY: Buffer.alloc(16, 1).toString('base64') }],
    ['PUBLIC_DASHBOARD_URL', { PUBLIC_DASHBOARD_URL: 'http://app.oasis.test' }],
    ['PUBLIC_API_URL', { PUBLIC_API_URL: undefined }],
  ])('refuses to boot when %s is wrong', (name, override) => {
    expect(() => loadEnv({ ...secure, ...override })).toThrow(new RegExp(name))
  })

  it('refuses to boot with the dev endpoints on (they inject inbound texts as any phone number)', () => {
    expect(() => loadEnv({ ...secure, ALLOW_DEV_ENDPOINTS: 'true' })).toThrow(/ALLOW_DEV_ENDPOINTS/)
    expect(() => loadEnv({ DATABASE_URL: secure.DATABASE_URL, ALLOW_DEV_ENDPOINTS: 'true' })).not.toThrow()
  })

  it('never serves the sign-in bypass (everyone is a Super Admin) on an address other machines can reach', () => {
    const dev = { DATABASE_URL: secure.DATABASE_URL, DEV_AUTH_BYPASS: 'true' }
    expect(() => loadEnv({ ...dev, HOST: '0.0.0.0' })).toThrow(/DEV_AUTH_BYPASS/)
    expect(() => loadEnv({ ...dev, HOST: '10.0.0.5' })).toThrow(/DEV_AUTH_BYPASS/)
    expect(() => loadEnv({ ...dev, HOST: '127.0.0.1' })).not.toThrow()
    expect(() => loadEnv({ ...dev, HOST: 'localhost' })).not.toThrow()
    expect(() => loadEnv({ ...dev, HOST: '::1' })).not.toThrow()
    expect(() => loadEnv({ ...dev })).not.toThrow() // HOST defaults to loopback
  })

  it('development keeps working without any of them', () => {
    expect(() => loadEnv({ DATABASE_URL: secure.DATABASE_URL })).not.toThrow()
  })

  it('seals credentials with the fixed development key only outside production', () => {
    const sealedByDev = createSecretBox(undefined, 'development').encrypt('hunter2')
    expect(() => createSecretBox(undefined, 'production').decrypt(sealedByDev)).toThrow(/SECRETS_KEY/)
  })
})
