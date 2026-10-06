import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createDb, type Db } from '../../src/platform/db.js'
import { profiles, registerSeedProfile, runSeed } from '../../db/seeds/index.js'
import { dropSchema, schemaPrefix, useTestDb, worktreeHash } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

const t = useTestDb()

describe('seed runner', () => {
  it('runs the empty profile idempotently: one location, default settings, nothing else', async () => {
    const first = await runSeed({ db: t.db, clock: t.clock, profile: 'empty' })
    const second = await runSeed({ db: t.db, clock: t.clock, profile: 'empty' })
    expect(first).toEqual(['empty'])
    expect(second).toEqual(['empty'])
    expect(await t.db.selectFrom('locations').selectAll().execute()).toHaveLength(1)
    expect((await t.db.selectFrom('settings').selectAll().execute()).length).toBeGreaterThan(5)
    expect(await t.db.selectFrom('audit_log').selectAll().execute()).toHaveLength(0)
  })

  it('runs dependencies first and once, with the injected clock, ids and rng', async () => {
    const order: string[] = []
    const draws: number[] = []
    const stamp: string[] = []
    registerSeedProfile('t-base', { description: 'base', run: async () => void order.push('t-base') })
    registerSeedProfile('t-a', {
      description: 'a',
      dependsOn: ['t-base'],
      run: async () => void order.push('t-a'),
    })
    registerSeedProfile('t-b', {
      description: 'b',
      dependsOn: ['t-base', 't-a'],
      async run(ctx) {
        order.push('t-b')
        const r = ctx.rng(987654)
        draws.push(r(), r())
        stamp.push(ctx.clock.now().toISOString(), ctx.newId(), ctx.location.slug)
      },
    })
    try {
      expect(await runSeed({ db: t.db, clock: t.clock, profile: 't-b' })).toEqual(['t-base', 't-a', 't-b'])
      expect(order).toEqual(['t-base', 't-a', 't-b'])
      expect(draws).toEqual([...draws].map(Number)) // numbers
      expect(draws[0]).toBeGreaterThanOrEqual(0)
      expect(stamp[0]).toBe('2026-06-13T14:36:00.000Z')
      expect(stamp[1]).toMatch(/^[0-9a-f-]{36}$/)
      expect(stamp[2]).toBe('oasis')
    } finally {
      for (const n of ['t-base', 't-a', 't-b']) delete profiles[n]
    }
  })

  it('rolls everything back when a profile fails', async () => {
    registerSeedProfile('t-fail', {
      description: 'fails',
      async run(ctx) {
        await ctx.tx
          .insertInto('notifications')
          .values({ id: ctx.newId(), location_id: ctx.location.id, kind: 'x', title: 'y' })
          .execute()
        throw new Error('seed exploded')
      },
    })
    try {
      await expect(runSeed({ db: t.db, clock: t.clock, profile: 't-fail' })).rejects.toThrow('seed exploded')
      expect(await t.db.selectFrom('notifications').selectAll().execute()).toHaveLength(0)
      expect(await t.db.selectFrom('locations').selectAll().execute()).toHaveLength(0)
    } finally {
      delete profiles['t-fail']
    }
  })

  it('rejects unknown profiles, duplicate registration and dependency cycles', async () => {
    await expect(runSeed({ db: t.db, clock: t.clock, profile: 'nope' })).rejects.toThrow(
      /Unknown seed profile "nope"/,
    )
    expect(() => registerSeedProfile('empty', { description: 'dup', run: async () => undefined })).toThrow(
      /already registered/,
    )
    registerSeedProfile('t-c1', { description: 'c1', dependsOn: ['t-c2'], run: async () => undefined })
    registerSeedProfile('t-c2', { description: 'c2', dependsOn: ['t-c1'], run: async () => undefined })
    try {
      await expect(runSeed({ db: t.db, clock: t.clock, profile: 't-c1' })).rejects.toThrow(/cycle/)
    } finally {
      delete profiles['t-c1']
      delete profiles['t-c2']
    }
  })
})

const run = (script: string, args: string[]): { status: number | null; out: string } => {
  const r = spawnSync('npx', ['tsx', script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: testDatabaseUrl(), DATABASE_URL_TEST: testDatabaseUrl() },
    timeout: 60_000,
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('migrate CLI', () => {
  const schema = `${schemaPrefix}_cli`
  let admin: Db
  beforeAll(async () => {
    admin = createDb({ url: testDatabaseUrl(), poolMax: 1 })
    await dropSchema(admin, schema)
  })
  afterAll(async () => {
    await dropSchema(admin, schema)
    await admin.destroy()
  })

  it('status reports pending, up applies, status then exits 0, up again is a no-op', () => {
    const before = run('scripts/migrate.ts', ['status', '--test', '--schema', schema])
    expect(before.status).toBe(1)
    expect(before.out).toMatch(/pending\s+20261006130000_platform_core\.sql/)
    const up = run('scripts/migrate.ts', ['up', '--test', '--schema', schema])
    expect(up.status).toBe(0)
    expect(up.out).toContain('applied 20261006130000_platform_core.sql')
    const after = run('scripts/migrate.ts', ['status', '--test', '--schema', schema])
    expect(after.status).toBe(0)
    expect(after.out).toMatch(/applied\s+20261006130000_platform_core\.sql/)
    expect(run('scripts/migrate.ts', ['up', '--test', '--schema', schema]).out).toContain('up to date')
  })

  it('new creates a timestamped, snake_cased file and refuses to overwrite', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oasis-new-'))
    const r = run('scripts/migrate.ts', ['new', 'Add Bay Table!', '--dir', dir])
    expect(r.status).toBe(0)
    const [file] = readdirSync(dir)
    expect(file).toMatch(/^\d{14}_add_bay_table\.sql$/)
    expect(readFileSync(path.join(dir, file!), 'utf8')).toContain('app_now()')
    expect(run('scripts/migrate.ts', ['new']).status).toBe(1)
  })

  it('prints usage for an unknown command', () => {
    const r = run('scripts/migrate.ts', ['frobnicate'])
    expect(r.status).toBe(2)
    expect(r.out).toContain('usage: pnpm migrate')
  })
})

describe('db:schema snapshot', () => {
  it('the committed db/schema.sql matches the migrations (and the scratch schema is cleaned up)', async () => {
    const r = run('scripts/db-schema.ts', ['--check'])
    expect(r.out).toContain('up to date')
    expect(r.status).toBe(0)
    const left = await sql<{
      n: number
    }>`select count(*)::int as n from pg_namespace where nspname like 'schema\_dump\_%' and nspname = ${`schema_dump_${worktreeHash}`}`.execute(
      t.db,
    )
    expect(left.rows[0]!.n).toBe(0)
  })
})
