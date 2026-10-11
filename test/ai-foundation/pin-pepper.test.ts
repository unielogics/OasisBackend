// PIN_PEPPER, the HMAC key of the website PINs (ADR 0160): in production it must come from the Secrets Manager secret and from
// nowhere else (an env file or a variable set before the secret is read would keep it on disk next to the database credentials),
// and it must decode (base64, base64url or hex, as gen-secrets.sh may emit) to exactly 32 bytes. Outside production a fixed
// development value stands in, but only while personal links are off. The loader reports which keys the secret supplied; the real
// API process is started to prove the refusal, against a local Secrets Manager endpoint.
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEV_PIN_PEPPER, decodePinPepper, loadEnv } from '../../src/config/env.js'
import { applySecretEnvironment, loadRuntimeEnv, secretKeysOf } from '../../src/config/secrets-source.js'
import { sh, tempDir } from '../ops-kit/deploy-helpers.js'
import { FakeSecretsHttp } from '../aws/helpers/fake-secrets-http.js'

const DB = 'postgres://oasis:x@127.0.0.1:5432/oasis'
const base = { DATABASE_URL: DB }
const prod = {
  ...base,
  NODE_ENV: 'production',
  SESSION_SECRET: 'x'.repeat(48),
  COOKIE_SECURE: 'true',
  SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  PUBLIC_API_URL: 'https://app.example.com',
  PUBLIC_DASHBOARD_URL: 'https://app.example.com',
}
const bytes = randomBytes(32)
const PEPPER = bytes.toString('base64')

/** A Secrets Manager client stub that returns this document. */
const secretClient = (doc: Record<string, string>) => () => ({ send: async () => ({ SecretString: JSON.stringify(doc) }) }) as never
const withSecret = (env: Record<string, string>, doc: Record<string, string>) => {
  const e: NodeJS.ProcessEnv = { OASIS_SECRET_ID: 'oasis/prod/app', AWS_REGION: 'us-east-1', ...env }
  return { env: e, client: secretClient(doc), log: () => undefined }
}

describe('PIN_PEPPER format', () => {
  it('decodes base64, base64url (padded or not) and hex to exactly 32 bytes; anything else is refused', () => {
    expect(decodePinPepper(bytes.toString('base64'))).toEqual(bytes)
    expect(decodePinPepper(bytes.toString('base64url'))).toEqual(bytes)
    expect(decodePinPepper(`${bytes.toString('base64url')}=`)).toEqual(bytes)
    expect(decodePinPepper(bytes.toString('hex'))).toEqual(bytes)
    expect(decodePinPepper(bytes.toString('hex').toUpperCase())).toEqual(bytes)
    for (const bad of [
      randomBytes(31).toString('base64'),
      randomBytes(33).toString('base64'),
      randomBytes(24).toString('base64'), // 32 characters, 24 bytes: long enough for the old min(32), not a 32-byte key
      randomBytes(31).toString('hex'),
      'x'.repeat(44),
      `${PEPPER} `,
      `${bytes.toString('base64').slice(0, 43)}!`,
      '',
    ])
      expect(decodePinPepper(bad), bad).toBeNull()
    expect(() => loadEnv({ ...base, PIN_PEPPER: randomBytes(24).toString('base64') })).toThrow(/PIN_PEPPER: must decode .* to exactly 32 bytes/)
    expect(loadEnv({ ...base, PIN_PEPPER: bytes.toString('hex') }).PIN_PEPPER).toBe(bytes.toString('hex'))
  })
})

describe('outside production', () => {
  it('a development pepper stands in only while personal links are off', () => {
    expect(loadEnv(base).PIN_PEPPER).toBe(DEV_PIN_PEPPER)
    expect(decodePinPepper(DEV_PIN_PEPPER)).toHaveLength(32)
    expect(loadEnv({ ...base, NODE_ENV: 'test' }).PIN_PEPPER).toBe(DEV_PIN_PEPPER)
    expect(() => loadEnv({ ...base, PUBLIC_LINKS_ENABLED: 'true' })).toThrow(/PIN_PEPPER: required when PUBLIC_LINKS_ENABLED=true/)
    expect(loadEnv({ ...base, PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER }).PIN_PEPPER).toBe(PEPPER)
    // a plain variable is fine outside production
    expect(loadEnv({ ...base, PIN_PEPPER: PEPPER }).PIN_PEPPER).toBe(PEPPER)
  })
})

