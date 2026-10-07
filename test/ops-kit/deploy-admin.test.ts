// The two admin paths around the app: the break-glass password reset and the SECRETS_KEY rotation wrapper.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { PasswordHasher } from '../../src/modules/auth/password.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { resetPassword } from '../../deploy/lib/reset-password.js'
import { useTestDb } from '../helpers/db.js'
import { makeUser } from '../helpers/factories.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { REPO, parseEnvFile, script, sh, tempDir, writeExecutable } from './deploy-helpers.js'
import { useStage } from './deploy-stage.js'

const t = useTestDb()

async function userWithSessions(email: string, o: { disabled?: boolean } = {}): Promise<string> {
  const newId = createIdGenerator(t.clock)
  await ensureLocation(t.db, newId, { timezone: 'America/New_York' })
  const { userId } = await makeUser(t.db, newId, { email })
  await sql`update users set failed_attempts = 7, disabled_at = ${o.disabled ? sql`app_now()` : null} where id = ${userId}::uuid`.execute(
    t.db,
  )
  for (let i = 0; i < 3; i++) {
    await sql`insert into sessions (id, user_id, idle_expires_at, absolute_expires_at, csrf_secret)
      values (${i.toString(16).padStart(64, '0')}, ${userId}::uuid, app_now() + interval '1 hour', app_now() + interval '1 day', 'x')`.execute(
      t.db,
    )
  }
  return userId
}

describe('reset-password (break-glass for a locked-out Super Admin)', () => {
  it('sets a new password that the app verifies, clears the throttle counter, revokes every session and leaves an audit row', async () => {
    const userId = await userWithSessions('owner@example.com')
    const r = await resetPassword(t.db, { email: 'Owner@Example.com', password: 'a-brand-new-passphrase' })
    expect(r).toEqual({ userId, sessionsRevoked: 3 })
    const row = (
      await sql<{
        password_hash: string
        failed_attempts: number
      }>`select password_hash, failed_attempts from users where id = ${userId}::uuid`.execute(t.db)
    ).rows[0]!
    expect(await new PasswordHasher().verify('a-brand-new-passphrase', row.password_hash)).toBe(true)
    expect(await new PasswordHasher().verify('wrong-passphrase-here', row.password_hash)).toBe(false)
    expect(row.failed_attempts).toBe(0)
    const live =
      await sql`select 1 from sessions where user_id = ${userId}::uuid and revoked_at is null`.execute(t.db)
    expect(live.rows).toHaveLength(0)
    const audit = (
      await sql<{
        action: string
        entity_id: string
        after: unknown
      }>`select action, entity_id, after from audit_log where action = 'user.password_reset_cli'`.execute(
        t.db,
      )
    ).rows
    expect(audit).toHaveLength(1)
    expect(audit[0]!.entity_id).toBe(userId)
    expect(JSON.stringify(audit[0]!.after)).not.toContain('passphrase')
  })

  it('a deactivated login stays deactivated unless --enable is given', async () => {
    const userId = await userWithSessions('former@example.com', { disabled: true })
    await resetPassword(t.db, { email: 'former@example.com', password: 'another-good-passphrase' })
    expect(
      (
        await sql<{
          d: boolean
        }>`select disabled_at is not null as d from users where id = ${userId}::uuid`.execute(t.db)
      ).rows[0]!.d,
    ).toBe(true)
    await resetPassword(t.db, {
      email: 'former@example.com',
      password: 'another-good-passphrase',
      enable: true,
    })
    expect(
      (
        await sql<{
          d: boolean
        }>`select disabled_at is not null as d from users where id = ${userId}::uuid`.execute(t.db)
      ).rows[0]!.d,
    ).toBe(false)
  })

  it('refuses a weak password and an unknown login, changing nothing', async () => {
    const userId = await userWithSessions('someone@example.com')
    const before = (
      await sql<{ h: string }>`select password_hash as h from users where id = ${userId}::uuid`.execute(t.db)
    ).rows[0]!.h
    await expect(resetPassword(t.db, { email: 'someone@example.com', password: 'short' })).rejects.toThrow()
    await expect(
      resetPassword(t.db, { email: 'nobody@example.com', password: 'a-brand-new-passphrase' }),
    ).rejects.toThrow(/No login for nobody@example.com/)
    expect(
      (
        await sql<{ h: string }>`select password_hash as h from users where id = ${userId}::uuid`.execute(
          t.db,
        )
      ).rows[0]!.h,
    ).toBe(before)
    const live =
      await sql`select 1 from sessions where user_id = ${userId}::uuid and revoked_at is null`.execute(t.db)
    expect(live.rows).toHaveLength(3)
  })

  it('works end to end through reset-password.sh with the password on stdin', async () => {
    const userId = await userWithSessions('cli@example.com')
    const w = tempDir('oasis-reset-')
    try {
      const etc = path.join(w.dir, 'etc')
      mkdirSync(etc, { recursive: true })
      writeFileSync(
        path.join(etc, 'common.env'),
        `DATABASE_URL=${testDatabaseUrl()}\nDB_SEARCH_PATH=${t.schema},public\n`,
      )
      writeFileSync(path.join(etc, 'api.env'), '')
      mkdirSync(path.join(w.dir, 'prefix/current'), { recursive: true })
      symlinkSync(REPO, path.join(w.dir, 'prefix/current/backend'))
      const env = {
        OASIS_ETC: etc,
        OASIS_PREFIX: path.join(w.dir, 'prefix'),
        OASIS_RUN_AS: '',
        OASIS_ALLOW_NONROOT: '1',
        NODE_ENV: 'development',
      }
      const r = await sh(script('reset-password.sh'), ['cli@example.com'], env, 'typed-on-stdin-passphrase\n')
      expect(r.code, r.out).toBe(0)
      expect(r.stdout).toMatch(/password set for cli@example.com; 3 session\(s\) revoked/)
      const hash = (
        await sql<{ h: string }>`select password_hash as h from users where id = ${userId}::uuid`.execute(
          t.db,
        )
      ).rows[0]!.h
      expect(await new PasswordHasher().verify('typed-on-stdin-passphrase', hash)).toBe(true)
      expect(r.out).not.toContain('typed-on-stdin-passphrase')
      const bad = await sh(script('reset-password.sh'), ['not-an-address'], env)
      expect(bad.code).toBe(2)
    } finally {
      w.cleanup()
    }
  }, 60_000)
})

