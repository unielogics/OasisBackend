// The environment loader (src/config/secrets-source.ts): the secret named by OASIS_SECRET_ID fills what the process environment does
// not set, every malformed secret and every AWS refusal fails with one clear line, and no value of the secret ever reaches a log
// line or an error message. The AWS side is the real SecretsManagerClient with its transport mocked (aws-sdk-client-mock).
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { mockClient } from 'aws-sdk-client-mock'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import {
  FORBIDDEN_SECRET_KEYS,
  SECRET_KEYS,
  SecretSourceError,
  applySecretEnvironment,
  loadRuntimeEnv,
  parseSecretDocument,
  secretKeyProblems,
} from '../../src/config/secrets-source.js'

const DB = 'postgres://oasis:Sup3rS3cretDbPw@127.0.0.1:5432/oasis'
const SESSION = 'session-secret-value-0123456789abcdefghijklmnop'
const SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')
const VALUES = [DB, SESSION, SECRETS_KEY, 'Sup3rS3cretDbPw']

const awsError = (name: string, status: number, message = name): Error =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status }, $fault: 'client' })

const mockSm = () => mockClient(SecretsManagerClient)
let sm: ReturnType<typeof mockSm>
const lines: string[] = []
const writes: string[] = []
interface Restorable {
  mockRestore(): void
}
let stderr: Restorable
let stdout: Restorable
const consoleSpies: Restorable[] = []

beforeAll(() => {
  process.env.AWS_EC2_METADATA_DISABLED = 'true'
})
afterAll(() => {
  delete process.env.AWS_EC2_METADATA_DISABLED
})
beforeEach(() => {
  sm = mockSm()
  sm.onAnyCommand().rejects(new Error('not modelled'))
  lines.length = 0
  writes.length = 0
  // capture everything a process could print: both streams and every console method
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => (writes.push(String(c)), true))
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => (writes.push(String(c)), true))
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    consoleSpies.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void writes.push(a.map(String).join(' '))))
})
afterEach(() => {
  // nothing printed, logged or thrown in any test may contain a value of the secret
  const everything = [...writes, ...lines].join('\n')
  for (const v of VALUES) expect(everything).not.toContain(v)
  sm.restore()
  stderr.mockRestore()
  stdout.mockRestore()
  for (const s of consoleSpies.splice(0)) s.mockRestore()
})

const secret = (doc: unknown) => sm.on(GetSecretValueCommand).resolves({ Name: 'oasis/prod/app', SecretString: typeof doc === 'string' ? doc : JSON.stringify(doc) })
const base = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({ OASIS_SECRET_ID: 'oasis/prod/app', AWS_REGION: 'us-east-1', ...over })
const run = (env: NodeJS.ProcessEnv) => applySecretEnvironment({ env, log: (l) => lines.push(l) })

/** Runs, expects a SecretSourceError, and checks that its message carries no value. */
async function failure(env: NodeJS.ProcessEnv): Promise<string> {
  const e = await run(env).then(
    () => undefined,
    (x: unknown) => x,
  )
  expect(e).toBeInstanceOf(SecretSourceError)
  const msg = (e as Error).message
  lines.push(msg, String((e as Error).stack))
  return msg
}

describe('without OASIS_SECRET_ID', () => {
  it('fetches nothing, changes nothing, and loadRuntimeEnv is loadEnv', async () => {
    const env = { DATABASE_URL: DB, NODE_ENV: 'test' }
    expect(await run(env)).toEqual({ filled: [], kept: [] })
    expect(env).toEqual({ DATABASE_URL: DB, NODE_ENV: 'test' })
    expect(await loadRuntimeEnv({ env })).toEqual(loadEnv(env))
    expect(sm.calls()).toHaveLength(0)
    expect(lines).toEqual([])
  })

  it('treats a blank OASIS_SECRET_ID as unset', async () => {
    expect(await run({ OASIS_SECRET_ID: '  ' })).toEqual({ filled: [], kept: [] })
    expect(sm.calls()).toHaveLength(0)
  })
})

