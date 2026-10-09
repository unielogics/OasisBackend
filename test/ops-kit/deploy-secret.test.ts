// The deploy kit with the environment in AWS Secrets Manager (ADR 0130, 0133): where the shell scripts get DATABASE_URL and the
// current SECRETS_KEY (the process environment, then common.env, then the secret, like the app), the runtime=user credentials file and
// its systemd drop-ins, moving an existing host's secrets out of its env files, and the two scripts that write the secret
// (bootstrap-admin.sh, secrets-rotate.sh) through pnpm secrets:push. AWS is a recording stand-in for scripts/secret-env.ts and
// scripts/secrets-push.ts, except in one test that runs the real helper (the app's loader and the SDK) against a local endpoint.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSecretsHttp } from '../aws/helpers/fake-secrets-http.js'
import { DEPLOY, parseEnvFile, script, sh, tempDir, writeExecutable } from './deploy-helpers.js'

const KEY_OLD = Buffer.alloc(32, 3).toString('base64')
const KEY_NEW = Buffer.alloc(32, 7).toString('base64')

async function install(root: string, extra: string[] = []) {
  const r = await sh(
    script('install.sh'),
    ['--domain', 'oasis.example.com', '--tls', 'files', '--tls-cert', '/c.pem', '--tls-key', '/k.pem', '--no-system', ...extra],
    { OASIS_ROOT_PREFIX: root },
  )
  return r
}

