// Seed runner: pnpm seed -- --profile <name> [--url <db url>] [--list]
// Profiles register themselves in `profiles` (one import per profile file, added by the vertical that owns the data).
// The runner owns nothing but the plumbing: one transaction, the injected clock, ids and RNG, and the base location.
import { existsSync } from 'node:fs'
import { loadEnv } from '../../src/config/env.js'
import { createClock, type Clock } from '../../src/platform/clock.js'
import { createDb, transaction, type Db, type Tx } from '../../src/platform/db.js'
import { createIdGenerator, type NewId } from '../../src/platform/ids.js'
import { ensureLocation, type Location } from '../../src/platform/locations.js'
import { mulberry32, type Rng } from '../../src/platform/random.js'
import { peopleProfile } from './people.js'
import { domainSeedProfiles } from './domain.js'
import { schedulingSeedProfiles } from './scheduling.js'
import { paymentsSeedProfiles } from './payments.js'
import { membershipsSeedProfiles } from './memberships.js'
import { messagingProfile } from './messaging.js'

export interface SeedContext {
  tx: Tx
  clock: Clock
  newId: NewId
  /** Deterministic generator; a profile seeds its own via rng(seed) so output is reproducible. */
  rng: (seed: number) => Rng
  location: Location
  log: (line: string) => void
}

export interface SeedProfile {
  description: string
  /** Profiles that must run first (e.g. parity-pay needs base). They run once, in order. */
  dependsOn?: readonly string[]
  run(ctx: SeedContext): Promise<void>
}

export const profiles: Record<string, SeedProfile> = {
  empty: {
    description: 'Only the location row and default settings; no domain data',
    async run() {
      // ensureLocation in the runner already did everything
    },
  },
}

export function registerSeedProfile(name: string, profile: SeedProfile): void {
  if (profiles[name]) throw new Error(`Seed profile "${name}" is already registered`)
  profiles[name] = profile
}

registerSeedProfile('people', peopleProfile)
for (const [name, profile] of Object.entries(domainSeedProfiles)) registerSeedProfile(name, profile)
for (const [name, profile] of Object.entries(schedulingSeedProfiles)) registerSeedProfile(name, profile)
for (const [name, profile] of Object.entries(paymentsSeedProfiles)) registerSeedProfile(name, profile)
registerSeedProfile('messaging', messagingProfile)
// A seeded design database can text through the simulator device out of the box (a wrap, not a dependency, so the
// profile order that `design` reports stays people, domain, base, domain-design, design).
const designRun = profiles.design!.run.bind(profiles.design)
profiles.design!.run = async (ctx) => {
  await designRun(ctx)
  await messagingProfile.run(ctx)
}
for (const [name, profile] of Object.entries(membershipsSeedProfiles)) registerSeedProfile(name, profile)

function resolveOrder(name: string, seen: string[] = []): string[] {
  const p = profiles[name]
  if (!p) throw new Error(`Unknown seed profile "${name}". Known: ${Object.keys(profiles).join(', ')}`)
  if (seen.includes(name)) throw new Error(`Seed profile dependency cycle: ${[...seen, name].join(' -> ')}`)
  const out: string[] = []
  for (const dep of p.dependsOn ?? [])
    for (const n of resolveOrder(dep, [...seen, name])) if (!out.includes(n)) out.push(n)
  out.push(name)
  return out
}

export interface RunSeedOptions {
  db: Db
  clock: Clock
  profile: string
  timezone?: string
  log?: (line: string) => void
}

export async function runSeed(o: RunSeedOptions): Promise<string[]> {
  const order = resolveOrder(o.profile)
  const log = o.log ?? (() => undefined)
  const newId = createIdGenerator(o.clock)
  await transaction(o.db, async (tx) => {
    const location = await ensureLocation(tx, newId, { timezone: o.timezone })
    for (const name of order) {
      log(`seeding ${name}`)
      await profiles[name]!.run({ tx, clock: o.clock, newId, rng: mulberry32, location, log })
    }
  })
  return order
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env')
  const args = process.argv.slice(2).filter((a) => a !== '--')
  const flag = (n: string): string | undefined => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined)
  if (args.includes('--list')) {
    for (const [name, p] of Object.entries(profiles)) console.log(`${name.padEnd(12)} ${p.description}`)
    return
  }
  const env = loadEnv({ ...process.env, ...(flag('--url') ? { DATABASE_URL: flag('--url')! } : {}) })
  const clock = createClock(env.CLOCK_FREEZE_AT)
  const db = createDb({
    url: env.DATABASE_URL,
    searchPath: env.DB_SEARCH_PATH,
    clock,
    poolMax: 2,
    applicationName: 'oasis-seed',
  })
  try {
    const ran = await runSeed({
      db,
      clock,
      profile: flag('--profile') ?? process.env.SEED_PROFILE ?? 'empty',
      timezone: env.BUSINESS_TZ,
      log: console.log,
    })
    console.log(`seeded: ${ran.join(' -> ')}`)
  } finally {
    await db.destroy()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
}
