// pnpm secrets:push: plan first, apply only with --apply, merge (never replace the whole secret), refuse what must not live in the
// secret, and never print a value. The AWS side is an in-memory secret store behind the real SDK clients (aws-sdk-client-mock).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { mockClient } from 'aws-sdk-client-mock'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { main, parseDotenv } from '../../scripts/secrets-push.js'

const ACCOUNT = '123456789012'
const DB = 'postgres://oasis:9f8e7d6c5b4a39281706f5e4d3c2b1a0@127.0.0.1:5432/oasis'
const SESSION = 'c2Vzc2lvbi1zZWNyZXQtdmFsdWUtMDEyMzQ1Njc4OWFiY2RlZmdoaWprbG1ub3A='
const SECRETS_KEY = Buffer.alloc(32, 9).toString('base64')
const NEW_SESSION = 'bmV3LXNlc3Npb24tc2VjcmV0LXZhbHVlLTAxMjM0NTY3ODlhYmNkZWZnaGlqa2xtbm9w'
const VALUES = [DB, SESSION, SECRETS_KEY, NEW_SESSION, '9f8e7d6c5b4a39281706f5e4d3c2b1a0', 'warnx']

const awsError = (name: string, status: number, message = name): Error =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode: status }, $fault: 'client' })

interface Stored {
  value?: string
  tags?: unknown
  deleted?: boolean
}
let store: Map<string, Stored>
const mockSm = () => mockClient(SecretsManagerClient)
const mockSts = () => mockClient(STSClient)
let sm: ReturnType<typeof mockSm>
let sts: ReturnType<typeof mockSts>
let dir: string
const outputs: string[] = []