/** A host staged by install.sh, with recording stand-ins for the secret helpers, pnpm, systemctl, backup and health. */
async function world(extra: string[] = []) {
  const t = tempDir('oasis-secret-kit-')
  const root = t.dir
  const inst = await install(root, extra)
  if (inst.code !== 0) throw new Error(inst.out)
  const etc = path.join(root, 'etc/oasis')
  const bin = path.join(root, 'shims')
  const log = path.join(root, 'calls.log')
  const store = path.join(root, 'secret.json')
  const flags = path.join(root, 'flags')
  mkdirSync(flags, { recursive: true })
  writeFileSync(log, '')
  writeFileSync(store, '{}')
  // scripts/secret-env.ts stand-in: the secret is a JSON file
  writeExecutable(
    path.join(bin, 'secret-env'),
    `#!/usr/bin/env node
const fs = require('fs')
fs.appendFileSync(${JSON.stringify(log)}, 'secret-env ' + process.argv.slice(2).join(' ') + ' | id=' + process.env.OASIS_SECRET_ID + ' region=' + process.env.AWS_REGION + ' cred=' + (process.env.AWS_SHARED_CREDENTIALS_FILE || '') + ' imds=' + (process.env.AWS_EC2_METADATA_DISABLED || '') + '\\n')
if (fs.existsSync(${JSON.stringify(path.join(flags, 'deny'))})) { console.error('access denied reading secret'); process.exit(2) }
const doc = JSON.parse(fs.readFileSync(${JSON.stringify(store)}, 'utf8'))
const [cmd, name] = process.argv.slice(2)
if (cmd === '--keys') { for (const k of Object.keys(doc)) process.stdout.write(k + '\\n'); process.exit(0) }
if (cmd === '--get') { if (doc[name] === undefined) process.exit(4); process.stdout.write(doc[name]); process.exit(0) }
process.exit(2)
`,
  )
  // scripts/secrets-push.ts stand-in: records the arguments and the file it was given, applies it to the JSON file with --apply
  writeExecutable(
    path.join(bin, 'secrets-push'),
    `#!/usr/bin/env node
const fs = require('fs')
const a = process.argv.slice(2)
const from = a.includes('--from') ? a[a.indexOf('--from') + 1] : undefined
const text = from ? fs.readFileSync(from, 'utf8') : ''
fs.appendFileSync(${JSON.stringify(log)}, 'secrets-push ' + a.map((x) => x === from ? '<file>' : x).join(' ') + (from ? ' | file=' + text.trim().split('\\n').map((l) => l.split('=')[0]).join(',') : '') + '\\n')
if (fs.existsSync(${JSON.stringify(path.join(flags, 'push-fails'))}) && a.includes('--apply')) { console.error('AWS refused'); process.exit(1) }
if (a.includes('--apply')) {
  const doc = JSON.parse(fs.readFileSync(${JSON.stringify(store)}, 'utf8'))
  for (const l of text.split('\\n').filter(Boolean)) { const i = l.indexOf('='); doc[l.slice(0, i)] = l.slice(i + 1) }
  for (let i = 0; i < a.length; i++) if (a[i] === '--remove') delete doc[a[i + 1]]
  fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(doc))
}
console.log('plan printed')
`,
  )
  writeExecutable(
    path.join(bin, 'pnpm'),
    `#!/usr/bin/env bash\necho "pnpm $* | OLD=\${OLD_SECRETS_KEY:-} NEW=\${NEW_SECRETS_KEY:-} cred=\${AWS_SHARED_CREDENTIALS_FILE:-} id=\${OASIS_SECRET_ID:-}" >> "${log}"\ncase " $* " in *" --apply "*) [ -e "${flags}/fail-apply" ] && exit 1 ;; esac\nexit 0\n`,
  )
  writeExecutable(path.join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "systemctl $*" >> "${log}"\n`)
  writeExecutable(path.join(bin, 'backup.sh'), `#!/usr/bin/env bash\necho "backup $* cred=\${AWS_SHARED_CREDENTIALS_FILE:-}" >> "${log}"\n`)
  writeExecutable(path.join(bin, 'health.sh'), `#!/usr/bin/env bash\necho "health $*" >> "${log}"\n`)
  const prefix = path.join(root, 'opt/oasis')
  mkdirSync(path.join(prefix, 'current/backend'), { recursive: true })
  const env = {
    OASIS_ROOT_PREFIX: root,
    OASIS_ALLOW_NONROOT: '1',
    OASIS_RUN_AS: '',
    OASIS_PREFIX: prefix,
    OASIS_STATE: path.join(root, 'var/lib/oasis'),
    OASIS_SECRET_ENV_CMD: path.join(bin, 'secret-env'),
    OASIS_SECRETS_PUSH_CMD: path.join(bin, 'secrets-push'),
    SYSTEMCTL: path.join(bin, 'systemctl'),
    BACKUP_CMD: path.join(bin, 'backup.sh'),
    HEALTH_CMD: path.join(bin, 'health.sh'),
    PATH: `${bin}:${process.env.PATH}`,
    // nothing of the test runner's own environment may leak into what the scripts read
    DATABASE_URL: undefined,
    OASIS_SECRET_ID: undefined,
    AWS_SHARED_CREDENTIALS_FILE: undefined,
    AWS_REGION: undefined,
    // only stand-ins run with this environment (the real-helper test sets its own, metadata disabled); this proves the role
    // runtime adds nothing of its own
    AWS_EC2_METADATA_DISABLED: undefined,
  }
  return {
    root,
    etc,
    env,
    t,
    store: (doc?: Record<string, string>) => {
      if (doc) writeFileSync(store, JSON.stringify(doc))
      return JSON.parse(readFileSync(store, 'utf8')) as Record<string, string>
    },
    calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    clear: () => writeFileSync(log, ''),
    flag: (n: string, on = true) => (on ? writeFileSync(path.join(flags, n), '') : rmSync(path.join(flags, n), { force: true })),
    file: (n: string) => readFileSync(path.join(etc, n), 'utf8'),
    /** Sources deploy/lib/common.sh and prints config_value NAME (test values only). */
    configValue: (name: string, over: Record<string, string | undefined> = {}) =>
      sh('bash', ['-c', `. "${path.join(DEPLOY, 'lib/common.sh')}"; config_value ${name}`], { ...env, ...over }),
  }
}

describe('where the scripts read the secret settings', () => {
  let w: Awaited<ReturnType<typeof world>>
  beforeAll(async () => {
    w = await world()
  })
  afterAll(() => w.t.cleanup())

  it('the process environment first, then a non-empty common.env line, then the secret common.env names (as the app)', async () => {
    w.store({ DATABASE_URL: 'postgres://from-secret' })
    expect((await w.configValue('DATABASE_URL', { DATABASE_URL: 'postgres://from-env' })).stdout).toBe('postgres://from-env')
    w.clear()
    const fromSecret = await w.configValue('DATABASE_URL')
    expect(fromSecret.stdout).toBe('postgres://from-secret')
    // the secret's id and region come from common.env, and the role runtime adds no credentials (the SDK asks the instance)
    expect(w.calls()).toEqual(['secret-env --get DATABASE_URL | id=oasis/prod/app region=us-east-1 cred= imds='])
    const common = path.join(w.etc, 'common.env')
    const before = readFileSync(common, 'utf8')
    writeFileSync(common, `${before}DATABASE_URL=postgres://from-file\n`)
    expect((await w.configValue('DATABASE_URL')).stdout).toBe('postgres://from-file')
    writeFileSync(common, before)
    expect((await w.configValue('SQSP_API_KEY')).code).not.toBe(0)
  })

  it('with runtime=user the helper gets the key file and never the metadata service; an unreadable key file is a clear error', async () => {
    const cred = path.join(w.etc, 'aws-credentials')
    writeFileSync(cred, '[default]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = x\n', { mode: 0o600 })
    w.store({ DATABASE_URL: 'postgres://from-secret' })
    w.clear()
    expect((await w.configValue('DATABASE_URL')).stdout).toBe('postgres://from-secret')
    expect(w.calls()).toEqual([`secret-env --get DATABASE_URL | id=oasis/prod/app region=us-east-1 cred=${cred} imds=true`])
    if (process.getuid?.() !== 0) {
      const { chmodSync } = await import('node:fs')
      chmodSync(cred, 0o000)
      const r = await w.configValue('DATABASE_URL')
      chmodSync(cred, 0o600)
      expect(r.out).toMatch(/aws-credentials exists but this user cannot read it: run as root, or through the systemd unit/)
    }
    rmSync(cred)
  })

  it('a refused secret stops the script with the reason, and no value is printed', async () => {
    w.flag('deny')
    const r = await sh(script('backup.sh'), ['--dry-run'], w.env)
    w.flag('deny', false)
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('access denied reading secret')
    expect(r.out).toMatch(/DATABASE_URL is set neither in the environment, nor in .*common\.env, nor in the secret it names/)
  })
})

describe('the real helper (scripts/secret-env.ts, the app loader and the SDK) against a local Secrets Manager endpoint', () => {
  const sm = new FakeSecretsHttp()
  let w: Awaited<ReturnType<typeof world>>
  let aws: Record<string, string>
  beforeAll(async () => {
    w = await world()
    aws = await sm.start()
    sm.secrets.set('oasis/prod/app', JSON.stringify({ DATABASE_URL: 'postgres://oasis:N0tPr1nted@db.internal:5433/oasisdb', SESSION_SECRET: 's'.repeat(40) }))
  })
  afterAll(async () => {
    await sm.stop()
    w.t.cleanup()
  })

  it('backup.sh --dry-run gets DATABASE_URL from the secret and never prints the password', async () => {
    const env = { ...w.env, ...aws, OASIS_SECRET_ENV_CMD: undefined, AWS_REGION: undefined }
    const r = await sh(script('backup.sh'), ['--dry-run'], env)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('would dump database oasisdb on db.internal:5433')
    expect(r.out).not.toContain('N0tPr1nted')
    expect(sm.requests.at(-1)).toEqual({ target: 'secretsmanager.GetSecretValue', secretId: 'oasis/prod/app' })
    const keys = await sh(path.join(process.cwd(), 'node_modules/.bin/tsx'), [path.join(process.cwd(), 'scripts/secret-env.ts'), '--keys'], { ...aws, OASIS_SECRET_ID: 'oasis/prod/app' })
    expect(keys.stdout.split('\n').filter(Boolean)).toEqual(['DATABASE_URL', 'SESSION_SECRET'])
    const none = await sh(path.join(process.cwd(), 'node_modules/.bin/tsx'), [path.join(process.cwd(), 'scripts/secret-env.ts'), '--get', 'SQSP_API_KEY'], { ...aws, OASIS_SECRET_ID: 'oasis/prod/app' })
    expect(none.code).toBe(4)
    expect((await sh(path.join(process.cwd(), 'node_modules/.bin/tsx'), [path.join(process.cwd(), 'scripts/secret-env.ts'), '--keys'], { ...aws, OASIS_SECRET_ID: undefined })).code).toBe(3)
  })
})

describe('install.sh: the runtime identity', () => {
  const units = ['oasis-api.service', 'oasis-worker.service', 'oasis-backup.service', 'oasis-restore-drill.service']

  it('runtime=user writes one drop-in per AWS-using unit (LoadCredential of the root-only key, the SDK pointed at the copy, no metadata); role removes them', async () => {
    const t = tempDir('oasis-runtime-')
    try {
      const user = await install(t.dir, ['--aws-runtime', 'user'])
      expect(user.code, user.out).toBe(0)
      expect(user.out).toMatch(/runtime=user: install the oasis-app key before starting the services .* \/etc\/oasis\/aws-credentials/)
      for (const u of units) {
        const text = readFileSync(path.join(t.dir, 'etc/systemd/system', `${u}.d`, '10-oasis-aws-credentials.conf'), 'utf8')
        expect(text).toContain('[Service]\nLoadCredential=aws-credentials:/etc/oasis/aws-credentials\nEnvironment=AWS_SHARED_CREDENTIALS_FILE=%d/aws-credentials\nEnvironment=AWS_EC2_METADATA_DISABLED=true\n')
      }
      expect(existsSync(path.join(t.dir, 'etc/systemd/system/oasis-web.service.d'))).toBe(false)
      // the web unit never sees AWS; the units themselves do not change with the runtime
      writeFileSync(path.join(t.dir, 'etc/oasis/aws-credentials'), '[default]\n', { mode: 0o600 })
      const role = await install(t.dir, ['--aws-runtime', 'role'])
      expect(role.code, role.out).toBe(0)
      for (const u of units) expect(existsSync(path.join(t.dir, 'etc/systemd/system', `${u}.d`, '10-oasis-aws-credentials.conf')), u).toBe(false)
      expect(role.out).toMatch(/runtime=role, but \/etc\/oasis\/aws-credentials exists: the deploy scripts would still use it/)
      expect((await install(t.dir, ['--aws-runtime', 'lambda'])).out).toMatch(/--aws-runtime must be role or user/)
    } finally {
      t.cleanup()
    }
  })

  it('--secret-id and --aws-region go into a new common.env; a host without the secret is told how to move', async () => {
    const t = tempDir('oasis-sid-')
    try {
      expect((await install(t.dir, ['--secret-id', 'oasis/staging/app', '--aws-region', 'us-west-2'])).code).toBe(0)
      const common = parseEnvFile(readFileSync(path.join(t.dir, 'etc/oasis/common.env'), 'utf8'))
      expect([common.OASIS_SECRET_ID, common.AWS_REGION]).toEqual(['oasis/staging/app', 'us-west-2'])
      const t2 = tempDir('oasis-legacy-')
      try {
        expect((await install(t2.dir, ['--secrets-in-files'])).code).toBe(0)
        const again = await install(t2.dir)
        expect(again.out).toMatch(/names no OASIS_SECRET_ID: this host still keeps its secrets in the env files\. Move them/)
      } finally {
        t2.cleanup()
      }
    } finally {
      t.cleanup()
    }
  })
})

describe('install.sh --move-secrets (an existing host)', () => {
  let w: Awaited<ReturnType<typeof world>>
  let legacy: Record<string, string>
  beforeAll(async () => {
    w = await world(['--secrets-in-files'])
    legacy = parseEnvFile(w.file('common.env'))
  })
  afterAll(() => w.t.cleanup())
  const moveEnv = () => sh(script('install.sh'), ['--domain', 'oasis.example.com', '--tls', 'files', '--tls-cert', '/c.pem', '--tls-key', '/k.pem', '--no-system', '--move-secrets'], w.env)

  it('refuses, changing nothing, while the secret lacks a key or holds another value', async () => {
    const before = w.file('common.env')
    w.store({ DATABASE_URL: legacy.DATABASE_URL!, SESSION_SECRET: legacy.SESSION_SECRET! })
    let r = await moveEnv()
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/the secret oasis\/prod\/app does not hold SECRETS_KEY yet; push them first .*--keys SECRETS_KEY --apply/)
    w.store({ DATABASE_URL: legacy.DATABASE_URL!, SESSION_SECRET: legacy.SESSION_SECRET!, SECRETS_KEY: KEY_OLD })
    r = await moveEnv()
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/the secret's SECRETS_KEY differ\(s\) from the env files; nothing was changed/)
    expect(r.out).not.toContain(KEY_OLD)
    expect(r.out).not.toContain(legacy.SECRETS_KEY!)
    expect(w.file('common.env')).toBe(before)
  })

  it('once the secret holds the same values: names the secret in common.env and removes the lines, keeping backups to shred', async () => {
    w.store({ DATABASE_URL: legacy.DATABASE_URL!, SESSION_SECRET: legacy.SESSION_SECRET!, SECRETS_KEY: legacy.SECRETS_KEY! })
    const r = await moveEnv()
    expect(r.code, r.out).toBe(0)
    const common = parseEnvFile(w.file('common.env'))
    expect(common.OASIS_SECRET_ID).toBe('oasis/prod/app')
    expect([common.DATABASE_URL, common.SESSION_SECRET, common.SECRETS_KEY]).toEqual([undefined, undefined, undefined])
    expect(r.out).toMatch(/removed from the env files: DATABASE_URL SESSION_SECRET SECRETS_KEY/)
    expect(r.out).toMatch(/\*\.env\.bak-\* still hold those values: shred them/)
    expect(readdirSync(w.etc).some((f) => f.startsWith('common.env.bak-'))).toBe(true)
    expect((statSync(path.join(w.etc, 'common.env')).mode & 0o777).toString(8)).toBe('640')
    // nothing left to move; a re-run is quiet
    const again = await moveEnv()
    expect(again.code, again.out).toBe(0)
    expect(again.out).toMatch(/removed from the env files: \(nothing\)/)
  })
})

