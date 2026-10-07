// Break-glass: set a new password for an existing login straight in the database, for a locked-out Super Admin.
//   cd /opt/oasis/current/backend && sudo -u oasis env $(grep -v '^#' /etc/oasis/common.env | xargs) \
//     pnpm exec tsx deploy/lib/reset-password.ts --email you@example.com --password-stdin [--enable]
// (deploy/scripts/reset-password.sh wraps this.) The password comes from stdin, a hidden prompt or --password-env VAR, never from the
// command line. Every session of that person is revoked, the failed-attempt counter is cleared, --enable also lifts a deactivation
// of the login, and an audit_log row records that it happened and when (but not by whom: the shell user is in the system log).
import { createInterface } from 'node:readline'
import { sql } from 'kysely'
import { loadEnv } from '../../src/config/env.js'
import { PasswordHasher, passwordProblem } from '../../src/modules/auth/password.js'
import * as audit from '../../src/platform/audit.js'
import { createClock } from '../../src/platform/clock.js'
import { createDb, transaction, type Db } from '../../src/platform/db.js'

export async function resetPassword(
  db: Db,
  o: { email: string; password: string; enable?: boolean },
): Promise<{ userId: string; sessionsRevoked: number }> {
  const hasher = new PasswordHasher()
  const user = await db
    .selectFrom('users')
    .select(['id', 'email', 'disabled_at'])
    .where('email', '=', o.email.trim().toLowerCase())
    .executeTakeFirst()
  if (!user) throw new Error(`No login for ${o.email}. Create one with pnpm user:create instead.`)
  const problem = passwordProblem(o.password, { email: user.email })
  if (problem) throw new Error(problem)
  const hash = await hasher.hash(o.password)
  return transaction(db, async (tx) => {
    await sql`update users set password_hash = ${hash}, failed_attempts = 0, password_changed_at = app_now()
      ${o.enable ? sql`, disabled_at = null` : sql``} where id = ${user.id}::uuid`.execute(tx)
    const revoked = await sql<{ n: number }>`
      with r as (update sessions set revoked_at = app_now() where user_id = ${user.id}::uuid and revoked_at is null returning 1)
      select count(*)::int as n from r`.execute(tx)
    const location = await tx
      .selectFrom('locations')
      .select('id')
      .orderBy('created_at')
      .executeTakeFirstOrThrow()
    await audit.record(tx, {
      locationId: location.id,
      action: 'user.password_reset_cli',
      entityType: 'user',
      entityId: user.id,
      after: { enabled: o.enable === true, disabledBefore: user.disabled_at !== null },
      ctx: { actor: { name: 'break-glass CLI' } },
    })
    return { userId: user.id, sessionsRevoked: revoked.rows[0]?.n ?? 0 }
  })
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '')
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('No terminal: use --password-stdin or --password-env VAR')
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const w = rl as unknown as { _writeToOutput: (s: string) => void }
    w._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(s)
    }
    rl.question(question, (a) => {
      rl.close()
      process.stdout.write('\n')
      resolve(a)
    })
  })
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== '--')
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const email = val('email')
  if (!email) throw new Error('--email is required')
  const envVar = val('password-env')
  const password =
    (envVar ? process.env[envVar] : undefined) ??
    (argv.includes('--password-stdin') ? await readStdin() : await promptHidden('New password: '))
  if (!password) throw new Error('No password given')
  const env = loadEnv()
  const db = createDb({
    url: env.DATABASE_URL,
    searchPath: env.DB_SEARCH_PATH,
    clock: createClock(env.CLOCK_FREEZE_AT),
    poolMax: 2,
    applicationName: 'oasis-reset-password',
  })
  try {
    const r = await resetPassword(db, { email, password, enable: argv.includes('--enable') })
    console.log(
      `password set for ${email}; ${r.sessionsRevoked} session(s) revoked. Sign in, then change it under your profile.`,
    )
  } finally {
    await db.destroy()
  }
}

if (process.argv[1]?.endsWith('reset-password.ts')) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
}
