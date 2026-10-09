// url_to_pgenv (deploy/lib/common.sh) turns DATABASE_URL into PG* variables for psql, pg_dump and pg_restore. The TLS settings must
// travel with it: on Aurora/RDS the URL carries sslmode=verify-full&sslrootcert=..., and without PGSSLROOTCERT libpq looks for
// ~/.postgresql/root.crt and refuses to connect (backups and the restore drill failed against Aurora that way).
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const pgenv = (url: string): Record<string, string> => {
  const r = spawnSync(
    'bash',
    [
      '-c',
      'source deploy/lib/common.sh; url_to_pgenv "$1"; for v in PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE PGSSLROOTCERT PGSSLCERT PGSSLKEY; do printf "%s=%s\\n" "$v" "${!v:-}"; done',
      'pgenv',
      url,
    ],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
  )
  expect(r.status, r.stderr).toBe(0)
  return Object.fromEntries(
    r.stdout
      .trim()
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
}

describe('url_to_pgenv', () => {
  it('carries sslmode and sslrootcert (Aurora), decoding them', () => {
    const e = pgenv(
      'postgres://oasis_app:p%40ss@db.cluster-x.us-east-1.rds.amazonaws.com:5432/oasis?sslmode=verify-full&sslrootcert=%2Fetc%2Foasis%2Frds-global-bundle.pem',
    )
    expect(e).toMatchObject({
      PGHOST: 'db.cluster-x.us-east-1.rds.amazonaws.com',
      PGPORT: '5432',
      PGUSER: 'oasis_app',
      PGPASSWORD: 'p@ss',
      PGDATABASE: 'oasis',
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: '/etc/oasis/rds-global-bundle.pem',
    })
  })
  it('carries a client certificate and key, and leaves TLS unset for a local URL', () => {
    expect(
      pgenv('postgres://u:p@127.0.0.1/oasis?sslmode=require&sslcert=/c.pem&sslkey=/k.pem'),
    ).toMatchObject({
      PGSSLMODE: 'require',
      PGSSLCERT: '/c.pem',
      PGSSLKEY: '/k.pem',
      PGSSLROOTCERT: '',
    })
    expect(pgenv('postgres://u:p@127.0.0.1:5433/oasis')).toMatchObject({
      PGPORT: '5433',
      PGSSLMODE: '',
      PGSSLROOTCERT: '',
    })
  })
  it('use_pg_client puts PG_BINDIR first on the PATH, from the environment or from common.env', () => {
    const run = (env: Record<string, string>): string[] => {
      const r = spawnSync(
        'bash',
        ['-c', 'source deploy/lib/common.sh; use_pg_client; printf "%s\\n" "${PATH%%:*}"'],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', ...env },
        },
      )
      expect(r.status, r.stderr).toBe(0)
      return r.stdout.split('\n')
    }
    expect(run({ PG_BINDIR: '/opt/oasis/pgclient/17/usr/bin' })[0]).toBe('/opt/oasis/pgclient/17/usr/bin')
    const etc = mkdtempSync(path.join(tmpdir(), 'oasis-pgclient-'))
    writeFileSync(path.join(etc, 'common.env'), 'NODE_ENV=production\nPG_BINDIR=/opt/x/17/usr/bin\n')
    expect(run({ OASIS_ETC: etc })[0]).toBe('/opt/x/17/usr/bin')
    expect(run({ OASIS_ETC: '/nonexistent' })[0]).not.toContain('pgclient')
  })
})