describe('bootstrap-admin.sh with the secret', () => {
  let w: Awaited<ReturnType<typeof world>>
  beforeAll(async () => {
    w = await world()
  })
  afterAll(() => w.t.cleanup())
  const run = (...a: string[]) => sh(script('bootstrap-admin.sh'), a, w.env)

  it('needs the operator profile, stores both keys in the secret through secrets:push, prints the password once, and clear removes them', async () => {
    const apiBefore = w.file('api.env')
    expect((await run('set', 'owner@example.com')).out).toMatch(/give --profile <operator profile>/)
    w.clear()
    const set = await run('set', 'owner@example.com', '--profile', 'oasis-admin')
    expect(set.code, set.out).toBe(0)
    const password = /Password:\s+(\S+)/.exec(set.stdout)![1]!
    expect(w.calls()).toEqual(['secrets-push --profile oasis-admin --secret-id oasis/prod/app --region us-east-1 --from <file> --apply | file=BOOTSTRAP_ADMIN_EMAIL,BOOTSTRAP_ADMIN_PASSWORD'])
    expect(w.store()).toEqual({ BOOTSTRAP_ADMIN_EMAIL: 'owner@example.com', BOOTSTRAP_ADMIN_PASSWORD: password })
    expect(set.stdout.split(password)).toHaveLength(2) // exactly once
    expect(w.file('api.env')).toBe(apiBefore)
    expect((await run('status')).stdout).toMatch(/BOOTSTRAP_ADMIN_PASSWORD: \(set in the secret\)/)
    w.clear()
    const clear = await run('clear', '--profile', 'oasis-admin')
    expect(clear.code, clear.out).toBe(0)
    expect(w.calls()).toEqual(['secrets-push --profile oasis-admin --secret-id oasis/prod/app --region us-east-1 --remove BOOTSTRAP_ADMIN_EMAIL --remove BOOTSTRAP_ADMIN_PASSWORD --apply'])
    expect(w.store()).toEqual({})
    expect((await run('status')).stdout).toMatch(/BOOTSTRAP_ADMIN_EMAIL: {4}\(not in the secret\)/)
  })

  it('a refused push stores nothing and prints no password', async () => {
    w.flag('push-fails')
    const r = await run('set', 'owner@example.com', '--profile', 'oasis-admin')
    w.flag('push-fails', false)
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/the secret oasis\/prod\/app was not changed/)
    expect(r.stdout).not.toMatch(/Password:/)
  })
})