describe('with OASIS_SECRET_ID', () => {
  it('fetches the secret once, by its id, in AWS_REGION, with the default credential chain', async () => {
    secret({ DATABASE_URL: DB })
    const env = base({ AWS_REGION: 'us-west-2' })
    await applySecretEnvironment({ env, log: (l) => lines.push(l) })
    expect(sm.commandCalls(GetSecretValueCommand)).toHaveLength(1)
    expect(sm.commandCalls(GetSecretValueCommand)[0]!.args[0].input).toEqual({ SecretId: 'oasis/prod/app' })
    const client = sm.commandCalls(GetSecretValueCommand)[0]!.thisValue as SecretsManagerClient
    expect(await client.config.region()).toBe('us-west-2')
    // no static credentials were configured: the SDK's default chain (instance role, AWS_SHARED_CREDENTIALS_FILE, AWS_PROFILE) decides
    expect((client.config as unknown as { credentials?: unknown }).credentials).toBeTypeOf('function')
  })

  it('fills only the keys the process environment does not set; set values win, empty values count as unset', async () => {
    secret({ DATABASE_URL: DB, SESSION_SECRET: SESSION, SECRETS_KEY, LOG_LEVEL: 'debug', BUSINESS_PHONE: '(305) 555-0100' })
    const env = base({ LOG_LEVEL: 'warn', SESSION_SECRET: '' })
    const r = await run(env)
    expect(r).toEqual({ secretId: 'oasis/prod/app', filled: ['BUSINESS_PHONE', 'DATABASE_URL', 'SECRETS_KEY', 'SESSION_SECRET'], kept: ['LOG_LEVEL'] })
    expect(env.LOG_LEVEL).toBe('warn')
    expect(env.DATABASE_URL).toBe(DB)
    expect(env.SESSION_SECRET).toBe(SESSION)
    expect(lines).toEqual([
      'environment: 4 setting(s) from Secrets Manager secret oasis/prod/app (us-east-1); set in the process environment and kept: LOG_LEVEL',
    ])
  })

  it('fills process.env itself by default, so modules that call loadEnv() later (job handlers) see the same values', async () => {
    secret({ SMSGATE_WEBHOOK_SECRET: 'whsec-from-secret' })
    const saved = { id: process.env.OASIS_SECRET_ID, region: process.env.AWS_REGION, wh: process.env.SMSGATE_WEBHOOK_SECRET }
    process.env.OASIS_SECRET_ID = 'oasis/prod/app'
    process.env.AWS_REGION = 'us-east-1'
    delete process.env.SMSGATE_WEBHOOK_SECRET
    try {
      await applySecretEnvironment({ log: (l) => lines.push(l) })
      expect(process.env.SMSGATE_WEBHOOK_SECRET).toBe('whsec-from-secret')
    } finally {
      for (const [k, v] of [['OASIS_SECRET_ID', saved.id], ['AWS_REGION', saved.region], ['SMSGATE_WEBHOOK_SECRET', saved.wh]] as const)
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
    }
  })

  it('loadRuntimeEnv validates the merged environment the way loadEnv does', async () => {
    secret({ DATABASE_URL: DB, SESSION_SECRET: SESSION, SECRETS_KEY })
    const env = await loadRuntimeEnv({
      env: base({ NODE_ENV: 'production', COOKIE_SECURE: 'true', PUBLIC_API_URL: 'https://oasis.example.com', PUBLIC_DASHBOARD_URL: 'https://oasis.example.com' }),
      log: (l) => lines.push(l),
    })
    expect(env.DATABASE_URL).toBe(DB)
    expect(env.OASIS_SECRET_ID).toBe('oasis/prod/app')
    // a secret without SESSION_SECRET leaves production invalid, and the message names the key only
    secret({ DATABASE_URL: DB, SECRETS_KEY })
    const e = await loadRuntimeEnv({ env: base({ NODE_ENV: 'production', COOKIE_SECURE: 'true' }), log: (l) => lines.push(l) }).catch((x: Error) => x)
    expect((e as Error).message).toMatch(/SESSION_SECRET: required in production/)
    lines.push((e as Error).message)
  })

  it('needs AWS_REGION next to it, and a plausible id', async () => {
    expect(await failure(base({ AWS_REGION: undefined }))).toBe('OASIS_SECRET_ID is set but AWS_REGION is not: set both in /etc/oasis/common.env')
    expect(await failure(base({ OASIS_SECRET_ID: 'oasis prod' }))).toBe('OASIS_SECRET_ID is not a secret name or ARN')
    expect(sm.calls()).toHaveLength(0)
  })
})

