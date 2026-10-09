// url_to_pgenv (deploy/lib/common.sh) turns DATABASE_URL into PG* variables for psql, pg_dump and pg_restore. The TLS settings must
// travel with it: on Aurora/RDS the URL carries sslmode=verify-full&sslrootcert=..., and without PGSSLROOTCERT libpq looks for
// ~/.postgresql/root.crt and refuses to connect (backups and the restore drill failed against Aurora that way).
import { spawnSync } from 'node:child_process'
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
  it('PG_BINDIR puts a newer client first on the PATH, with its private libraries', () => {
    const r = spawnSync(
      'bash',
      ['-c', 'source deploy/lib/common.sh; printf "%s\\n%s\\n" "${PATH%%:*}" "${LD_LIBRARY_PATH%%:*}"'],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', PG_BINDIR: '/opt/oasis/pgclient/17/usr/bin' },
      },
    )
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.split('\n')[0]).toBe('/opt/oasis/pgclient/17/usr/bin')
  })
})