describe('secrets-rotate.sh with the secret', () => {
  let w: Awaited<ReturnType<typeof world>>
  let keyFile: string
  beforeAll(async () => {
    w = await world()
    keyFile = path.join(w.root, 'new.key')
    writeFileSync(keyFile, `${KEY_NEW}\n`, { mode: 0o600 })
  })
  afterAll(() => w.t.cleanup())
  const run = (...a: string[]) => sh(script('secrets-rotate.sh'), a, w.env)

  it('the dry run reads the current key from the secret and needs no operator; --apply refuses without --profile before anything stops', async () => {
    w.store({ SECRETS_KEY: KEY_OLD })
    w.clear()
    const dry = await run('--new-key-file', keyFile)
    expect(dry.code, dry.out).toBe(0)
    expect(w.calls().filter((c) => c.startsWith('pnpm'))).toEqual([
      `pnpm -s secrets:rotate -- --old-key-env OLD_SECRETS_KEY --new-key-env NEW_SECRETS_KEY | OLD=${KEY_OLD} NEW=${KEY_NEW} cred= id=oasis/prod/app`,
    ])
    expect(dry.out).not.toContain(KEY_OLD)
    w.clear()
    const r = await run('--new-key-file', keyFile, '--apply')
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/give --profile <operator profile> so the new key can be stored there/)
    expect(w.calls().filter((c) => /^(systemctl|backup)/.test(c))).toEqual([])
  })

  it('--apply: dry run, push plan, backup, stop, re-encrypt, push the new key, start, health check, in that order', async () => {
    w.store({ SECRETS_KEY: KEY_OLD, DATABASE_URL: 'postgres://x' })
    const commonBefore = w.file('common.env')
    w.clear()
    const r = await run('--new-key-file', keyFile, '--profile', 'oasis-admin', '--apply')
    expect(r.code, r.out).toBe(0)
    expect(w.calls().filter((c) => !c.startsWith('secret-env')).map((c) => c.replace(/ \| OLD=.*$/, ''))).toEqual([
      'pnpm -s secrets:rotate -- --old-key-env OLD_SECRETS_KEY --new-key-env NEW_SECRETS_KEY',
      'secrets-push --profile oasis-admin --secret-id oasis/prod/app --region us-east-1 --from <file> | file=SECRETS_KEY',
      'backup --label pre-rotate cred=',
      'systemctl stop oasis-api.service oasis-worker.service',
      'pnpm -s secrets:rotate -- --old-key-env OLD_SECRETS_KEY --new-key-env NEW_SECRETS_KEY --apply',
      'secrets-push --profile oasis-admin --secret-id oasis/prod/app --region us-east-1 --from <file> --apply | file=SECRETS_KEY',
      'systemctl restart oasis-worker.service',
      'systemctl restart oasis-api.service',
      'systemctl restart oasis-web.service',
      'health --wait 90',
    ])
    expect(w.store()).toEqual({ SECRETS_KEY: KEY_NEW, DATABASE_URL: 'postgres://x' })
    expect(w.file('common.env')).toBe(commonBefore)
    expect(r.out).toMatch(/SECRETS_KEY in the secret oasis\/prod\/app replaced \(Secrets Manager keeps the previous version as AWSPREVIOUS\)/)
    expect(r.out).not.toContain(KEY_NEW)
  })

  it('a push that fails after the re-encryption restarts the services and says exactly how to finish', async () => {
    w.store({ SECRETS_KEY: KEY_OLD })
    w.flag('push-fails')
    w.clear()
    const r = await run('--new-key-file', keyFile, '--profile', 'oasis-admin', '--apply')
    w.flag('push-fails', false)
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/the database is on the NEW key .* but the secret oasis\/prod\/app still holds the old one/)
    expect(r.out).toMatch(/pnpm secrets:push --profile oasis-admin --secret-id oasis\/prod\/app --from \/root\/k\.env --apply/)
    expect(w.calls().filter((c) => c.startsWith('systemctl restart'))).toHaveLength(3)
    expect(w.store()).toEqual({ SECRETS_KEY: KEY_OLD })
  })

  it('refuses while common.env still sets SECRETS_KEY (it would win over the secret)', async () => {
    const common = path.join(w.etc, 'common.env')
    const before = readFileSync(common, 'utf8')
    writeFileSync(common, `${before}SECRETS_KEY=${KEY_OLD}\n`)
    const r = await run('--new-key-file', keyFile)
    writeFileSync(common, before)
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/still sets SECRETS_KEY, which wins over the secret oasis\/prod\/app: move it first/)
  })
})

describe('commands run as the service user get the app identity', () => {
  it('runtime=user: verify.sh hands the key file to the release (as root it would be a private copy for the oasis user)', async () => {
    const w = await world()
    try {
      writeFileSync(path.join(w.etc, 'aws-credentials'), '[default]\n', { mode: 0o600 })
      w.clear()
      const r = await sh(script('verify.sh'), ['aws', '--only', 's3'], w.env)
      expect(r.code, r.out).toBe(0)
      expect(w.calls()).toEqual([`pnpm -s verify:aws -- --only s3 | OLD= NEW= cred=${path.join(w.etc, 'aws-credentials')} id=oasis/prod/app`])
      rmSync(path.join(w.etc, 'aws-credentials'))
      w.clear()
      await sh(script('verify.sh'), ['aws', '--only', 's3', '--instance-profile'], w.env)
      expect(w.calls()).toEqual(['pnpm -s verify:aws -- --only s3 --instance-profile | OLD= NEW= cred= id=oasis/prod/app'])
    } finally {
      w.t.cleanup()
    }
  })
})
