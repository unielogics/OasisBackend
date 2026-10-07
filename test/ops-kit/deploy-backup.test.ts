// backup.sh and restore-drill.sh against the real Postgres, with real pg_dump / pg_restore, on a seeded copy of the schema
// (parity-pay: 105 invoices and their ledger). The drill runs in schema mode because the test role may not create databases.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { FixedClock } from '../../src/platform/clock.js'
import { createDb, type Db } from '../../src/platform/db.js'
import { migrateUp } from '../../src/platform/migrate.js'
import { schemaPrefix } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { DEPLOY, script, sh, tempDir, writeExecutable } from './deploy-helpers.js'

const which = (cmd: string): string | undefined => {
  try {
    return (
      execFileSync('which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || undefined
    )
  } catch {
    return undefined
  }
}
const REAL_PG_DUMP = which('pg_dump')
const hasPg = !!REAL_PG_DUMP && !!which('pg_restore') && !!which('psql')
const url = testDatabaseUrl()
const clock = new FixedClock('2026-06-13T10:36:00-04:00')
const schemas: string[] = []
const dbs: Db[] = []
const tmps: Array<() => void> = []
let admin: Db

beforeAll(async () => {
  admin = createDb({ url, poolMax: 2, applicationName: 'oasis-ops-test' })
  // schemas left behind by an earlier killed run
  const old = await sql<{
    nspname: string
  }>`select nspname from pg_namespace where nspname like ${`ops_${schemaPrefix}%`}`.execute(admin)
  for (const r of old.rows) await sql`drop schema ${sql.id(r.nspname)} cascade`.execute(admin)
})
afterAll(async () => {
  for (const s of schemas) await sql`drop schema if exists ${sql.id(s)} cascade`.execute(admin)
  for (const d of dbs) await d.destroy()
  await admin.destroy()
  for (const t of tmps) t()
})

let counter = 0
/** A migrated (and optionally seeded) schema of its own, plus an open connection into it. */
async function source(seed: boolean): Promise<{ name: string; db: Db }> {
  const name = `ops_${schemaPrefix}_${++counter}`.toLowerCase()
  schemas.push(name)
  await migrateUp({ url }, { schema: name, clock })
  const db = createDb({
    url,
    searchPath: `${name},public`,
    clock,
    poolMax: 2,
    applicationName: 'oasis-ops-test',
  })
  dbs.push(db)
  if (seed) await runSeed({ db, clock, profile: 'parity-pay' })
  return { name, db }
}

function world() {
  const t = tempDir('oasis-bk-')
  tmps.push(t.cleanup)
  const backups = path.join(t.dir, 'backups')
  const state = path.join(t.dir, 'state')
  const env: Record<string, string> = {
    DATABASE_URL: url,
    OASIS_BACKUP_DIR: backups,
    OASIS_STATE: state,
    OASIS_ETC: path.join(t.dir, 'etc'),
    OASIS_PREFIX: path.join(t.dir, 'prefix'),
  }
  return {
    dir: t.dir,
    backups,
    state,
    env,
    backup: (schema: string, extra: string[] = [], more: Record<string, string> = {}) =>
      sh(script('backup.sh'), ['--schemas', schema, ...extra], { ...env, ...more }),
    drill: (schema: string, extra: string[] = [], more: Record<string, string> = {}) =>
      sh(script('restore-drill.sh'), ['--mode', 'schema', '--schema', schema, '--latest', ...extra], {
        ...env,
        ...more,
      }),
    daily: () =>
      existsSync(path.join(backups, 'daily')) ? readdirSync(path.join(backups, 'daily')).sort() : [],
    list: (sub: string) =>
      existsSync(path.join(backups, sub))
        ? readdirSync(path.join(backups, sub))
            .filter((f) => f.endsWith('.dump'))
            .sort()
        : [],
  }
}
const dropSchema = (name: string) => sql`drop schema ${sql.id(name)} cascade`.execute(admin)
const manifestOf = (w: ReturnType<typeof world>) => {
  const f = w.daily().find((n) => n.endsWith('.manifest.json'))!
  return JSON.parse(readFileSync(path.join(w.backups, 'daily', f), 'utf8')) as {
    counts: Record<string, number>
    migrations: number
    sha256: string
    schemas: string
    bytes: number
    snapshot: string
    file: string
  }
}

describe.skipIf(!hasPg)('backup.sh and restore-drill.sh', () => {
  it('back up a seeded database with a manifest whose counts are exact, then restore it and prove the ledger', async () => {
    const src = await source(true)
    const w = world()
    const b = await w.backup(src.name)
    expect(b.code, b.out).toBe(0)
    expect(b.out).toMatch(/backup ok: oasis-\d{8}T\d{6}Z-manual\.dump/)

    expect(w.daily()).toHaveLength(3)
    const m = manifestOf(w)
    const live = await sql<{ n: number }>`select count(*)::int as n from ledger_events`.execute(src.db)
    expect(m.counts[`${src.name}.ledger_events`]).toBe(live.rows[0]!.n)
    expect(m.counts[`${src.name}.invoices`]).toBe(105)
    expect(m.migrations).toBe(
      readdirSync(path.join(process.cwd(), 'db/migrations')).filter((f) => f.endsWith('.sql')).length,
    )
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(m.schemas).toBe(src.name)
    const dump = path.join(w.backups, 'daily', m.file)
    expect(statSync(dump).size).toBe(m.bytes)
    expect(readFileSync(`${dump}.sha256`, 'utf8')).toBe(`${m.sha256}  ${m.file}\n`)
    expect(statSync(w.backups).mode & 0o777).toBe(0o700)
    expect(execFileSync('pg_restore', ['--list', dump]).toString()).toContain('ledger_events')

    // the same ledger checks, run read-only against the live database
    const live2 = await sh(script('ledger-check.sh'), ['--schema', src.name], w.env)
    expect(live2.code, live2.out).toBe(0)
    expect(live2.out).toMatch(/PASS ledger: paid and refunded of every invoice equal the sum of its events/)
    expect(live2.out).toMatch(/the ledger is consistent/)

    await dropSchema(src.name) // the drill restores it afresh, which it refuses to do over an existing schema
    const d = await w.drill(src.name)
    expect(d.code, d.out).toBe(0)
    expect(d.out).toMatch(/PASS checksum matches/)
    expect(d.out).toMatch(/PASS pg_restore loaded the whole archive/)
    expect(d.out).toMatch(/PASS row counts equal the manifest \(\d+ tables, \d+ rows\)/)
    expect(d.out).toMatch(/PASS \d+ migrations applied, as in the manifest/)
    expect(d.out).toMatch(/PASS ledger: paid and refunded of every invoice equal the sum of its events/)
    expect(d.out).toMatch(/PASS ledger: no negative balance/)
    expect(d.out).toMatch(/PASS ledger: event sequence numbers are unique/)
    expect(d.out).toMatch(/PASS ledger: the append-only guard trigger is present/)
    expect(d.out).toMatch(/ledger totals: \d+ events, 105 invoices, paid \d+ cents/)
    expect(d.out).toMatch(/restore drill passed/)
    const gone = await sql`select 1 from pg_namespace where nspname = ${src.name}`.execute(admin)
    expect(gone.rows).toHaveLength(0) // the scratch copy is dropped
    expect(existsSync(path.join(w.state, 'drills/last-ok'))).toBe(true)
    expect(readdirSync(path.join(w.state, 'drills')).some((f) => f.endsWith('.json'))).toBe(true)
  }, 120_000)

  it('the drill refuses to restore over a schema that exists, and --keep leaves the scratch copy for inspection', async () => {
    const src = await source(false)
    const w = world()
    expect((await w.backup(src.name)).code).toBe(0)
    const refused = await w.drill(src.name)
    expect(refused.code).not.toBe(0)
    expect(refused.out).toMatch(/already exists .* never restores over an existing schema/)
    await dropSchema(src.name)
    const kept = await w.drill(src.name, ['--keep'])
    expect(kept.code, kept.out).toBe(0)
    expect(kept.out).toMatch(/kept the scratch copy/)
    const there = await sql`select 1 from pg_namespace where nspname = ${src.name}`.execute(admin)
    expect(there.rows).toHaveLength(1)
  }, 120_000)

  it('detects a manifest that disagrees with what was restored (a row lost or added)', async () => {
    const src = await source(false)
    const w = world()
    await w.backup(src.name)
    const f = path.join(
      w.backups,
      'daily',
      w.daily().find((n) => n.endsWith('.manifest.json'))!,
    )
    const m = JSON.parse(readFileSync(f, 'utf8'))
    m.counts[`${src.name}.locations`] += 1
    writeFileSync(f, JSON.stringify(m))
    await dropSchema(src.name)
    const d = await w.drill(src.name)
    expect(d.code).toBe(1)
    expect(d.out).toMatch(
      /FAIL row counts differ from the manifest: .*locations: backup had \d+ rows, restored \d+/,
    )
    const left = await sql`select 1 from pg_namespace where nspname = ${src.name}`.execute(admin)
    expect(left.rows).toHaveLength(0)
  }, 120_000)

  it('detects a corrupted file by its checksum, before restoring anything', async () => {
    const src = await source(false)
    const w = world()
    await w.backup(src.name)
    const dump = path.join(
      w.backups,
      'daily',
      w.daily().find((n) => n.endsWith('.dump'))!,
    )
    const bytes = readFileSync(dump)
    bytes[Math.floor(bytes.length / 2)]! ^= 0xff
    writeFileSync(dump, bytes)
    await dropSchema(src.name)
    const d = await w.drill(src.name)
    expect(d.code).toBe(1)
    expect(d.out).toMatch(/FAIL checksum of .* does not match/)
    expect(d.out).not.toMatch(/PASS pg_restore loaded/)
    const left = await sql`select 1 from pg_namespace where nspname = ${src.name}`.execute(admin)
    expect(left.rows).toHaveLength(0)
  }, 120_000)

  it('detects ledger corruption: an invoice calculation that no longer equals the sum of its events', async () => {
    const src = await source(true)
    const w = world()
    // simulate drift in the calc function (what a bad migration or a hand edit would do): every payment counts one cent too much
    const def = await sql<{
      def: string
    }>`select pg_get_functiondef('invoice_calc_of'::regproc) as def`.execute(src.db)
    const drifted = def.rows[0]!.def.replace(
      "filter (where type = 'pay'), 0)",
      "filter (where type = 'pay'), 0) + 1",
    )
    expect(drifted).not.toBe(def.rows[0]!.def)
    await sql.raw(drifted).execute(src.db)
    const liveBad = await sh(script('ledger-check.sh'), ['--schema', src.name], w.env)
    expect(liveBad.code).toBe(1)
    expect(liveBad.out).toMatch(
      /FAIL ledger: 105 invoice\(s\) where invoice_calc differs from the sum of ledger_events/,
    )
    expect(liveBad.out).toMatch(/Do not edit ledger_events/)
    expect((await w.backup(src.name)).code).toBe(0)
    await dropSchema(src.name)
    const d = await w.drill(src.name)
    expect(d.code).toBe(1)
    expect(d.out).toMatch(
      /FAIL ledger: \d+ invoice\(s\) where invoice_calc differs from the sum of ledger_events/,
    )
    // the counts themselves were right, so only the ledger check fails
    expect(d.out).toMatch(/PASS row counts equal the manifest/)
  }, 120_000)

  it('detects a restored ledger that is no longer append-only (the guard trigger is gone)', async () => {
    const src = await source(false)
    const w = world()
    await sql`drop trigger ledger_events_guard on ledger_events`.execute(src.db)
    await w.backup(src.name)
    await dropSchema(src.name)
    const d = await w.drill(src.name)
    expect(d.code).toBe(1)
    expect(d.out).toMatch(/FAIL ledger: the ledger_events_guard trigger is missing/)
  }, 120_000)

  it('dumps and counts from one snapshot: rows written while pg_dump runs are in neither, so the drill still agrees', async () => {
    const src = await source(false)
    const w = world()
    const bin = path.join(w.dir, 'bin')
    // a pg_dump stand-in that commits a new row first, then runs the real pg_dump with the snapshot it was given
    writeExecutable(
      path.join(bin, 'pg_dump'),
      `#!/usr/bin/env bash\n[[ "$1" == --format* ]] && PGOPTIONS="-c search_path=${src.name},public" psql -X -q -c "insert into locations (id, slug, name, timezone) values (gen_random_uuid(), 'late-' || floor(random() * 1e9)::text, 'Written during the dump', 'America/New_York')"\nexec ${REAL_PG_DUMP} "$@"\n`,
    )
    const before = (await sql<{ n: number }>`select count(*)::int as n from locations`.execute(src.db))
      .rows[0]!.n
    const b = await w.backup(src.name, [], { PATH: `${bin}:${process.env.PATH}` })
    expect(b.code, b.out).toBe(0)
    const after = (await sql<{ n: number }>`select count(*)::int as n from locations`.execute(src.db))
      .rows[0]!.n
    expect(after).toBe(before + 1)
    expect(manifestOf(w).counts[`${src.name}.locations`]).toBe(before)
    await dropSchema(src.name)
    const d = await w.drill(src.name)
    expect(d.code, d.out).toBe(0)
  }, 120_000)

  it('keeps 7 daily, 4 weekly and 12 monthly nightly backups, hard-links the Sunday and 1st-of-month ones, and keeps other labels apart', async () => {
    const src = await source(false)
    const w = world()
    const days = [
      '2026-09-27',
      '2026-10-01',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
    ]
    for (const d of days) {
      const r = await w.backup(src.name, ['--label', 'nightly'], {
        BACKUP_NOW: `${d}T07:15:00Z`,
        BACKUP_KEEP_DAILY: '7',
        BACKUP_KEEP_WEEKLY: '1',
      })
      expect(r.code, r.out).toBe(0)
    }
    const stamps = (names: string[]): string[] => names.map((n) => /oasis-(\d{8})T/.exec(n)![1]!)
    expect(stamps(w.list('daily'))).toEqual([
      '20261004',
      '20261005',
      '20261006',
      '20261007',
      '20261008',
      '20261009',
      '20261010',
    ])
    expect(stamps(w.list('weekly'))).toEqual(['20261004']) // Sundays: 27 Sep was pruned, KEEP_WEEKLY=1
    expect(stamps(w.list('monthly'))).toEqual(['20261001']) // the 1st survives although its daily copy is gone
    // the sidecars follow their dump
    expect(w.daily().filter((n) => n.includes('20260927'))).toEqual([])
    expect(
      readdirSync(path.join(w.backups, 'monthly'))
        .filter((n) => n.includes('20261001'))
        .sort(),
    ).toHaveLength(3)
    // a hard link: the Sunday copy is the same file as the daily one
    const a = statSync(path.join(w.backups, 'daily', w.list('daily')[0]!))
    const b = statSync(path.join(w.backups, 'weekly', w.list('weekly')[0]!))
    expect(a.ino).toBe(b.ino)
    expect(a.nlink).toBe(2)

    for (let i = 0; i < 5; i++)
      await w.backup(src.name, ['--label', 'pre-deploy'], {
        BACKUP_NOW: `2026-10-11T0${i}:00:00Z`,
        BACKUP_KEEP_OTHER: '3',
      })
    expect(w.list('daily').filter((n) => n.endsWith('-pre-deploy.dump'))).toHaveLength(3)
    expect(w.list('daily').filter((n) => n.endsWith('-nightly.dump'))).toHaveLength(7)
  }, 180_000)

  it('--dry-run writes nothing, and bad options are refused', async () => {
    const src = await source(false)
    const w = world()
    const r = await w.backup(src.name, ['--dry-run'])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/would dump database/)
    expect(existsSync(w.backups)).toBe(false)
    expect((await sh(script('backup.sh'), ['--schemas', 'a;drop table x'], w.env)).out).toMatch(
      /--schemas must be/,
    )
    expect((await sh(script('backup.sh'), ['--label', 'Bad Label'], w.env)).out).toMatch(/--label must be/)
  })

  it('uploads an encrypted copy (AES-256-GCM) with server-side encryption, never the readable dump, and the drill can restore from it', async () => {
    const src = await source(false)
    const w = world()
    const bin = path.join(w.dir, 'bin')
    const uploads = path.join(w.dir, 'uploads')
    mkdirSync(uploads)
    writeExecutable(
      path.join(bin, 'aws'),
      `#!/usr/bin/env bash\necho "aws $*" >> "${w.dir}/aws.log"\ncp "\${@: -2:1}" "${uploads}/$(basename "\${@: -1}")"\n`,
    )
    const keyFile = path.join(w.dir, 'backup.key')
    execFileSync('node', [path.join(DEPLOY, 'lib/backup-crypt.mjs'), 'keygen', keyFile])
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      BACKUP_S3_URI: 's3://oasis-backups/prod',
      BACKUP_ENCRYPTION_KEY_FILE: keyFile,
    }
    const b = await w.backup(src.name, ['--label', 'nightly'], env)
    expect(b.code, b.out).toBe(0)
    expect(b.out).toMatch(/encrypted the copy for upload/)
    const log = readFileSync(path.join(w.dir, 'aws.log'), 'utf8')
    expect(log).toMatch(
      /aws s3 cp --only-show-errors --sse AES256 \S+\.dump\.enc s3:\/\/oasis-backups\/prod\/oasis-\S+\.dump\.enc/,
    )
    expect(log).toMatch(/\.manifest\.json s3:\/\/oasis-backups\/prod\/oasis-\S+\.manifest\.json/)
    expect(log).not.toMatch(/\.dump s3:/) // the readable dump is never uploaded
    const enc = readdirSync(uploads).find((n) => n.endsWith('.dump.enc'))!
    const encBytes = readFileSync(path.join(uploads, enc))
    expect(encBytes.subarray(0, 8).toString()).toBe('OASISBK1')
    const plain = readFileSync(
      path.join(
        w.backups,
        'daily',
        w.daily().find((n) => n.endsWith('.dump'))!,
      ),
    )
    expect(encBytes.includes(plain.subarray(100, 140))).toBe(false)

    // a restore from the downloaded copy: encrypted dump + its manifest and checksum
    const dl = path.join(w.dir, 'download')
    mkdirSync(dl)
    copyFileSync(path.join(uploads, enc), path.join(dl, enc))
    for (const ext of ['manifest.json', 'sha256'])
      copyFileSync(
        path.join(w.backups, 'daily', `${enc.replace('.enc', '')}.${ext}`),
        path.join(dl, `${enc.replace('.enc', '')}.${ext}`),
      )
    await dropSchema(src.name)
    const good = await sh(
      script('restore-drill.sh'),
      ['--mode', 'schema', '--schema', src.name, '--file', path.join(dl, enc)],
      { ...w.env, BACKUP_ENCRYPTION_KEY_FILE: keyFile },
    )
    expect(good.code, good.out).toBe(0)

    const otherKey = path.join(w.dir, 'other.key')
    execFileSync('node', [path.join(DEPLOY, 'lib/backup-crypt.mjs'), 'keygen', otherKey])
    const bad = await sh(
      script('restore-drill.sh'),
      ['--mode', 'schema', '--schema', src.name, '--file', path.join(dl, enc)],
      { ...w.env, BACKUP_ENCRYPTION_KEY_FILE: otherKey },
    )
    expect(bad.code).toBe(1)
    expect(bad.out).toMatch(/could not be decrypted \(wrong key, or the file was altered\)/)
    const nokey = await sh(
      script('restore-drill.sh'),
      ['--mode', 'schema', '--schema', src.name, '--file', path.join(dl, enc)],
      w.env,
    )
    expect(nokey.out).toMatch(/is encrypted: set BACKUP_ENCRYPTION_KEY_FILE/)
  }, 120_000)

  it('without an encryption key the upload is allowed but warned about', async () => {
    const src = await source(false)
    const w = world()
    const bin = path.join(w.dir, 'bin')
    writeExecutable(path.join(bin, 'aws'), '#!/usr/bin/env bash\nexit 0\n')
    const b = await w.backup(src.name, [], { PATH: `${bin}:${process.env.PATH}`, BACKUP_S3_URI: 's3://x/y' })
    expect(b.code, b.out).toBe(0)
    expect(b.out).toMatch(/BACKUP_ENCRYPTION_KEY_FILE is not set: the dump is uploaded readable/)
  })

  it('database mode needs a role that may create databases and says so', async () => {
    const src = await source(false)
    const w = world()
    await w.backup(src.name)
    const none = await sh(script('restore-drill.sh'), ['--latest'], w.env)
    expect(none.out).toMatch(/RESTORE_ADMIN_URL is not set/)
    const noCreate = await sh(script('restore-drill.sh'), ['--latest'], { ...w.env, RESTORE_ADMIN_URL: url })
    expect(noCreate.code).not.toBe(0)
    expect(noCreate.out).toMatch(/cannot create the scratch database \(does the role have CREATEDB\?\)/)
  }, 120_000)

  it('the password stays off command lines', async () => {
    const src = await source(false)
    const w = world()
    const bin = path.join(w.dir, 'bin')
    const pw = decodeURIComponent(new URL(url).password)
    writeExecutable(
      path.join(bin, 'pg_dump'),
      `#!/usr/bin/env bash\nps -o args= -p $$ -p $PPID >> "${w.dir}/ps.log"\nexec ${REAL_PG_DUMP} "$@"\n`,
    )
    const b = await w.backup(src.name, [], { PATH: `${bin}:${process.env.PATH}` })
    expect(b.code, b.out).toBe(0)
    expect(readFileSync(path.join(w.dir, 'ps.log'), 'utf8')).not.toContain(pw)
    expect(b.out).not.toContain(pw)
  })
})

