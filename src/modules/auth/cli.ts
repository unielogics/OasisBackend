// pnpm user:create -- --email owner@example.com --first Amara --last Okoye [--phone "(305) 555-0101"] [--title Owner]
//                      [--roles super,mgmt] [--password-env VAR | --password-stdin]
// Creates an active employee with a login (default role: Super Admin) straight in the database, for the first owner or
// to recover access. The password is read from the environment variable named by --password-env, from stdin, or asked
// for with echo off; it is never taken from the command line.
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { loadEnv } from '../../config/env.js'
import { createClock } from '../../platform/clock.js'
import { createDb } from '../../platform/db.js'
import { createIdGenerator } from '../../platform/ids.js'
import { ensureLocation } from '../../platform/locations.js'
import { createAccount } from './accounts.js'
import { createIdentity } from './identity.js'

function parseArgs(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>()
  const args = argv.filter((a) => a !== '--')
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (!a.startsWith('--')) throw new Error(`Unexpected argument "${a}"`)
    const key = a.slice(2)
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) out.set(key, true)
    else {
      out.set(key, next)
      i++
    }
  }
  return out
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '')
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('No terminal: use --password-env VAR or --password-stdin')
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const w = rl as unknown as { _writeToOutput: (s: string) => void }
    w._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(s)
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const args = parseArgs(process.argv.slice(2))
  const str = (k: string): string | undefined => {
    const v = args.get(k)
    return typeof v === 'string' ? v : undefined
  }
  const email = str('email')
  if (!email) throw new Error('--email is required')
  const envVar = str('password-env')
  const password =
    (envVar ? process.env[envVar] : undefined) ??
    (args.has('password-stdin') ? await readStdin() : undefined) ??
    (await promptHidden('Password: '))
  if (!password) throw new Error('No password given')

  const env = loadEnv()
  const clock = createClock(env.CLOCK_FREEZE_AT)
  const db = createDb({
    url: env.DATABASE_URL,
    searchPath: env.DB_SEARCH_PATH,
    clock,
    poolMax: 2,
    applicationName: 'oasis-user-create',
  })
  try {
    const newId = createIdGenerator(clock)
    const location = await ensureLocation(db, newId, { timezone: env.BUSINESS_TZ })
    const { identity } = createIdentity({ db, clock, env, newId, locationId: location.id })
    const made = await createAccount(identity, {
      email,
      password,
      first: str('first') ?? 'Admin',
      last: str('last'),
      title: str('title'),
      phone: str('phone'),
      roles: str('roles')
        ?.split(',')
        .map((r) => r.trim())
        .filter(Boolean),
    })
    console.log(
      `${made!.attachedToExisting ? 'added a login to the existing employee' : 'created'} ${made!.email} (employee ${made!.employeeId})`,
    )
  } finally {
    await db.destroy()
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