describe('every failure is one clear line, without a value', () => {
  it.each([
    ['ResourceNotFoundException', 400, /^secret "oasis\/prod\/app" in us-east-1 does not exist: create it with pnpm aws:provision --apply/],
    ['AccessDeniedException', 400, /^access denied reading secret "oasis\/prod\/app" in us-east-1: the runtime identity needs secretsmanager:GetSecretValue on it/],
    ['DecryptionFailure', 400, /cannot be decrypted with this identity's KMS rights/],
    ['CredentialsProviderError', 0, /^no AWS credentials to read secret "oasis\/prod\/app" in us-east-1: on EC2 associate the instance profile oasis-app-profile/],
    ['InternalServiceError', 500, /^could not read secret "oasis\/prod\/app" in us-east-1: InternalServiceError/],
  ])('%s', async (name, status, re) => {
    sm.on(GetSecretValueCommand).rejects(awsError(name, status))
    expect(await failure(base())).toMatch(re)
  })

  it('a secret scheduled for deletion says how to restore it', async () => {
    sm.on(GetSecretValueCommand).rejects(awsError('InvalidRequestException', 400, 'You can not perform this operation on a secret that is marked for deletion.'))
    expect(await failure(base())).toMatch(/is scheduled for deletion: restore it/)
  })

  it('binary secrets, text that is not JSON, and JSON that is not an object', async () => {
    sm.on(GetSecretValueCommand).resolves({ SecretBinary: new Uint8Array([1, 2, 3]) })
    expect(await failure(base())).toMatch(/has no string value \(binary secrets are not supported\)/)
    // JSON.parse would quote the text in its message; the loader must not
    secret(`DATABASE_URL=${DB}`)
    expect(await failure(base())).toBe('secret "oasis/prod/app" is not JSON: store a JSON object of NAME -> string value (pnpm secrets:push does)')
    secret(`{"DATABASE_URL": "${DB}",}`)
    expect(await failure(base())).toMatch(/is not JSON/)
    for (const [doc, what] of [['[1]', 'an array'], ['null', 'null'], ['42', 'a number'], [`"${DB}"`, 'a string']] as const) {
      secret(doc)
      expect(await failure(base())).toBe(`secret "oasis/prod/app" must be a JSON object of NAME -> string value, not ${what}`)
    }
  })

  it('values that are not strings are named by key and type only', async () => {
    secret({ DATABASE_URL: DB, DB_POOL_MAX: 10, JOBS_ENABLED: true, SESSION_SECRET: { v: SESSION }, SECRETS_KEY: null, SMS_ALLOWLIST: [SESSION] })
    expect(await failure(base())).toBe(
      'secret "oasis/prod/app": every value must be a string; these are not: DB_POOL_MAX (number), JOBS_ENABLED (boolean), SECRETS_KEY (null), SESSION_SECRET (object), SMS_ALLOWLIST (array)',
    )
  })

  it('keys the environment contract does not declare are refused, and so are keys that must not live in a secret', async () => {
    secret({ DATABASE_URL: DB, DATABSE_URL: DB, NODE_OPTIONS: '--max-old-space-size=768' })
    expect(await failure(base())).toBe(
      'secret "oasis/prod/app" holds keys the environment contract (src/config/env.ts) does not declare: DATABSE_URL, NODE_OPTIONS; remove them with pnpm secrets:push --remove',
    )
    secret({ DATABASE_URL: DB, OASIS_SECRET_ID: 'other', AWS_SECRET_ACCESS_KEY: SESSION, AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE' })
    expect(await failure(base())).toBe(
      'secret "oasis/prod/app" holds keys that must not live there: AWS_ACCESS_KEY_ID (is an AWS credential (use the instance role, or /etc/oasis/aws-credentials)), AWS_SECRET_ACCESS_KEY (is an AWS credential (use the instance role, or /etc/oasis/aws-credentials)), OASIS_SECRET_ID (names the secret itself)',
    )
  })

  it('nothing is filled when the secret is refused', async () => {
    secret({ DATABASE_URL: DB, NOT_A_SETTING: 'x' })
    const env = base()
    await failure(env)
    expect(env.DATABASE_URL).toBeUndefined()
  })
})

describe('the key lists', () => {
  it('every secret key is a declared setting, none is forbidden, and the forbidden ones are what reaches the secret', () => {
    expect(secretKeyProblems(SECRET_KEYS)).toEqual({ forbidden: [], unknown: [] })
    expect(Object.keys(FORBIDDEN_SECRET_KEYS).sort()).toEqual(
      ['AWS_ACCESS_KEY_ID', 'AWS_EC2_METADATA_DISABLED', 'AWS_PROFILE', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SHARED_CREDENTIALS_FILE', 'OASIS_SECRET_ID'],
    )
    expect(parseSecretDocument('{}', 'x')).toEqual({})
  })
})