describe('backup-crypt.mjs', () => {
  it('round-trips, authenticates, and leaves no output behind on failure', () => {
    const t = tempDir('oasis-crypt-')
    tmps.push(t.cleanup)
    const key = path.join(t.dir, 'k')
    const crypt = (...a: string[]) =>
      execFileSync('node', [path.join(DEPLOY, 'lib/backup-crypt.mjs'), ...a], {
        env: { ...process.env, BACKUP_ENCRYPTION_KEY_FILE: key },
        stdio: 'pipe',
      })
    crypt('keygen', key)
    expect(() => crypt('keygen', key)).toThrow(/refusing to overwrite/)
    const plain = path.join(t.dir, 'p')
    writeFileSync(plain, Buffer.alloc(300_000, 'dump data '))
    const enc = path.join(t.dir, 'e')
    crypt('encrypt', plain, enc)
    expect(statSync(enc).size).toBe(300_000 + 8 + 12 + 16)
    const out = path.join(t.dir, 'o')
    crypt('decrypt', enc, out)
    expect(readFileSync(out).equals(readFileSync(plain))).toBe(true)

    const bytes = readFileSync(enc)
    bytes[5000]! ^= 1
    writeFileSync(enc, bytes)
    const bad = path.join(t.dir, 'bad')
    expect(() => crypt('decrypt', enc, bad)).toThrow(/Unsupported state or unable to authenticate data/)
    expect(existsSync(bad)).toBe(false)
    writeFileSync(enc, bytes.subarray(0, bytes.length - 20)) // truncated
    expect(() => crypt('decrypt', enc, bad)).toThrow()
    expect(existsSync(bad)).toBe(false)
    chmodSync(key, 0o600)
  })
})