beforeEach(() => {
  process.env.AWS_EC2_METADATA_DISABLED = 'true'
  dir = mkdtempSync(path.join(tmpdir(), 'oasis-push-'))
  store = new Map()
  sm = mockSm()
  sm.onAnyCommand().rejects(new Error('not modelled'))
  const get = (id: unknown): Stored => {
    const s = store.get(String(id))
    if (!s) throw awsError('ResourceNotFoundException', 400, "Secrets Manager can't find the specified secret.")
    return s
  }
  sm.on(DescribeSecretCommand).callsFake((i: { SecretId: string }) => {
    const s = get(i.SecretId)
    return { ARN: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:${i.SecretId}-AbCdEf`, Name: i.SecretId, ...(s.deleted ? { DeletedDate: new Date(0) } : {}) }
  })
  sm.on(GetSecretValueCommand).callsFake((i: { SecretId: string }) => {
    const s = get(i.SecretId)
    if (s.value === undefined) throw awsError('ResourceNotFoundException', 400, "Secrets Manager can't find the specified secret value for staging label: AWSCURRENT")
    return { SecretString: s.value }
  })
  sm.on(PutSecretValueCommand).callsFake((i: { SecretId: string; SecretString: string }) => {
    get(i.SecretId).value = i.SecretString
    return { VersionId: 'v2' }
  })
  sm.on(CreateSecretCommand).callsFake((i: { Name: string; SecretString: string; Tags: unknown; KmsKeyId?: string }) => {
    if (store.has(i.Name)) throw awsError('ResourceExistsException', 400)
    expect(i.KmsKeyId).toBeUndefined() // the AWS-managed key aws/secretsmanager
    store.set(i.Name, { value: i.SecretString, tags: i.Tags })
    return { Name: i.Name }
  })
  sts = mockSts()
  sts.on(GetCallerIdentityCommand).resolves({ Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:user/oasis-admin` })
})
afterEach(() => {
  const all = outputs.join('\n')
  for (const v of VALUES) expect(all).not.toContain(v)
  outputs.length = 0
  sm.restore()
  sts.restore()
  rmSync(dir, { recursive: true, force: true })
})

let built = 0
async function run(args: string[], env: Record<string, string | undefined> = {}) {
  const lines: string[] = []
  built = 0
  const code = await main(args, {
    env,
    log: (l) => lines.push(l),
    clients: (cfg) => {
      built++
      expect(cfg.region).toBe('us-east-1')
      return { sm: new SecretsManagerClient({ region: cfg.region }), sts: new STSClient({ region: cfg.region }) }
    },
  })
  const out = lines.join('\n')
  outputs.push(out)
  return { code, out }
}

const file = (name: string, text: string, mode = 0o600): string => {
  const p = path.join(dir, name)
  writeFileSync(p, text)
  chmodSync(p, mode)
  return p
}
const ID = ['--profile', 'oasis-admin', '--secret-id', 'oasis/prod/app']
const mutations = () => sm.calls().filter((c: { args: unknown[] }) => /^(Put|Create)/.test((c.args[0] as { constructor: { name: string } }).constructor.name))
const stored = (id = 'oasis/prod/app') => JSON.parse(store.get(id)!.value!) as Record<string, string>

describe('refusals', () => {
  it('needs credentials chosen on purpose, never both, and never builds a client otherwise', async () => {
    const f = file('s.env', `DATABASE_URL=${DB}\n`)
    let r = await run(['--secret-id', 'oasis/prod/app', '--from', f])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/refusing to run without credentials chosen on purpose: pass --profile <name>/)
    r = await run([...ID, '--from', f], { AWS_ACCESS_KEY_ID: 'AKIAENVKEYENVKEY0000', AWS_SECRET_ACCESS_KEY: 'x'.repeat(40) })
    expect(r.code).toBe(2)
    expect(built).toBe(0)
    delete process.env.AWS_EC2_METADATA_DISABLED
    r = await run(['--secret-id', 'oasis/prod/app', '--from', f], { AWS_ACCESS_KEY_ID: 'AKIAENVKEYENVKEY0000', AWS_SECRET_ACCESS_KEY: 'x'.repeat(40) })
    expect(r.code).toBe(0)
    expect(process.env.AWS_EC2_METADATA_DISABLED).toBe('true')
  })

  it.each([
    ['OASIS_SECRET_ID=oasis/prod/app\n', /must not live in the secret: OASIS_SECRET_ID \(names the secret itself\)/],
    ['AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=warnx\n', /must not live in the secret: AWS_ACCESS_KEY_ID .*AWS_SECRET_ACCESS_KEY/],
    ['AWS_REGION=us-east-1\n', /AWS_REGION \(is needed to reach the secret/],
    [`NODE_OPTIONS=--max-old-space-size=768\nDATABASE_URL=${DB}\n`, /not declared by the environment contract \(src\/config\/env\.ts\): NODE_OPTIONS; pass --keys/],
    ['SESSION_SECRET=short\n', /SESSION_SECRET: String must contain at least 32 character/],
    ['DATABASE_URL=not a url\n', /DATABASE_URL: Invalid url/],
    ['LOG_LEVEL=warnx\n', /LOG_LEVEL: must be one of fatal, error, warn, info, debug, trace/],
    ['SECRETS_KEY=c2hvcnQ=\n', /SECRETS_KEY: must be base64 of 32 random bytes/],
    ['SESSION_SECRET=\n', /SESSION_SECRET: empty \(use --remove SESSION_SECRET to delete a key\)/],
    [`DATABASE_URL ${DB}\n`, /s\.env line 1 is not NAME=value/],
    [`DATABASE_URL=${DB}\nDATABASE_URL=${DB}\n`, /sets DATABASE_URL twice \(line 2\)/],
  ])('refuses %j before any AWS call', async (text, re) => {
    const r = await run([...ID, '--from', file('s.env', text)])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(re)
    expect(sm.calls()).toHaveLength(0)
  })

  it('refuses usage mistakes', async () => {
    expect((await run(['--profile', 'p', '--from', file('a.env', `DATABASE_URL=${DB}\n`)])).out).toMatch(/--secret-id is required/)
    expect((await run([...ID])).out).toMatch(/nothing to push/)
    expect((await run([...ID, '--keys', 'A'])).out).toMatch(/nothing to push|--keys selects keys/)
    expect((await run([...ID, '--from', file('b.env', `DATABASE_URL=${DB}\n`), '--keys', 'SESSION_SECRET'])).out).toMatch(/does not set SESSION_SECRET/)
    expect((await run([...ID, '--from', file('c.env', `DATABASE_URL=${DB}\n`), '--remove', 'DATABASE_URL'])).out).toMatch(/both set from --from and removed/)
    expect((await run([...ID, '--from', path.join(dir, 'missing.env')])).out).toMatch(/is not a readable file/)
  })
})

describe('plan, apply, re-run', () => {
  const seed = () => file('secret.env', `# generated\nDATABASE_URL=${DB}\nSESSION_SECRET='${SESSION}'\nSECRETS_KEY="${SECRETS_KEY}"\n`)

  it('creates a missing secret with the AWS-managed key and app=oasis, only with --apply, and a re-run has nothing to do', async () => {
    const f = seed()
    const plan = await run([...ID, '--from', f])
    expect(plan.code).toBe(0)
    expect(plan.out.split('\n')).toEqual([
      `identity: arn:aws:iam::${ACCOUNT}:user/oasis-admin (account ${ACCOUNT})`,
      'secret: oasis/prod/app does not exist in us-east-1',
      '',
      'Plan for oasis/prod/app (+ new, ~ changes, = unchanged, - removed; values are never shown):',
      '  + create the secret (KMS key aws/secretsmanager, tag app=oasis)',
      '  + DATABASE_URL (new)',
      '  + SECRETS_KEY (new)',
      '  + SESSION_SECRET (new)',
      '',
      '3 change(s). Nothing was written. Run again with --apply.',
    ])
    expect(mutations()).toHaveLength(0)

    const r = await run([...ID, '--from', f, '--apply'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('applied: 3 change(s) to oasis/prod/app. Restart the services to use them: sudo systemctl restart oasis-api oasis-worker')
    expect(stored()).toEqual({ DATABASE_URL: DB, SECRETS_KEY, SESSION_SECRET: SESSION })
    expect(store.get('oasis/prod/app')!.tags).toEqual([{ Key: 'app', Value: 'oasis' }])

    const again = await run([...ID, '--from', f, '--apply'])
    expect(again.out).toContain('  = DATABASE_URL (unchanged)')
    expect(again.out).toContain('Nothing to change.')
    expect(mutations()).toHaveLength(1)
  })

  it('merges: changed keys are replaced, new ones added, the rest kept; --remove deletes one', async () => {
    store.set('oasis/prod/app', { value: JSON.stringify({ DATABASE_URL: DB, SESSION_SECRET: SESSION, BOOTSTRAP_ADMIN_EMAIL: 'owner@example.com' }) })
    const f = file('rot.env', `SESSION_SECRET=${NEW_SESSION}\nSECRETS_KEY=${SECRETS_KEY}\n`)
    const r = await run([...ID, '--from', f, '--remove', 'BOOTSTRAP_ADMIN_EMAIL', '--remove', 'BOOTSTRAP_ADMIN_PASSWORD', '--apply'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain(`secret: arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:oasis/prod/app-AbCdEf (KMS key aws/secretsmanager)`)
    for (const l of ['  + SECRETS_KEY (new)', '  ~ SESSION_SECRET (changes)', '  - BOOTSTRAP_ADMIN_EMAIL (removed)', '    BOOTSTRAP_ADMIN_PASSWORD (not in the secret; nothing to remove)', '    DATABASE_URL (kept)'])
      expect(r.out.split('\n')).toContain(l)
    expect(stored()).toEqual({ DATABASE_URL: DB, SECRETS_KEY, SESSION_SECRET: NEW_SESSION })
    expect(sm.commandCalls(PutSecretValueCommand)).toHaveLength(1)
    expect(sm.commandCalls(CreateSecretCommand)).toHaveLength(0)
  })

  it('fills a secret that aws:provision created empty, or that exists without a value yet', async () => {
    store.set('oasis/prod/app', { value: '{}' })
    expect((await run([...ID, '--from', seed(), '--apply'])).code).toBe(0)
    expect(Object.keys(stored())).toEqual(['DATABASE_URL', 'SECRETS_KEY', 'SESSION_SECRET'])
    store.set('oasis/other/app', {})
    expect((await run(['--profile', 'p', '--secret-id', 'oasis/other/app', '--from', seed(), '--apply'])).code).toBe(0)
    expect(Object.keys(stored('oasis/other/app'))).toHaveLength(3)
  })

  it('--keys moves only the chosen keys out of a full environment file (common.env)', async () => {
    const common = file('common.env', `# shared\nNODE_ENV=production\nNODE_OPTIONS=--max-old-space-size=768\nDATABASE_URL=${DB}\nSESSION_SECRET=${SESSION}\nSECRETS_KEY=${SECRETS_KEY}\nSES_FROM_NAME='Oasis Auto Spa'\n`, 0o640)
    const r = await run([...ID, '--from', common, '--keys', 'DATABASE_URL,SESSION_SECRET,SECRETS_KEY', '--apply'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/warning: .*common\.env is readable by other users \(mode 640\): chmod 600 it, and shred it once pushed/)
    expect(stored()).toEqual({ DATABASE_URL: DB, SECRETS_KEY, SESSION_SECRET: SESSION })
  })

  it('refuses to overwrite a secret whose value is not a JSON object of strings, or one scheduled for deletion', async () => {
    store.set('oasis/prod/app', { value: `DATABASE_URL=${DB}` })
    let r = await run([...ID, '--from', seed(), '--apply'])
    expect(r.code).toBe(2)
    expect(r.out).toMatch(/is not a JSON object of strings; it would be lost/)
    store.set('oasis/prod/app', { value: '{}', deleted: true })
    r = await run([...ID, '--from', seed(), '--apply'])
    expect(r.out).toMatch(/is scheduled for deletion; restore it first/)
    expect(mutations()).toHaveLength(0)
  })

  it('warns when the merged secret still holds a key the app would refuse', async () => {
    store.set('oasis/prod/app', { value: JSON.stringify({ DATABASE_URL: DB, OLD_THING: 'x' }) })
    const r = await run([...ID, '--from', file('k.env', `SESSION_SECRET=${SESSION}\n`)])
    expect(r.out).toContain('warning: the app will refuse this secret until these keys are removed (--remove): OLD_THING')
  })

  it('reports an AWS refusal with exit 1', async () => {
    sm.on(DescribeSecretCommand).rejects(awsError('AccessDeniedException', 400, 'not authorized to perform: secretsmanager:DescribeSecret'))
    const r = await run([...ID, '--from', seed()])
    expect(r.code).toBe(1)
    expect(r.out).toContain('secrets:push: AWS refused: AccessDeniedException: not authorized to perform: secretsmanager:DescribeSecret')
  })
})

describe('the dotenv reader', () => {
  it('reads the deploy kit format: comments, quotes, export, values with = and #', () => {
    expect(
      Object.fromEntries(parseDotenv("# c\n\nA=1\nexport B='x y'\nC=\"q\"\nD=postgres://u:p#w=@h/db\n", 'f')),
    ).toEqual({ A: '1', B: 'x y', C: 'q', D: 'postgres://u:p#w=@h/db' })
  })
})
