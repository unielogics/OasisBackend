import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { PasswordHasher } from '../../src/modules/auth/password.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { useTestDb } from '../helpers/db.js'

describe('pnpm user:create', () => {
  const t = useTestDb()

  const run = (args: string[], env: Record<string, string> = {}, input?: string) =>
    spawnSync('node_modules/.bin/tsx', ['src/modules/auth/cli.ts', '--', ...args], {
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl(),
        DB_SEARCH_PATH: `${t.schema},public`,
        NODE_ENV: 'test',
        ...env,
      },
      input,
      encoding: 'utf8',
      timeout: 60_000,
    })

  it('creates a Super Admin with a working scrypt login, from an environment variable', async () => {
    const r = run(
      [
        '--email',
        'Owner@Example.test',
        '--first',
        'Amara',
        '--last',
        'Okoye',
        '--phone',
        '(305) 555-0101',
        '--password-env',
        'NEW_USER_PW',
      ],
      { NEW_USER_PW: 'a long cli passphrase' },
    )
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/created owner@example.test/)
    const u = await t.db
      .selectFrom('users as u')
      .innerJoin('employees as e', 'e.id', 'u.employee_id')
      .select(['u.email', 'u.password_hash', 'e.status', 'e.first'])
      .executeTakeFirstOrThrow()
    expect(u).toMatchObject({ email: 'owner@example.test', status: 'active', first: 'Amara' })
    expect(u.password_hash).toMatch(/^\$scrypt\$/)
    expect(u.password_hash).not.toContain('passphrase')
    expect(await new PasswordHasher().verify('a long cli passphrase', u.password_hash)).toBe(true)
    const roles = await t.db
      .selectFrom('employee_roles as er')
      .innerJoin('roles as r', 'r.id', 'er.role_id')
      .select('r.key')
      .execute()
    expect(roles).toEqual([{ key: 'super' }])
  })

  it('reads the password from stdin, takes --roles, and refuses a duplicate or weak password', async () => {
    expect(
      run(
        ['--email', 'm@example.test', '--first', 'Rafael', '--roles', 'mgmt,acct', '--password-stdin'],
        {},
        'another long passphrase\n',
      ).status,
    ).toBe(0)
    const roles = await t.db
      .selectFrom('employee_roles as er')
      .innerJoin('roles as r', 'r.id', 'er.role_id')
      .select('r.key')
      .execute()
    expect(roles.map((x) => x.key).sort()).toEqual(['acct', 'mgmt'])
    const dup = run(
      ['--email', 'M@example.test', '--first', 'Dup', '--password-stdin'],
      {},
      'another long passphrase\n',
    )
    expect(dup.status).toBe(1)
    expect(dup.stderr).toMatch(/already in use/)
    const weak = run(['--email', 'w@example.test', '--password-stdin'], {}, 'short\n')
    expect(weak.status).toBe(1)
    expect(weak.stderr).toMatch(/at least 12/)
    expect(run(['--first', 'No Email', '--password-stdin'], {}, 'another long passphrase\n').stderr).toMatch(
      /--email is required/,
    )
  })

  it('attaches a login to an existing employee with that email instead of duplicating them', async () => {
    run(['--email', 'a@example.test', '--first', 'A', '--password-stdin'], {}, 'another long passphrase\n')
    await t.db.deleteFrom('users').execute()
    const r = run(
      ['--email', 'a@example.test', '--first', 'A', '--password-stdin'],
      {},
      'another long passphrase\n',
    )
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toMatch(/existing employee/)
    expect(await t.db.selectFrom('employees').select('id').execute()).toHaveLength(1)
  })
})