describe('production', () => {
  it('without the secret: a pepper in the environment is refused, and links cannot open without one', () => {
    expect(() => loadEnv({ ...prod, PIN_PEPPER: PEPPER })).toThrow(/PIN_PEPPER: must come from the Secrets Manager secret/)
    expect(() => loadEnv({ ...prod, PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER })).toThrow(/PIN_PEPPER: must come from the Secrets Manager secret/)
    expect(() => loadEnv({ ...prod, PUBLIC_LINKS_ENABLED: 'true' })).toThrow(/PIN_PEPPER: required in production when PUBLIC_LINKS_ENABLED=true/)
    // no development stand-in in production: links off and no pepper leaves it unset
    expect(loadEnv(prod).PIN_PEPPER).toBeUndefined()
  })

  it('the loader reports what the secret supplied; a pepper from the secret is accepted', async () => {
    const o = withSecret({ ...prod, PUBLIC_LINKS_ENABLED: 'true' }, { PIN_PEPPER: PEPPER, SESSION_SECRET: 'y'.repeat(48) })
    const r = await applySecretEnvironment(o)
    expect(r.filled).toEqual(['PIN_PEPPER'])
    expect(r.kept).toEqual(['SESSION_SECRET'])
    expect([...secretKeysOf(o.env)]).toEqual(['PIN_PEPPER'])
    expect(loadEnv(o.env).PIN_PEPPER).toBe(PEPPER)
    // a later loadEnv() on the same environment (job handlers do that) and a second loader run both still see it as the secret's
    await applySecretEnvironment(o)
    expect([...secretKeysOf(o.env)]).toEqual(['PIN_PEPPER'])
    expect(loadEnv(o.env).PUBLIC_LINKS_ENABLED).toBe(true)
    // a copy of the environment carries no record unless it is passed on
    expect(() => loadEnv({ ...o.env })).toThrow(/PIN_PEPPER: must come from the Secrets Manager secret/)
    expect(loadEnv({ ...o.env }, { secretKeys: secretKeysOf(o.env) }).PIN_PEPPER).toBe(PEPPER)
  })

  it('refuses a pepper that an env file (the process environment) set before the secret was read, even if the secret has one', async () => {
    const other = randomBytes(32).toString('base64')
    await expect(loadRuntimeEnv(withSecret({ ...prod, PIN_PEPPER: other }, { PIN_PEPPER: PEPPER }))).rejects.toThrow(
      /PIN_PEPPER: must come from the Secrets Manager secret/,
    )
    await expect(loadRuntimeEnv(withSecret({ ...prod, PIN_PEPPER: PEPPER }, { PIN_PEPPER: PEPPER }))).rejects.toThrow(
      /PIN_PEPPER: must come from the Secrets Manager secret/,
    )
    await expect(loadRuntimeEnv(withSecret({ ...prod, PUBLIC_LINKS_ENABLED: 'true' }, {}))).rejects.toThrow(/PIN_PEPPER: required in production/)
    // changed in the process after the secret filled it: no longer the secret's value
    const o = withSecret(prod, { PIN_PEPPER: PEPPER })
    await applySecretEnvironment(o)
    o.env.PIN_PEPPER = other
    expect(() => loadEnv(o.env)).toThrow(/PIN_PEPPER: must come from the Secrets Manager secret/)
  })

  it('refuses a pepper from the secret that is not 32 bytes', async () => {
    await expect(loadRuntimeEnv(withSecret(prod, { PIN_PEPPER: randomBytes(16).toString('hex') }))).rejects.toThrow(/PIN_PEPPER: must decode/)
  })
})

describe('the API process refuses to start (local Secrets Manager endpoint)', () => {
  const sm = new FakeSecretsHttp()
  let aws: Record<string, string>
  const dir = tempDir('oasis-pepper-')
  const TSX = path.join(process.cwd(), 'node_modules/.bin/tsx')
  // nothing listens on port 1: an API that got past its environment fails on the database, a different error
  const env = {
    ...prod,
    DATABASE_URL: 'postgres://oasis:x@127.0.0.1:1/oasis',
    DATABASE_URL_TEST: undefined,
    PORT: '4087',
    PUBLIC_LINKS_ENABLED: 'true',
    OASIS_SECRET_ID: 'oasis/test/pepper',
  }

  beforeAll(async () => {
    aws = await sm.start()
    sm.secrets.set('oasis/test/pepper', JSON.stringify({ PIN_PEPPER: PEPPER }))
    sm.secrets.set('oasis/test/none', JSON.stringify({}))
  })
  afterAll(async () => {
    await sm.stop()
    dir.cleanup()
  })

  const start = (over: Record<string, string | undefined>) =>
    sh(TSX, [path.join(process.cwd(), 'src/server.ts')], { ...aws, ...env, ...over }, undefined, dir.dir)

  it('with PIN_PEPPER in its environment file, with it nowhere, and with a short one', async () => {
    const fromFile = await start({ PIN_PEPPER: PEPPER })
    expect(fromFile.code).not.toBe(0)
    expect(fromFile.out).toContain('PIN_PEPPER: must come from the Secrets Manager secret')
    expect(fromFile.out).not.toContain(PEPPER)
    const nowhere = await start({ OASIS_SECRET_ID: 'oasis/test/none' })
    expect(nowhere.code).not.toBe(0)
    expect(nowhere.out).toContain('PIN_PEPPER: required in production when PUBLIC_LINKS_ENABLED=true')
    sm.secrets.set('oasis/test/short', JSON.stringify({ PIN_PEPPER: randomBytes(24).toString('base64') }))
    const short = await start({ OASIS_SECRET_ID: 'oasis/test/short' })
    expect(short.code).not.toBe(0)
    expect(short.out).toContain('PIN_PEPPER: must decode')
  })

  it('and gets past its environment with the pepper from the secret alone (then fails on the absent database)', async () => {
    const r = await start({})
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('environment: 1 setting(s) from Secrets Manager secret oasis/test/pepper')
    expect(r.out).not.toContain('Invalid environment')
    expect(r.out).toMatch(/ECONNREFUSED|connect/i)
    expect(r.out).not.toContain(PEPPER)
  })
})