describe('secrets-rotate.sh', () => {
  const stage = useStage()

  function setup() {
    const bin = path.join(stage.root, 'shims')
    const log = path.join(stage.root, 'calls.log')
    const flags = path.join(stage.root, 'flags')
    mkdirSync(flags, { recursive: true })
    writeFileSync(log, '')
    mkdirSync(path.join(stage.prefix, 'current/backend'), { recursive: true })
    writeExecutable(
      path.join(bin, 'pnpm'),
      `#!/usr/bin/env bash\necho "pnpm $*" >> "${log}"\necho "env OLD=\${OLD_SECRETS_KEY:+set} NEW=\${NEW_SECRETS_KEY:+set} DATABASE_URL=\${DATABASE_URL:+set}" >> "${log}"\ncase " $* " in *" --apply "*) [ -e "${flags}/fail-apply" ] && { echo "re-encryption broke" >&2; exit 1; } ;; *) [ -e "${flags}/fail-dry" ] && { echo "dry run broke" >&2; exit 1; } ;; esac\nexit 0\n`,
    )
    writeExecutable(path.join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "systemctl $*" >> "${log}"\n`)
    writeExecutable(
      path.join(bin, 'backup.sh'),
      `#!/usr/bin/env bash\necho "backup $*" >> "${log}"\n[ -e "${flags}/fail-backup" ] && exit 1\nexit 0\n`,
    )
    writeExecutable(
      path.join(bin, 'health.sh'),
      `#!/usr/bin/env bash\necho "health $*" >> "${log}"\n[ -e "${flags}/unhealthy" ] && exit 1\nexit 0\n`,
    )
    const env = {
      ...stage.env,
      OASIS_ALLOW_NONROOT: '1',
      OASIS_RUN_AS: '',
      SYSTEMCTL: path.join(bin, 'systemctl'),
      BACKUP_CMD: path.join(bin, 'backup.sh'),
      HEALTH_CMD: path.join(bin, 'health.sh'),
      PATH: `${bin}:${process.env.PATH}`,
      OASIS_PREFIX: stage.prefix,
    }
    const keyFile = path.join(stage.root, 'new.key')
    writeFileSync(keyFile, `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o640 })
    return {
      env,
      keyFile,
      calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
      clear: () => writeFileSync(log, ''),
      flag: (n: string, on = true) =>
        on ? writeFileSync(path.join(flags, n), '') : rmSync(path.join(flags, n), { force: true }),
      run: (...a: string[]) => sh(script('secrets-rotate.sh'), a, env),
      common: () => readFileSync(path.join(stage.etc, 'common.env'), 'utf8'),
    }
  }

  it('by default only checks: one dry run, nothing stopped, nothing written, keys passed by environment and never as arguments', async () => {
    const s = setup()
    const before = s.common()
    const r = await s.run('--new-key-file', s.keyFile)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/that was a dry run/)
    expect(s.calls()).toEqual([
      'pnpm -s secrets:rotate -- --old-key-env OLD_SECRETS_KEY --new-key-env NEW_SECRETS_KEY',
      'env OLD=set NEW=set DATABASE_URL=set',
    ])
    expect(s.common()).toBe(before)
    expect(s.calls().join('\n')).not.toContain(parseEnvFile(before).SECRETS_KEY!)
  })

  it('--apply: dry run, backup, stop, re-encrypt, replace SECRETS_KEY, start, health check, in that order', async () => {
    const s = setup()
    s.clear()
    const oldKey = parseEnvFile(s.common()).SECRETS_KEY!
    const r = await s.run('--new-key-file', s.keyFile, '--apply')
    expect(r.code, r.out).toBe(0)
    const order = s.calls().filter((c) => !c.startsWith('env '))
    expect(order).toEqual([
      'pnpm -s secrets:rotate -- --old-key-env OLD_SECRETS_KEY --new-key-env NEW_SECRETS_KEY',
      'backup --label pre-rotate',
      'systemctl stop oasis-api.service oasis-worker.service',
      'pnpm -s secrets:rotate -- --old-key-env OLD_SECRETS_KEY --new-key-env NEW_SECRETS_KEY --apply',
      'systemctl restart oasis-worker.service',
      'systemctl restart oasis-api.service',
      'systemctl restart oasis-web.service',
      'health --wait 90',
    ])
    expect(parseEnvFile(s.common()).SECRETS_KEY).toBe(Buffer.alloc(32, 7).toString('base64'))
    const backup = readdirSync(stage.etc).find((f) => f.startsWith('common.env.bak-'))!
    expect(parseEnvFile(readFileSync(path.join(stage.etc, backup), 'utf8')).SECRETS_KEY).toBe(oldKey)
    expect(statSync(path.join(stage.etc, 'common.env')).mode & 0o777).toBe(0o640)
  })

  it('a failed re-encryption leaves common.env alone and starts the services again', async () => {
    const s = setup()
    const before = s.common()
    s.clear()
    s.flag('fail-apply')
    const r = await s.run('--new-key-file', s.keyFile, '--apply')
    s.flag('fail-apply', false)
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/re-encryption failed and was rolled back; the old key is still in force/)
    expect(s.common()).toBe(before)
    expect(s.calls().filter((c) => c.startsWith('systemctl'))).toEqual([
      'systemctl stop oasis-api.service oasis-worker.service',
      'systemctl restart oasis-worker.service',
      'systemctl restart oasis-api.service',
      'systemctl restart oasis-web.service',
    ])
  })

  it('a failed dry run or backup stops before anything is stopped', async () => {
    const s = setup()
    s.clear()
    s.flag('fail-dry')
    expect((await s.run('--new-key-file', s.keyFile, '--apply')).out).toMatch(
      /the dry run failed; nothing was changed/,
    )
    s.flag('fail-dry', false)
    s.flag('fail-backup')
    expect((await s.run('--new-key-file', s.keyFile, '--apply')).out).toMatch(
      /backup failed; nothing was changed/,
    )
    s.flag('fail-backup', false)
    expect(s.calls().filter((c) => c.startsWith('systemctl'))).toEqual([])
  })

  it('--generate writes a 32-byte key file once and refuses to reuse it', async () => {
    const s = setup()
    const r = await s.run('--generate')
    expect(r.code, r.out).toBe(0)
    const file = path.join(stage.etc, 'secrets-key.new')
    expect(Buffer.from(readFileSync(file, 'utf8').trim(), 'base64')).toHaveLength(32)
    expect(statSync(file).mode & 0o777).toBe(0o640)
    expect(r.out).toMatch(/copy it to a password manager now/)
    expect((await s.run('--generate')).out).toMatch(/already exists from an earlier run/)
  })
})

describe('verify.sh', () => {
  const stage = useStage()

  it('runs the chosen check from the current release with the environment files loaded, writing reports to the state directory', async () => {
    const bin = path.join(stage.root, 'shims')
    const log = path.join(stage.root, 'verify.log')
    writeFileSync(log, '')
    mkdirSync(path.join(stage.prefix, 'current/backend'), { recursive: true })
    writeExecutable(
      path.join(bin, 'pnpm'),
      `#!/usr/bin/env bash\necho "pnpm $* | cwd=$(basename "$(dirname "$PWD")")/$(basename "$PWD") | out=$VERIFY_LIVE_OUT_DIR | db=\${DATABASE_URL:+set} | port=$PORT" >> "${log}"\n`,
    )
    const env = {
      ...stage.env,
      OASIS_ALLOW_NONROOT: '1',
      OASIS_RUN_AS: '',
      PATH: `${bin}:${process.env.PATH}`,
      OASIS_PREFIX: stage.prefix,
      OASIS_STATE: path.join(stage.root, 'var/lib/oasis'),
    }
    const r = await sh(script('verify.sh'), ['smsgate', '--send', '--to', '+13055550100', '--watch'], env)
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(log, 'utf8').trim()).toBe(
      `pnpm -s verify:smsgate -- --send --to +13055550100 --watch | cwd=current/backend | out=${path.join(stage.root, 'var/lib/oasis/live-verification')} | db=set | port=4000`,
    )
    expect(statSync(path.join(stage.root, 'var/lib/oasis/live-verification')).isDirectory()).toBe(true)
    expect((await sh(script('verify.sh'), ['bogus'], env)).out).toMatch(/unknown check bogus/)
    expect((await sh(script('verify.sh'), [], env)).code).toBe(2)
  })
})
