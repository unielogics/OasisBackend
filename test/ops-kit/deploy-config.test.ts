// The files install.sh writes (env, systemd, nginx), read back the way systemd and nginx would read them.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { envSchema, loadEnv } from '../../src/config/env.js'
import { SECRET_KEYS, secretKeyProblems } from '../../src/config/secrets-source.js'
import { invalidValues, parseDotenv } from '../../scripts/secrets-push.js'
import { emailEnvShape } from '../../src/integrations/email/config.js'
import { storageEnvShape } from '../../src/integrations/storage/config.js'
import {
  DEPLOY,
  REPO,
  expandIncludes,
  find,
  locationsOf,
  matchLocation,
  names,
  parseEnvFile,
  parseNginx,
  readText,
  sh,
  tempDir,
  type Directive,
} from './deploy-helpers.js'
import { useStage } from './deploy-stage.js'

const stage = useStage()
const read = (rel: string): string => readText(path.join(stage.root, rel))
const envShape = (envSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } })._def
  .schema.shape

describe('environment templates', () => {
  const templates = ['common', 'api', 'worker', 'web'].map((n) => ({
    n,
    text: readText(path.join(DEPLOY, 'env', `${n}.env.example`)),
  }))
  const all = templates.map((t) => t.text).join('\n')

  it('name every variable of src/config/env.ts, and nothing else the app does not know', () => {
    const declared = new Set(Object.keys(envShape))
    const known = new Set([
      ...declared,
      ...Object.keys(storageEnvShape),
      ...Object.keys(emailEnvShape),
      'NODE_OPTIONS',
      'WEB_HOST',
      'WEB_PORT',
      'NEXT_TELEMETRY_DISABLED',
    ])
    const present = names(all)
    expect([...declared].filter((k) => !present.has(k))).toEqual([])
    expect([...present].filter((k) => !known.has(k))).toEqual([])
  })

  it('document each variable with a comment on the line above it (or a comment block it belongs to)', () => {
    for (const t of templates) {
      const lines = t.text.split('\n')
      lines.forEach((line, i) => {
        if (!/^#? ?[A-Z][A-Z0-9_]*=/.test(line)) return
        let j = i - 1
        // variables listed together share the comment above the group
        while (j >= 0 && /^#? ?[A-Z][A-Z0-9_]*=/.test(lines[j]!)) j--
        expect(lines[j]?.startsWith('#'), `${t.n}.env.example line ${i + 1}: ${line}`).toBe(true)
      })
    }
  })

  it('follow systemd EnvironmentFile rules: NAME=value, comments on their own line, spaces only inside quotes', () => {
    for (const t of templates) {
      const problems: string[] = []
      parseEnvFile(t.text, (l, why) => problems.push(`${t.n}: ${l} (${why})`))
      expect(problems).toEqual([])
    }
  })

  it('install.sh names the secret and fills the URLs, writes no secret into the env files, and keeps them at 0640', () => {
    const common = parseEnvFile(read('etc/oasis/common.env'))
    expect(common.OASIS_SECRET_ID).toBe('oasis/prod/app')
    expect(common.AWS_REGION).toBe('us-east-1')
    expect(common.AWS_EC2_METADATA_DISABLED).toBeUndefined() // the instance role needs the metadata service
    expect(common.PUBLIC_API_URL).toBe('https://oasis.example.com')
    expect(common.PUBLIC_DASHBOARD_URL).toBe('https://oasis.example.com')
    for (const n of ['common', 'api', 'worker', 'web']) {
      const active = parseEnvFile(read(`etc/oasis/${n}.env`))
      expect(
        SECRET_KEYS.filter((k) => active[k] !== undefined),
        n,
      ).toEqual([])
      expect((statSync(path.join(stage.etc, `${n}.env`)).mode & 0o777).toString(8)).toBe('640')
    }
  })

  it('a new install gets the secret settings generated into a root-only seed file, ready for pnpm secrets:push', () => {
    const seedText = read('etc/oasis/secret-seed.env')
    const seed = parseEnvFile(seedText)
    expect(Object.keys(seed)).toEqual([
      'DATABASE_URL',
      'SESSION_SECRET',
      'SECRETS_KEY',
      'STORAGE_SIGNING_SECRET',
    ])
    expect(Buffer.from(seed.SECRETS_KEY!, 'base64')).toHaveLength(32)
    expect(Buffer.from(seed.SESSION_SECRET!, 'base64').length).toBeGreaterThanOrEqual(32)
    expect(seed.DATABASE_URL).toMatch(/^postgres:\/\/oasis:[0-9a-f]{48}@127\.0\.0\.1:5432\/oasis$/)
    expect((statSync(path.join(stage.etc, 'secret-seed.env')).mode & 0o777).toString(8)).toBe('600')
    const values = parseDotenv(seedText, 'secret-seed.env')
    expect(secretKeyProblems(values.keys())).toEqual({ forbidden: [], unknown: [] })
    expect(invalidValues(values)).toEqual([])
  })

  it('the templates keep every secret key commented out, and the deploy kit names the same secret keys as the app', () => {
    for (const n of ['common', 'api', 'worker', 'web']) {
      const active = parseEnvFile(readText(path.join(DEPLOY, 'env', `${n}.env.example`)))
      expect(
        SECRET_KEYS.filter((k) => active[k] !== undefined),
        n,
      ).toEqual([])
    }
    const bash = /^OASIS_SECRET_KEYS=\(([^)]*)\)$/m
      .exec(readText(path.join(DEPLOY, 'lib/common.sh')))![1]!
      .split(/\s+/)
    expect(bash).toEqual([...SECRET_KEYS])
  })

  it('the worker loads the same production environment (common + worker, the secret): it validates the same rules', () => {
    // the production checks (COOKIE_SECURE, SECRETS_KEY, https URLs) run in every process that loads the environment, so a
    // setting that only api.env carries crash-loops the worker (it happened on the first real host)
    const env = loadEnv({
      ...parseEnvFile(read('etc/oasis/secret-seed.env')),
      ...parseEnvFile(read('etc/oasis/common.env')),
      ...parseEnvFile(read('etc/oasis/worker.env')),
      NODE_ENV: 'production',
    })
    expect(env.COOKIE_SECURE).toBe(true)
    expect(env.JOBS_ENABLED).toBe(true)
  })

  it('the production environment (common + api, the secret from the seed) passes the app own validation, and is safe', () => {
    const merged = {
      ...parseEnvFile(read('etc/oasis/secret-seed.env')),
      ...parseEnvFile(read('etc/oasis/common.env')),
      ...parseEnvFile(read('etc/oasis/api.env')),
    }
    const env = loadEnv({ ...merged, NODE_ENV: 'production' })
    expect(env.NODE_ENV).toBe('production')
    expect(env.HOST).toBe('127.0.0.1')
    expect(env.TRUST_PROXY).toBe(1) // true parses to one trusted hop: nginx in front
    expect(env.COOKIE_SECURE).toBe(true)
    expect(env.HOOKS_HOST).toBe('127.0.0.1')
    expect(env.HOOKS_PORT).toBe(3002)
    expect(env.ALLOW_DEV_ENDPOINTS).toBe(false)
    expect(env.DEV_AUTH_BYPASS).toBe(false)
    expect(env.CLOCK_FREEZE_AT).toBeUndefined()
    expect(env.SMS_DISPATCH_MODE).toBe('jobs')
    expect(env.JOBS_ENABLED).toBe(true)
    expect(env.PORT).toBe(4000)
    // the worker has the same view of the shared settings
    const worker = loadEnv({
      ...merged,
      ...parseEnvFile(read('etc/oasis/worker.env')),
      NODE_ENV: 'production',
    })
    expect(worker.SECRETS_KEY).toBe(env.SECRETS_KEY)
    expect(worker.DB_POOL_MAX).toBe(6)
  })

  it('never turn on a development switch in the shipped files', () => {
    for (const t of templates) {
      const active = parseEnvFile(t.text)
      expect(active.DEV_AUTH_BYPASS).not.toBe('true')
      expect(active.ALLOW_DEV_ENDPOINTS ?? 'false').toBe('false')
      expect(active.CLOCK_FREEZE_AT).toBeUndefined()
    }
  })

  it('a re-run leaves existing files alone, and reports a variable a newer template added', async () => {
    const webEnv = path.join(stage.etc, 'web.env')
    const before = readFileSync(webEnv, 'utf8')
    writeFileSync(webEnv, before.replace(/^WEB_PORT=.*\n/m, ''))
    const r = await sh(
      path.join(DEPLOY, 'scripts/install.sh'),
      [
        '--domain',
        'oasis.example.com',
        '--tls',
        'files',
        '--tls-cert',
        stage.cert,
        '--tls-key',
        stage.key,
        '--no-system',
      ],
      stage.env,
    )
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/web\.env lacks variables that the current template has: WEB_PORT/)
    expect(readFileSync(webEnv, 'utf8')).not.toContain('WEB_PORT=') // not rewritten behind the operator's back
    writeFileSync(webEnv, before)
  })
})

describe('systemd units', () => {
  const units = readdirSync(path.join(DEPLOY, 'systemd'))
  const parse = (text: string): Record<string, Record<string, string[]>> => {
    const out: Record<string, Record<string, string[]>> = {}
    let section = ''
    for (const line of text.split('\n')) {
      const s = /^\[(\w+)\]$/.exec(line)
      if (s) section = s[1]!
      else if (section && /^[A-Za-z]+=/.test(line))
        ((out[section] ??= {})[line.slice(0, line.indexOf('='))] ??= []).push(
          line.slice(line.indexOf('=') + 1),
        )
    }
    return out
  }
  const unit = (name: string) => parse(read(`etc/systemd/system/${name}`))

  it('install.sh writes every unit', () => {
    expect(readdirSync(stage.systemd).sort()).toEqual([...units].sort())
  })

  it('run the three services as the oasis user with restart policy, after the network and a graceful stop', () => {
    for (const n of ['oasis-api', 'oasis-worker', 'oasis-web']) {
      const u = unit(`${n}.service`)
      expect(u.Service!.User, n).toEqual(['oasis'])
      expect(u.Service!.Restart, n).toEqual(['always'])
      expect(Number(u.Service!.RestartSec![0]), n).toBeGreaterThanOrEqual(1)
      expect(u.Service!.KillSignal, n).toEqual(['SIGTERM'])
      expect(Number(u.Service!.TimeoutStopSec![0]), n).toBeGreaterThanOrEqual(20)
      expect(u.Unit!.PartOf, n).toEqual(['oasis.target'])
      expect(u.Install!.WantedBy, n).toEqual(['multi-user.target'])
    }
    for (const n of ['oasis-api', 'oasis-worker']) {
      expect(unit(`${n}.service`).Unit!.After, n).toEqual(['network-online.target'])
      expect(unit(`${n}.service`).Unit!.Wants, n).toEqual(['network-online.target'])
    }
  })

  it('never pull in a local PostgreSQL (production uses Aurora); --local-db adds it as a drop-in, and a later run keeps it', async () => {
    for (const name of readdirSync(stage.systemd)) {
      if (!name.endsWith('.service')) continue
      const u = unit(name).Unit ?? {}
      for (const key of ['Wants', 'Requires', 'BindsTo', 'After'])
        expect((u[key] ?? []).join(' '), `${name} ${key}`).not.toContain('postgresql')
    }
    expect(readdirSync(stage.systemd).filter((n) => n.endsWith('.d'))).toEqual([])
    const t = tempDir('oasis-localdb-')
    try {
      const install = (extra: string[]) =>
        sh(
          path.join(DEPLOY, 'scripts/install.sh'),
          ['--domain', 'oasis.example.com', '--tls', 'files', '--tls-cert', stage.cert, '--tls-key', stage.key, '--no-system', ...extra],
          { OASIS_ROOT_PREFIX: t.dir },
        )
      const r = await install(['--local-db'])
      expect(r.code, r.out).toBe(0)
      const units = ['oasis-api', 'oasis-worker', 'oasis-backup', 'oasis-restore-drill']
      for (const n of units) {
        const dropin = path.join(t.dir, `etc/systemd/system/${n}.service.d/20-oasis-local-db.conf`)
        expect(parse(readFileSync(dropin, 'utf8')).Unit, n).toEqual({
          Wants: ['postgresql.service'],
          After: ['postgresql.service'],
        })
      }
      expect(existsSync(path.join(t.dir, 'etc/systemd/system/oasis-web.service.d'))).toBe(false)
      const again = await install([])
      expect(again.code, again.out).toBe(0)
      expect(again.out).toMatch(/20-oasis-local-db\.conf kept/)
      for (const n of units)
        expect(existsSync(path.join(t.dir, `etc/systemd/system/${n}.service.d/20-oasis-local-db.conf`)), n).toBe(true)
    } finally {
      t.cleanup()
    }
  })

  it('read /etc/oasis files in the right order (shared first, then the service own file) and use compiled output', () => {
    expect(unit('oasis-api.service').Service!.EnvironmentFile).toEqual([
      '/etc/oasis/common.env',
      '/etc/oasis/api.env',
    ])
    expect(unit('oasis-worker.service').Service!.EnvironmentFile).toEqual([
      '/etc/oasis/common.env',
      '/etc/oasis/worker.env',
    ])
    expect(unit('oasis-web.service').Service!.EnvironmentFile).toEqual(['/etc/oasis/web.env'])
    expect(unit('oasis-api.service').Service!.ExecStart![0]).toMatch(/node dist\/server\.js$/)
    expect(unit('oasis-worker.service').Service!.ExecStart![0]).toMatch(/node dist\/worker\.js$/)
    expect(unit('oasis-api.service').Service!.WorkingDirectory).toEqual(['/opt/oasis/current/backend'])
    expect(unit('oasis-web.service').Service!.WorkingDirectory).toEqual(['/opt/oasis/current/dashboard'])
    for (const n of ['common', 'api', 'worker', 'web'])
      expect(existsSync(path.join(stage.etc, `${n}.env`))).toBe(true)
  })

  it('start the dashboard the way its start:live script does (live variant, .next-live, loopback)', () => {
    const u = unit('oasis-web.service').Service!
    expect(u.Environment).toEqual(
      expect.arrayContaining(['NEXT_PUBLIC_VARIANT=live', 'DIST_DIR=.next-live', 'WEB_HOST=127.0.0.1']),
    )
    expect(u.ExecStart![0]).toBe(
      '/usr/bin/node node_modules/next/dist/bin/next start -p ${WEB_PORT} -H ${WEB_HOST}',
    )
    const dashboardPkg = path.join(REPO, '..', '..', 'dashboard', 'package.json')
    if (existsSync(dashboardPkg)) {
      const start = (JSON.parse(readFileSync(dashboardPkg, 'utf8')) as { scripts: Record<string, string> })
        .scripts['start:live']!
      // the dashboard may let LIVE_DIST_DIR override the directory; its default must be the one the unit uses
      expect(start).toMatch(
        /NEXT_PUBLIC_VARIANT=live DIST_DIR=(?:\.next-live|\$\{LIVE_DIST_DIR:-\.next-live\}) next start/,
      )
      expect(start).toContain('-H ${WEB_HOST:-127.0.0.1}')
    }
  })

  it('carry the sandboxing options, and do not break the Node JIT', () => {
    for (const n of ['oasis-api', 'oasis-worker', 'oasis-web']) {
      const s = unit(`${n}.service`).Service!
      for (const key of [
        'NoNewPrivileges',
        'PrivateTmp',
        'PrivateDevices',
        'ProtectKernelTunables',
        'ProtectKernelModules',
        'ProtectControlGroups',
        'RestrictSUIDSGID',
        'LockPersonality',
      ])
        expect(s[key], `${n} ${key}`).toEqual(['yes'])
      expect(s.ProtectSystem, n).toEqual(['strict'])
      expect(s.ProtectHome, n).toEqual(['yes'])
      expect(s.CapabilityBoundingSet, n).toEqual([''])
      expect(s.RestrictAddressFamilies, n).toEqual(['AF_INET AF_INET6 AF_UNIX'])
      expect(s.UMask, n).toEqual(['0077'])
      expect(s.MemoryMax, n).toBeDefined()
      expect(s.MemoryDenyWriteExecute, n).toBeUndefined() // V8 needs writable+executable memory
    }
    // only the state directory is writable for the API and the worker
    expect(unit('oasis-api.service').Service!.ReadWritePaths).toEqual(['/var/lib/oasis'])
    expect(unit('oasis-worker.service').Service!.ReadWritePaths).toEqual(['/var/lib/oasis'])
  })

  it('the metadata guard runs before the network and the services, and the web server cannot reach the metadata service', () => {
    const g = unit('oasis-imds-guard.service')
    expect(g.Unit!.DefaultDependencies).toEqual(['no'])
    for (const before of ['network-pre.target', 'oasis-api.service', 'oasis-worker.service', 'oasis-web.service', 'oasis-backup.service'])
      expect(g.Unit!.Before![0]!.split(' '), before).toContain(before)
    expect(g.Unit!.Wants).toEqual(['network-pre.target'])
    expect(g.Service!.Type).toEqual(['oneshot'])
    expect(g.Service!.RemainAfterExit).toEqual(['yes'])
    expect(g.Install!.WantedBy).toEqual(['multi-user.target'])
    expect(unit('oasis-web.service').Service!.IPAddressDeny).toEqual(['169.254.169.254/32'])
    // the API, the worker and the backup use the instance role: no deny for them
    for (const n of ['oasis-api', 'oasis-worker', 'oasis-backup'])
      expect(unit(`${n}.service`).Service!.IPAddressDeny, n).toBeUndefined()
  })

  it('the metadata guard lets exactly root, oasis and ec2-instance-connect through, starts idempotently and stops cleanly', async () => {
    const t = tempDir('oasis-imds-')
    try {
      // a model of iptables: one file per chain, one rule per line; -C/-D/-X fail the way iptables does
      const bin = path.join(t.dir, 'bin')
      mkdirSync(bin)
      writeFileSync(
        path.join(bin, 'iptables'),
        `#!/usr/bin/env bash
S="$IPT_STATE"; [ "$1" = -w ] && shift
op=$1 chain=$2; shift 2
f="$S/$chain"; [ "$chain" = OUTPUT ] && touch "$f"
case "$op" in
  -N) [ -e "$f" ] && { echo "Chain already exists" >&2; exit 1; }; : > "$f" ;;
  -F) [ -e "$f" ] || exit 1; : > "$f" ;;
  -X) [ -e "$f" ] || exit 1; [ -s "$f" ] && exit 1; grep -qx -- "-j $chain" "$S"/* 2>/dev/null && exit 1; grep -q -- "-j $chain\\$" "$S"/* 2>/dev/null && exit 1; rm "$f" ;;
  -A) [ -e "$f" ] || exit 1; echo "$*" >> "$f" ;;
  -I) [ -e "$f" ] || exit 1; [ "$1" = 1 ] && shift; { echo "$*"; cat "$f"; } > "$f.new"; mv "$f.new" "$f" ;;
  -C) [ -e "$f" ] && grep -qxF -- "$*" "$f" ;;
  -D) [ -e "$f" ] && grep -qxF -- "$*" "$f" || exit 1; awk -v r="$*" 'BEGIN{d=0} $0==r && !d {d=1; next} {print}' "$f" > "$f.new"; mv "$f.new" "$f" ;;
  *) echo "unexpected iptables $op" >&2; exit 2 ;;
esac
`,
      )
      writeFileSync(
        path.join(bin, 'id'),
        `#!/usr/bin/env bash\n[ "$1" = -u ] && [ "$2" = ec2-instance-connect ] && [ -n "$HAS_EIC" ] && { echo 994; exit 0; }\nexit 1\n`,
      )
      chmodSync(path.join(bin, 'iptables'), 0o755)
      chmodSync(path.join(bin, 'id'), 0o755)
      const g = unit('oasis-imds-guard.service').Service!
      const script = (line: string): { flags: string; body: string } => {
        const m = /^\/bin\/sh (-e?c) '(.*)'$/.exec(line)
        expect(m, line).not.toBeNull()
        return { flags: m![1]!, body: m![2]! }
      }
      const start = script(g.ExecStart![0]!)
      const stop = script(g.ExecStop![0]!)
      expect(start.flags).toBe('-ec') // a failing step fails the unit (the guard is not silently absent)
      const state = path.join(t.dir, 'state')
      const run = (s: { flags: string; body: string }, extra: Record<string, string> = {}) =>
        sh('/bin/sh', [s.flags, s.body], { PATH: `${bin}:/usr/bin:/bin`, IPT_STATE: state, ...extra })
      const chain = () => readFileSync(path.join(state, 'OASIS-IMDS'), 'utf8').trim().split('\n')
      const output = () => readFileSync(path.join(state, 'OUTPUT'), 'utf8').trim().split('\n').filter(Boolean)
      const allowed = () =>
        chain()
          .filter((r) => r.endsWith('-j RETURN'))
          .map((r) => /--uid-owner (\S+) -j RETURN$/.exec(r)![1])

      mkdirSync(state)
      writeFileSync(path.join(state, 'OUTPUT'), '-d 10.0.0.0/8 -j ACCEPT\n') // someone else's rule stays where it is
      for (let i = 0; i < 2; i++) {
        const r = await run(start, { HAS_EIC: '1' })
        expect(r.code, r.out).toBe(0)
        expect(allowed()).toEqual(['0', 'oasis', 'ec2-instance-connect'])
        expect(chain().at(-1)).toBe('-j REJECT') // everyone else: rejected
        expect(chain()).toHaveLength(4)
        expect(output()).toEqual(['-d 169.254.169.254/32 -j OASIS-IMDS', '-d 10.0.0.0/8 -j ACCEPT']) // one jump, first
      }
      // a host without EC2 Instance Connect: the same, without that user
      expect((await run(start)).code).toBe(0)
      expect(allowed()).toEqual(['0', 'oasis'])
      for (let i = 0; i < 2; i++) {
        const r = await run(stop)
        expect(r.code, r.out).toBe(0)
        expect(existsSync(path.join(state, 'OASIS-IMDS'))).toBe(false)
        expect(output()).toEqual(['-d 10.0.0.0/8 -j ACCEPT'])
      }
    } finally {
      t.cleanup()
    }
  })

  it('back up nightly in shop time and drill monthly, both with persistent timers', () => {
    expect(unit('oasis-backup.timer').Timer!.OnCalendar![0]).toMatch(/^\*-\*-\* 03:15:00 America\/New_York$/)
    expect(unit('oasis-backup.timer').Timer!.Persistent).toEqual(['true'])
    expect(unit('oasis-restore-drill.timer').Timer!.OnCalendar![0]).toMatch(/^\*-\*-02 /)
    // root's units run the root-owned kit, never a script in a release or clone (ADR 0140)
    expect(unit('oasis-backup.service').Service!.ExecStart![0]).toBe(
      '/usr/local/lib/oasis/deploy/scripts/backup.sh --label nightly',
    )
    expect(unit('oasis-restore-drill.service').Service!.ExecStart![0]).toBe(
      '/usr/local/lib/oasis/deploy/scripts/restore-drill.sh --latest',
    )
    expect(unit('oasis-healthcheck.service').Service!.ExecStart![0]).toBe(
      '/usr/local/lib/oasis/deploy/scripts/healthcheck.sh --quiet',
    )
    for (const name of readdirSync(stage.systemd).filter((n) => !n.endsWith('.d')))
      for (const exec of [...(unit(name).Service?.ExecStart ?? []), ...(unit(name).Service?.ExecStartPre ?? [])])
        expect(exec, name).not.toMatch(/\/opt\/oasis\/(current|releases|src)\/[^ ]*\.sh/)
  })

  it('the health check loads the website settings when there are any, and a failure is recorded like the other timers', () => {
    const u = unit('oasis-healthcheck.service')
    expect(u.Service!.EnvironmentFile).toEqual(['-/etc/oasis/web.env', '-/etc/oasis/api.env', '-/etc/oasis/site.env'])
    expect(u.Unit!.OnFailure).toEqual(['oasis-notify-failure@%n.service'])
    for (const n of ['oasis-backup', 'oasis-restore-drill'])
      expect(unit(`${n}.service`).Unit!.OnFailure, n).toEqual(['oasis-notify-failure@%n.service'])
  })

  it.skipIf(!existsSync('/usr/bin/systemd-analyze'))(
    'pass systemd-analyze verify and stay below an exposure of 3.0 in systemd-analyze security',
    async () => {
      const t = tempDir('oasis-units-')
      try {
        // the units point at /opt/oasis/current/backend; make that path real so the script checks have something to find
        const dir = path.join(t.dir, 'units')
        mkdirSync(dir)
        for (const name of readdirSync(stage.systemd)) {
          if (name.includes('@')) continue
          writeFileSync(
            path.join(dir, name),
            read(`etc/systemd/system/${name}`)
              .replaceAll('/opt/oasis/current/backend', REPO)
              .replaceAll('/usr/local/lib/oasis/deploy', DEPLOY),
          )
        }
        for (const s of readdirSync(path.join(DEPLOY, 'scripts')))
          chmodSync(path.join(DEPLOY, 'scripts', s), 0o755)
        const files = readdirSync(dir).map((f) => path.join(dir, f))
        const verify = await sh('systemd-analyze', ['verify', ...files])
        const mine = verify.out.split('\n').filter((l) => /oasis/.test(l))
        expect(mine).toEqual([])
        for (const n of ['oasis-api', 'oasis-worker', 'oasis-web']) {
          const sec = await sh('systemd-analyze', [
            'security',
            '--offline=true',
            '--no-pager',
            path.join(dir, `${n}.service`),
          ])
          const m = /Overall exposure level for [^:]+: ([0-9.]+)/.exec(sec.out)
          expect(m, `${n}: ${sec.out.slice(-200)}`).not.toBeNull()
          expect(Number(m![1]), n).toBeLessThan(3)
        }
      } finally {
        t.cleanup()
      }
    },
  )
})

// The nginx package rotates /var/log/nginx/*.log itself (/etc/logrotate.d/nginx). A second stanza naming any of those files makes
// every logrotate run report "duplicate log entry ... found error in file oasis, skipping" and exit 1 (the logrotate service fails).
const LOGROTATE = ['/usr/sbin/logrotate', '/usr/bin/logrotate'].find((p) => existsSync(p))
describe.skipIf(!LOGROTATE)('logrotate', () => {
  const STOCK_NGINX = `/var/log/nginx/*.log {
    create 0640 nginx root
    daily
    rotate 10
    missingok
    notifempty
    compress
    delaycompress
    sharedscripts
    postrotate
        /bin/kill -USR1 \`cat /run/nginx.pid 2>/dev/null\` 2>/dev/null || true
    endscript
}
`
  // Both stanzas moved onto a temporary log tree that holds real files: logrotate only notices a duplicate when the glob matches
  // something (as an unprivileged user /var/log/nginx is not readable, so the real paths would prove nothing).
  const dry = async (oasisStanza: string) => {
    const t = tempDir('oasis-logrotate-')
    try {
      const logs = path.join(t.dir, 'logs')
      for (const f of ['nginx/access.log', 'nginx/oasis.access.log', 'nginx/oasis.error.log', 'nginx/oasis-site.access.log', 'oasis/deploy.log']) {
        mkdirSync(path.dirname(path.join(logs, f)), { recursive: true })
        writeFileSync(path.join(logs, f), 'line\n')
      }
      const move = (text: string) => text.replaceAll('/var/log/nginx', `${logs}/nginx`).replaceAll('/var/log/oasis', `${logs}/oasis`)
      const d = path.join(t.dir, 'logrotate.d')
      mkdirSync(d)
      writeFileSync(path.join(d, 'nginx'), move(STOCK_NGINX))
      writeFileSync(path.join(d, 'oasis'), move(oasisStanza))
      writeFileSync(path.join(t.dir, 'logrotate.conf'), `include ${d}\n`)
      const r = await sh(LOGROTATE!, ['-d', '-s', path.join(t.dir, 'state'), path.join(t.dir, 'logrotate.conf')])
      return { ...r, out: r.out.replaceAll(logs, '/var/log') }
    } finally {
      t.cleanup()
    }
  }

  it('the kit file names only /var/log/oasis/*.log, and logrotate -d accepts it next to the stock nginx stanza', async () => {
    const ours = readText(path.join(DEPLOY, 'logrotate/oasis'))
    const stanzas = [...ours.matchAll(/^([^#\n][^{]*)\{/gm)].map((m) => m[1]!.trim())
    expect(stanzas).toEqual(['/var/log/oasis/*.log'])
    expect(ours).not.toMatch(/^\s*\/var\/log\/nginx/m)
    const r = await dry(ours)
    expect(r.code, r.out).toBe(0)
    expect(r.out).not.toMatch(/duplicate log entry|found error in file/)
    expect(r.out).toMatch(/Handling 2 logs/)
    expect(r.out).toMatch(/rotating pattern: \/var\/log\/oasis\/\*\.log/)
    expect(r.out).toMatch(/considering log \/var\/log\/oasis\/deploy\.log/)
    expect(r.out).toMatch(/considering log \/var\/log\/nginx\/oasis-site\.access\.log/) // the package's stanza covers the site's logs
  })

  it('(control) the old file with its own nginx stanza is what logrotate refused, /var/log/oasis included', async () => {
    const old = `/var/log/nginx/oasis.access.log /var/log/nginx/oasis.error.log {\n    daily\n    missingok\n}\n\n/var/log/oasis/*.log {\n    weekly\n    missingok\n}\n`
    const r = await dry(old)
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/duplicate log entry for \/var\/log\/nginx\/oasis\.access\.log/)
    expect(r.out).toMatch(/found error in file oasis, skipping/)
  })
})

describe('nginx site', () => {
  const conf = (rel: string): Directive[] => parseNginx(read(`etc/nginx/${rel}`))
  const reader = (p: string): string => readText(path.join(stage.root, p))
  const servers = (): Directive[] => find(find(conf('conf.d/oasis.conf'), 'server'), 'server')
  const named = (): Directive[] => servers().filter((s) => find(s.block!, 'server_name').length)
  const https = (): Directive =>
    named().find((s) => find(s.block!, 'listen').some((l) => l.args[0] === '443'))!
  const httpsLocs = () => locationsOf({ ...https(), block: expandIncludes(https().block!, reader) })
  const text = (): string =>
    ['conf.d/oasis.conf', 'conf.d/00-oasis-zones.conf', 'oasis/proxy.conf', 'oasis/security-headers.conf', 'oasis/tls.conf']
      .map((f) => read(`etc/nginx/${f}`))
      .join('\n')

  it('renders with no placeholder left and balanced braces', () => {
    expect(text()).not.toMatch(/@[A-Z][A-Z0-9_]*@/)
    expect(() =>
      [
        'conf.d/oasis.conf',
        'conf.d/00-oasis-zones.conf',
        'oasis/proxy.conf',
        'oasis/security-headers.conf',
        'oasis/tls.conf',
      ].forEach(conf),
    ).not.toThrow()
  })

  it('writes the zones file so that nginx reads it first (oasis.conf uses the log format and zones defined there)', () => {
    expect(readdirSync(path.join(stage.nginx, 'conf.d')).sort()).toEqual([
      '00-oasis-zones.conf',
      'oasis.conf',
    ])
  })

  it('redirects port 80 to HTTPS except the ACME challenge, and serves TLS 1.2+ with the configured certificate', () => {
    const [plain] = named()
    expect(find(plain!.block!, 'listen')[0]!.args).toEqual(['80'])
    const locs = locationsOf(plain!)
    expect(find(plain!.block!, 'server_name')[0]!.args).toEqual(['oasis.example.com'])
    expect(locs.find((l) => l.pattern === '/.well-known/acme-challenge/')).toBeDefined()
    expect(find(locs.find((l) => l.pattern === '/')!.body, 'return')[0]!.args).toEqual([
      '301',
      'https://oasis.example.com$request_uri',
    ])
    const s = expandIncludes(https().block!, reader)
    expect(find(s, 'ssl_certificate')[0]!.args[0]).toBe(stage.cert)
    expect(find(s, 'ssl_certificate_key')[0]!.args[0]).toBe(stage.key)
    expect(find(s, 'ssl_protocols')[0]!.args).toEqual(['TLSv1.2', 'TLSv1.3'])
    expect(find(s, 'ssl_session_tickets')[0]!.args).toEqual(['off'])
    expect(find(s, 'ssl_session_cache')[0]!.args).toEqual(['shared:oasis_ssl:10m'])
    expect(find(s, 'http2')[0]!.args).toEqual(['on'])
    // the TLS settings are one shared file (the website's servers include the same one), not copies
    expect(find(https().block!, 'ssl_protocols')).toEqual([])
    expect(find(https().block!, 'include').map((i) => i.args[0])).toContain('/etc/nginx/oasis/tls.conf')
    expect(find(conf('oasis/tls.conf'), 'ssl_session_cache')).toHaveLength(1)
    expect(find(find(conf('conf.d/00-oasis-zones.conf'), 'server_tokens'), 'server_tokens')[0]!.args).toEqual(
      ['off'],
    )
  })

  it('routes the public URLs the way the design says (nginx location rules applied to real paths)', () => {
    const locs = httpsLocs()
    const where = (uri: string): string => {
      const l = matchLocation(locs, uri)
      return l ? `${l.modifier} ${l.pattern}`.trim() : 'none'
    }
    const proxied = (uri: string): string | undefined =>
      find(matchLocation(locs, uri)!.body, 'proxy_pass')[0]?.args[0]
    expect(where('/')).toBe('/')
    expect(proxied('/')).toBe('http://oasis_web')
    expect(proxied('/appointments')).toBe('http://oasis_web')
    expect(proxied('/_next/static/chunks/main.js')).toBe('http://oasis_web')
    expect(proxied('/api/v1/customers')).toBe('http://oasis_api')
    expect(where('/api/v1/events')).toBe('= /api/v1/events')
    expect(where('/api/v1/auth/login')).toMatch(/^~ \^\/api\/v1\/auth\//)
    expect(where('/api/v1/auth/password/forgot')).toMatch(/^~ /)
    expect(where('/api/v1/auth/logout')).toBe('^~ /api/')
    expect(where('/hooks/squarespace')).toBe('= /hooks/squarespace')
    expect(proxied('/hooks/squarespace')).toBe('http://oasis_api')
    expect(where('/hooks/ses')).toBe('= /hooks/ses')
    expect(where('/healthz')).toBe('= /healthz')
    expect(where('/readyz')).toBe('= /readyz')
  })

  it('gives the website’s public API on this host the website host’s rules: cached reads with a fixed key, the write zone, 16k bodies, no cookies (review 2026-10-10)', () => {
    const locs = httpsLocs()
    const at = (uri: string) => matchLocation(locs, uri)!
    const args = (uri: string, name: string): string[][] => find(at(uri).body, name).map((d) => d.args)
    for (const [name, key] of [
      ['hours', '$scheme$host$uri'],
      ['availability', '$scheme$host$uri?days=$arg_days&service=$arg_service'],
      ['catalog', '$scheme$host$uri'],
    ] as const) {
      const uri = `/api/v1/public/${name}`
      expect(`${at(uri).modifier} ${at(uri).pattern}`, uri).toBe(`= ${uri}`)
      expect(args(uri, 'proxy_pass'), uri).toEqual([['http://oasis_api']])
      expect(args(uri, 'limit_req'), uri).toEqual([['zone=oasis_api', 'burst=20', 'nodelay']])
      expect(args(uri, 'proxy_cache'), uri).toEqual([['oasis_public']])
      expect(args(uri, 'proxy_cache_key'), uri).toEqual([[key]])
      expect(args(uri, 'proxy_cache_valid'), uri).toEqual([['200', '60s']])
      expect(find(find(at(uri).body, 'limit_except')[0]!.block!, 'deny')[0]!.args, uri).toEqual(['all'])
      expect(args(uri, 'proxy_set_header').map((a) => a.join(' ')), uri).toContain('Cookie ')
      expect(args(uri, 'proxy_ignore_headers'), uri).toEqual([['Set-Cookie']])
    }
    for (const uri of ['/api/v1/public/otp', '/api/v1/public/otp/verify', '/api/v1/public/bookings', '/api/v1/public/memberships', '/api/v1/public/hours/']) {
      expect(`${at(uri).modifier} ${at(uri).pattern}`, uri).toBe('^~ /api/v1/public/')
      expect(args(uri, 'limit_req'), uri).toEqual([['zone=oasis_public_post', 'burst=10', 'nodelay']])
      expect(args(uri, 'client_max_body_size'), uri).toEqual([['16k']])
      expect(args(uri, 'proxy_cache'), uri).toEqual([])
      expect(args(uri, 'proxy_pass'), uri).toEqual([['http://oasis_api']])
      expect(args(uri, 'proxy_set_header').map((a) => a.join(' ')), uri).toContain('Cookie ')
      expect(args(uri, 'proxy_hide_header').map((a) => a[0]), uri).toContain('Set-Cookie')
    }
    // the dashboard's own API is untouched
    expect(`${at('/api/v1/customers').modifier} ${at('/api/v1/customers').pattern}`).toBe('^~ /api/')
    expect(`${at('/api/v1/publicity').modifier} ${at('/api/v1/publicity').pattern}`).toBe('^~ /api/')
  })

  it('answers 404 for /hooks/smsgate and everything else under /hooks, and never proxies it', () => {
    const locs = httpsLocs()
    for (const uri of [
      '/hooks/smsgate',
      '/hooks/smsgate/abcdefgh',
      '/hooks/smsgate/',
      '/hooks/unknown',
      '/hooks/squarespace/extra',
      '/dev-storage/files/x',
    ]) {
      const l = matchLocation(locs, uri)!
      expect(find(l.body, 'proxy_pass'), uri).toEqual([])
      expect(find(l.body, 'return')[0]!.args[0], uri).toBe('404')
    }
    expect(text()).not.toMatch(/proxy_pass[^;]*smsgate/)
    expect(text()).not.toMatch(/:3002/) // the hooks listener is reached only through tailscale serve
  })

  it('serves only its own name: other names and bare addresses get no answer on 80 and no TLS handshake on 443', () => {
    const defaults = servers().filter((s) => find(s.block!, 'listen').some((l) => l.args.includes('default_server')))
    expect(defaults).toHaveLength(2)
    const [d80, d443] = defaults
    expect(find(d80!.block!, 'listen').map((l) => l.args)).toEqual([
      ['80', 'default_server'],
      ['[::]:80', 'default_server'],
    ])
    expect(find(d80!.block!, 'return')[0]!.args).toEqual(['444'])
    expect(find(d443!.block!, 'listen').map((l) => l.args)).toEqual([
      ['443', 'ssl', 'default_server'],
      ['[::]:443', 'ssl', 'default_server'],
    ])
    expect(find(d443!.block!, 'ssl_reject_handshake')[0]!.args).toEqual(['on'])
    expect(find(d443!.block!, 'ssl_certificate')).toEqual([]) // nothing to show to a stranger
    for (const s of defaults) expect(find(s.block!, 'server_name'), 'a default server matches no name').toEqual([])
    // the site itself is not a default server, and every named server is the domain
    for (const s of named()) {
      expect(find(s.block!, 'server_name')[0]!.args).toEqual(['oasis.example.com'])
      expect(find(s.block!, 'listen').some((l) => l.args.includes('default_server'))).toBe(false)
    }
  })

  it('no other letter case of /api, /dev-storage or /hooks reaches Next.js (its rewrites would pass it to the API)', () => {
    const locs = httpsLocs()
    // (lower-case /api itself is answered by nginx with a 301 to /api/, its rule for a proxied prefix that ends in a slash)
    for (const uri of ['/API/v1/openapi.json', '/Api/v1/meta/now', '/aPi/v1/auth/login', '/API/', '/API', '/Dev-Storage/files/x', '/DEV-STORAGE', '/dev-storage', '/HOOKS/smsgate/x', '/Hooks/squarespace']) {
      const l = matchLocation(locs, uri)!
      expect(find(l.body, 'proxy_pass'), uri).toEqual([])
      expect(find(l.body, 'return')[0]!.args[0], uri).toBe('404')
    }
    // the lower-case paths still go where they did, and the dashboard keeps everything else
    expect(find(matchLocation(locs, '/api/v1/customers')!.body, 'proxy_pass')[0]!.args[0]).toBe('http://oasis_api')
    expect(find(matchLocation(locs, '/apiary')!.body, 'proxy_pass')[0]!.args[0]).toBe('http://oasis_web')
    expect(find(matchLocation(locs, '/settings/api-keys')!.body, 'proxy_pass')[0]!.args[0]).toBe('http://oasis_web')
    expect(find(matchLocation(locs, '/hooks/squarespace')!.body, 'proxy_pass')[0]!.args[0]).toBe('http://oasis_api')
  })

  it('does not buffer or compress the event stream, and allows long reads', () => {
    const l = httpsLocs().find((x) => x.pattern === '/api/v1/events')!
    const d = (n: string): string[] => find(l.body, n)[0]?.args ?? []
    expect(d('proxy_buffering')).toEqual(['off'])
    expect(d('proxy_cache')).toEqual(['off'])
    expect(d('gzip')).toEqual(['off'])
    expect(d('proxy_read_timeout')).toEqual(['3600s'])
    expect(find(expandIncludes(l.body, reader), 'proxy_http_version')[0]!.args).toEqual(['1.1'])
  })

  it('takes Squarespace webhooks by POST only with a 1 MB body limit', () => {
    const l = httpsLocs().find((x) => x.pattern === '/hooks/squarespace')!
    expect(find(l.body, 'client_max_body_size')[0]!.args).toEqual(['1m'])
    const except = find(l.body, 'limit_except')[0]!
    expect(except.args).toEqual(['POST'])
    expect(find(except.block!, 'deny')[0]!.args).toEqual(['all'])
    expect(find(l.body, 'limit_req')[0]!.args[0]).toBe('zone=oasis_hooks')
  })

  it('limits sign-in attempts, keeps readiness and the OpenAPI document to this host, and defines every zone it uses', () => {
    const locs = httpsLocs()
    const login = matchLocation(locs, '/api/v1/auth/login')!
    expect(find(login.body, 'limit_req')[0]!.args[0]).toBe('zone=oasis_login')
    for (const uri of ['/readyz', '/api/v1/openapi.json']) {
      const body = matchLocation(locs, uri)!.body
      expect(find(body, 'allow').map((a) => a.args[0])).toEqual(['127.0.0.1', '::1'])
      expect(find(body, 'deny')[0]!.args).toEqual(['all'])
    }
    const zones = find(conf('conf.d/00-oasis-zones.conf'), 'limit_req_zone').map(
      (z) => /zone=(\w+):/.exec(z.args[1]!)![1],
    )
    const used = [...text().matchAll(/limit_req zone=(\w+)/g)].map((m) => m[1])
    expect(used.length).toBeGreaterThan(3)
    for (const z of used) expect(zones).toContain(z)
    expect(find(conf('conf.d/00-oasis-zones.conf'), 'limit_req_status')[0]!.args).toEqual(['429'])
  })

  it('forwards the real client address by overwriting X-Forwarded-For, which is what TRUST_PROXY=true in api.env relies on', () => {
    const proxy = conf('oasis/proxy.conf')
    const headers = find(proxy, 'proxy_set_header').map((h) => h.args.join(' '))
    expect(headers).toContain('X-Forwarded-For $remote_addr')
    expect(headers).toContain('X-Forwarded-Proto $scheme')
    expect(headers).toContain('X-Request-Id $request_id')
    expect(headers).toContain('Host $host')
    expect(text()).not.toContain('$proxy_add_x_forwarded_for')
    expect(parseEnvFile(read('etc/oasis/api.env')).TRUST_PROXY).toBe('true')
    expect(parseEnvFile(read('etc/oasis/api.env')).HOST).toBe('127.0.0.1')
    // every proxied location includes the shared proxy settings (nested ones too)
    const all = (locs: ReturnType<typeof locationsOf>): ReturnType<typeof locationsOf> =>
      locs.flatMap((l) => [l, ...all(locationsOf({ name: 'location', args: [], block: l.body }))])
    for (const l of all(locationsOf(https()))) {
      if (find(l.body, 'proxy_pass').length)
        expect(
          find(l.body, 'include').map((i) => i.args[0]),
          l.pattern,
        ).toContain('/etc/nginx/oasis/proxy.conf')
    }
  })

  it('has no directive twice in one block once the includes are expanded (nginx -t refuses that)', () => {
    const repeatable = new Set([
      'add_header',
      'proxy_set_header',
      'allow',
      'deny',
      'listen',
      'location',
      'include',
      'limit_req',
      'server',
      'upstream',
      'limit_req_zone',
      'limit_conn_zone',
      'log_format',
      'proxy_hide_header',
    ])
    const check = (block: Directive[], where: string): void => {
      const seen = new Set<string>()
      for (const d of block) {
        if (!repeatable.has(d.name)) {
          expect(seen.has(d.name), `${where}: ${d.name} appears twice`).toBe(false)
          seen.add(d.name)
        }
        if (d.block) check(d.block, `${where} > ${d.name} ${d.args.join(' ')}`)
      }
    }
    check(expandIncludes(conf('conf.d/oasis.conf'), reader), 'oasis.conf')
    check(conf('conf.d/00-oasis-zones.conf'), 'oasis-zones.conf')
  })

  it('sends security headers on the dashboard that match the ones the API sends', () => {
    const headers = Object.fromEntries(
      find(conf('oasis/security-headers.conf'), 'add_header').map((h) => [h.args[0], h.args[1]]),
    )
    expect(headers['Strict-Transport-Security']).toBe('max-age=15552000; includeSubDomains')
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['Referrer-Policy']).toBe('no-referrer')
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin')
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin')
    expect(headers['X-Frame-Options']).toBe('DENY')
    expect(headers['Permissions-Policy']).toBe(
      'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
    )
    // by default the CSP is the dashboard's own (hash-pinned scripts); nginx adds none
    expect(Object.keys(headers).filter((h) => /content-security-policy/i.test(h))).toEqual([])
    // every header nginx sets that the dashboard also sends is hidden from upstream, so each arrives once (HSTS and nosniff by
    // proxy.conf, which the dashboard location includes as well)
    const hidden = [...find(conf('oasis/security-headers.conf'), 'proxy_hide_header'), ...find(conf('oasis/proxy.conf'), 'proxy_hide_header')].map(
      (h) => h.args[0],
    )
    expect(new Set(hidden).size, 'no header hidden twice in one location').toBe(hidden.length)
    for (const h of [
      'Strict-Transport-Security',
      'X-Content-Type-Options',
      'Referrer-Policy',
      'X-Frame-Options',
      'Cross-Origin-Opener-Policy',
      'Permissions-Policy',
    ])
      expect(hidden, h).toContain(h)
    expect(hidden).not.toContain('Content-Security-Policy')
    // the dashboard location includes them; the API locations add none of their own (helmet sets the rest)
    const locs = httpsLocs()
    expect(find(matchLocation(locationsOf(https()), '/')!.body, 'include').map((i) => i.args[0])).toContain(
      '/etc/nginx/oasis/security-headers.conf',
    )
    expect(find(matchLocation(locs, '/api/v1/customers')!.body, 'add_header')).toEqual([])
  })

  it('HSTS and nosniff are on every answer of the site, nginx errors and denials included, exactly once', () => {
    const server = expandIncludes(https().block!, reader)
    const serverLevel = find(server, 'add_header').map((h) => `${h.args.join(' ')}`)
    expect(serverLevel).toEqual([
      'Strict-Transport-Security max-age=15552000; includeSubDomains always',
      'X-Content-Type-Options nosniff always',
    ])
    // add_header in a location replaces the inherited ones: what a location really sends
    const effective = (l: { body: Directive[] }): string[] => {
      const own = find(l.body, 'add_header')
      return (own.length ? own : find(server, 'add_header')).map((h) => h.args[0]!)
    }
    const all = (locs: ReturnType<typeof locationsOf>): ReturnType<typeof locationsOf> =>
      locs.flatMap((l) => [l, ...all(locationsOf({ name: 'location', args: [], block: l.body }))])
    const every = all(locationsOf({ ...https(), block: server }))
    expect(every.length).toBeGreaterThan(10)
    for (const l of every) {
      const sent = effective(l)
      for (const h of ['Strict-Transport-Security', 'X-Content-Type-Options']) {
        expect(sent.filter((x) => x === h), `${l.modifier} ${l.pattern} ${h}`).toHaveLength(1)
        // a proxied location drops the upstream's copy, so the visitor sees one
        if (find(l.body, 'proxy_pass').length)
          expect(find(l.body, 'proxy_hide_header').map((x) => x.args[0]), `${l.pattern} hides ${h}`).toContain(h)
      }
      expect(find(l.body, 'add_header').every((h) => h.args.at(-1) === 'always'), l.pattern).toBe(true)
    }
    // the app says the same thing about HSTS
    expect(readText(path.join(REPO, 'src/app.ts'))).toContain('maxAge: 15_552_000')
  })

  it('points the upstreams at the ports the services listen on', () => {
    const ups = Object.fromEntries(
      find(conf('conf.d/00-oasis-zones.conf'), 'upstream').map((u) => [
        u.args[0],
        find(u.block!, 'server')[0]!.args[0],
      ]),
    )
    expect(ups.oasis_api).toBe(`127.0.0.1:${parseEnvFile(read('etc/oasis/api.env')).PORT}`)
    expect(ups.oasis_web).toBe(`127.0.0.1:${parseEnvFile(read('etc/oasis/web.env')).WEB_PORT}`)
  })

  it('the include files it references exist, and --csp decides whether nginx adds a policy and which header carries it', async () => {
    for (const inc of text().matchAll(/include ([^;]+);/g))
      expect(existsSync(path.join(stage.root, inc[1]!)), inc[1]).toBe(true)
    const t = tempDir('oasis-csp-')
    try {
      for (const [mode, header] of [
        ['enforce', 'Content-Security-Policy'],
        ['report-only', 'Content-Security-Policy-Report-Only'],
        ['app', null],
        ['off', null],
      ] as const) {
        const r = await sh(
          path.join(DEPLOY, 'scripts/install.sh'),
          [
            '--domain',
            'oasis.example.com',
            '--tls',
            'files',
            '--tls-cert',
            stage.cert,
            '--tls-key',
            stage.key,
            '--csp',
            mode,
            '--no-system',
          ],
          { OASIS_ROOT_PREFIX: path.join(t.dir, mode) },
        )
        expect(r.code).toBe(0)
        const h = parseNginx(
          readText(path.join(t.dir, mode, 'etc/nginx/oasis/security-headers.conf')),
        ).filter((d) => d.name === 'add_header')
        const csp = h.map((d) => d.args[0] ?? '').filter((n) => /content-security-policy|csp/i.test(n))
        expect(csp, mode).toEqual(header ? [header] : [])
      }
    } finally {
      t.cleanup()
    }
  })
})

// The rendered site in a real nginx (when the binary is installed): nginx -t, then real requests on loopback ports against stub
// upstreams, as an unprivileged user with every path moved into a temporary prefix.
const NGINX = ['/usr/sbin/nginx', '/usr/bin/nginx'].find((p) => existsSync(p))
describe.skipIf(!NGINX)('nginx site in a real nginx', () => {
  const P80 = 4685
  const P443 = 4686
  const API = 4687
  const WEB = 4688
  let dir = ''
  let nginx: ChildProcess | undefined
  const upstreams: Server[] = []
  const hits: string[] = []
  const t = tempDir('oasis-nginx-')

  beforeAll(async () => {
    dir = t.dir
    for (const d of ['conf.d', 'oasis', 'log', 'tmp', 'cache']) mkdirSync(path.join(dir, d))
    const gen = await sh('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2',
      '-subj', '/CN=oasis.example.com', '-addext', 'subjectAltName=DNS:oasis.example.com',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    ])
    if (gen.code !== 0) throw new Error(gen.out)
    const move = (text: string): string =>
      text
        .replaceAll('/etc/nginx/oasis/', `${dir}/oasis/`)
        .replaceAll('/var/log/nginx/', `${dir}/log/`)
        .replaceAll('/var/cache/nginx/', `${dir}/cache/`)
        .replaceAll(stage.cert, `${dir}/cert.pem`)
        .replaceAll(stage.key, `${dir}/key.pem`)
        .replace(/listen \[::\]:(80|443)[^;]*;\n/g, '')
        .replace(/listen 80( default_server)?;/g, `listen 127.0.0.1:${P80}$1;`)
        .replace(/listen 443 ssl( default_server)?;/g, `listen 127.0.0.1:${P443} ssl$1;`)
        .replace('server 127.0.0.1:4000;', `server 127.0.0.1:${API};`)
        .replace('server 127.0.0.1:3200;', `server 127.0.0.1:${WEB};`)
    for (const f of ['conf.d/oasis.conf', 'conf.d/00-oasis-zones.conf', 'oasis/proxy.conf', 'oasis/security-headers.conf', 'oasis/tls.conf'])
      writeFileSync(path.join(dir, f), move(read(`etc/nginx/${f}`)))
    const tmp = path.join(dir, 'tmp')
    writeFileSync(
      path.join(dir, 'nginx.conf'),
      `pid ${dir}/nginx.pid;\nerror_log stderr warn;\nevents { worker_connections 64; }\nhttp {\n` +
        ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map((n) => `  ${n}_temp_path ${tmp}/${n};\n`).join('') +
        `  access_log off;\n  include ${dir}/conf.d/*.conf;\n}\n`,
    )
    // the upstreams send their own HSTS and nosniff, as helmet and next.config.mjs do
    const upstream = (name: string, port: number) =>
      new Promise<void>((resolve) => {
        const s = createServer((req, res) => {
          hits.push(`${name} ${req.method} ${req.url}`)
          req.resume()
          req.on('end', () =>
            res
              .writeHead(200, {
                'strict-transport-security': 'max-age=15552000; includeSubDomains',
                'x-content-type-options': 'nosniff',
                'content-type': 'text/plain',
              })
              .end(name),
          )
        })
        upstreams.push(s)
        s.listen(port, '127.0.0.1', resolve)
      })
    await upstream('api', API)
    await upstream('web', WEB)
  }, 60_000)

  afterAll(async () => {
    if (nginx?.pid) nginx.kill('SIGTERM')
    await Promise.all(upstreams.map((s) => new Promise<void>((r) => s.close(() => r()))))
    t.cleanup()
  })

  const nginxArgs = () => ['-p', dir, '-e', 'stderr', '-c', path.join(dir, 'nginx.conf')]

  it('nginx -t accepts the rendered site without a warning', async () => {
    const r = await sh(NGINX!, ['-t', ...nginxArgs()])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/syntax is ok/)
    expect(r.out.split('\n').filter((l) => /\[(warn|emerg|alert|crit|error)\]/.test(l))).toEqual([])
  })

  it('answers only its own name, keeps every other letter case of /api away from Next.js, and every answer has HSTS and nosniff once', async () => {
    nginx = spawn(NGINX!, [...nginxArgs(), '-g', 'daemon off; master_process off;'], { stdio: 'ignore' })
    for (let i = 0; i < 50; i++) {
      if ((await sh('curl', ['-s', '-o', '/dev/null', `http://127.0.0.1:${P80}/`])).code === 52) break
      await new Promise((r) => setTimeout(r, 100))
    }
    const site = `https://oasis.example.com:${P443}`
    const resolve = ['--resolve', `oasis.example.com:${P443}:127.0.0.1`, '--resolve', `other.example.com:${P443}:127.0.0.1`]
    const get = async (url: string, extra: string[] = []) => {
      const r = await sh('curl', ['-sk', '-D', '-', '-o', '/dev/null', '--max-time', '5', ...resolve, ...extra, url])
      const lines = r.stdout.split('\r\n')
      const status = Number(/^HTTP\/\S+ (\d+)/.exec(lines[0] ?? '')?.[1] ?? 0)
      const header = (name: string) =>
        lines
          .filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
          .map((l) => `${name.toLowerCase()}:${l.slice(name.length + 1)}`)
      return { code: r.code, status, header }
    }
    const once = (res: Awaited<ReturnType<typeof get>>, what: string) => {
      expect(res.header('strict-transport-security'), what).toEqual(['strict-transport-security: max-age=15552000; includeSubDomains'])
      expect(res.header('x-content-type-options'), what).toEqual(['x-content-type-options: nosniff'])
    }

    // other names and bare addresses: no answer on 80, no handshake on 443
    expect((await get(`http://127.0.0.1:${P80}/`)).code).toBe(52) // empty reply (444)
    expect((await get(`http://127.0.0.1:${P80}/`, ['-H', 'Host: other.example.com'])).code).toBe(52)
    expect((await get(`https://127.0.0.1:${P443}/login`)).code).toBe(35) // no SNI: handshake refused
    expect((await get(`https://other.example.com:${P443}/login`)).code).toBe(35)
    const http = await get(`http://127.0.0.1:${P80}/x`, ['-H', 'Host: oasis.example.com'])
    expect(http.status).toBe(301)
    expect(http.header('location')).toEqual(['location: https://oasis.example.com/x'])

    // proxied answers: one copy of each header although the upstream sends its own
    hits.length = 0
    const page = await get(`${site}/login`)
    expect(page.status).toBe(200)
    once(page, 'dashboard page')
    const api = await get(`${site}/api/v1/customers`)
    expect(api.status).toBe(200)
    once(api, 'API answer')
    expect(hits).toEqual(['web GET /login', 'api GET /api/v1/customers'])

    // any other letter case: 404 from nginx, nothing reaches either upstream
    hits.length = 0
    for (const uri of ['/API/v1/openapi.json', '/Api/v1/meta/now', '/API', '/Dev-Storage/x', '/dev-storage', '/HOOKS/smsgate/x']) {
      const r = await get(`${site}${uri}`)
      expect(r.status, uri).toBe(404)
      once(r, uri)
    }
    // lower-case /api: nginx's own 301 to /api/ (a proxied prefix that ends in a slash), never Next.js
    const bare = await get(`${site}/api`)
    expect(bare.status).toBe(301)
    expect(bare.header('location')).toEqual([`location: https://oasis.example.com:${P443}/api/`]) // the port only because the test listens on one
    once(bare, '301 /api')
    expect(hits).toEqual([])

    // nginx's own answers carry the headers too: 404 (hooks), 403 (not loopback), 413 (body), 429 (rate)
    once(await get(`${site}/hooks/smsgate/x`), '404 hooks')
    const denied = await get(`${site}/readyz`, ['--interface', '127.0.0.3'])
    expect(denied.status).toBe(403)
    once(denied, '403 readyz')
    const big = path.join(dir, 'big.bin')
    writeFileSync(big, Buffer.alloc(3 * 1024 * 1024))
    const tooBig = await get(`${site}/api/v1/photos`, ['-X', 'POST', '--data-binary', `@${big}`, '-H', 'content-type: application/octet-stream'])
    expect(tooBig.status).toBe(413)
    once(tooBig, '413')
    let limited: Awaited<ReturnType<typeof get>> | undefined
    for (let i = 0; i < 20 && !limited; i++) {
      const r = await get(`${site}/api/v1/auth/login`, ['-X', 'POST', '-d', '{}'])
      if (r.status === 429) limited = r
    }
    expect(limited, 'the login zone answers 429 after its burst').toBeDefined()
    once(limited!, '429')
  }, 60_000)

  it('treats the website’s public API on this host as the website’s host does: cached reads, 16k bodies, the write zone', async () => {
    const site = `https://oasis.example.com:${P443}`
    const resolve = ['--resolve', `oasis.example.com:${P443}:127.0.0.1`]
    const call = async (url: string, extra: string[] = []) => {
      const r = await sh('curl', ['-sk', '-D', '-', '-o', '/dev/null', '--max-time', '5', ...resolve, ...extra, url])
      const lines = r.stdout.split('\r\n')
      return {
        status: Number(/^HTTP\/\S+ (\d+)/.exec(lines[0] ?? '')?.[1] ?? 0),
        cache: lines.find((l) => l.toLowerCase().startsWith('x-cache-status:'))?.slice(15).trim(),
      }
    }
    hits.length = 0
    expect(await call(`${site}/api/v1/public/availability?days=5`)).toEqual({ status: 200, cache: 'MISS' })
    expect(await call(`${site}/api/v1/public/availability?days=5`)).toEqual({ status: 200, cache: 'HIT' })
    // an extra parameter is the same cache entry: it never reaches the API
    expect(await call(`${site}/api/v1/public/availability?days=5&zz=${Date.now()}`)).toEqual({ status: 200, cache: 'HIT' })
    expect(await call(`${site}/api/v1/public/hours`)).toEqual({ status: 200, cache: 'MISS' })
    expect(await call(`${site}/api/v1/public/hours?_=${Date.now()}`)).toEqual({ status: 200, cache: 'HIT' })
    expect(hits).toEqual(['api GET /api/v1/public/availability?days=5', 'api GET /api/v1/public/hours'])
    // a body over 16k is refused by nginx; the writes have the website's zone (20 a minute, a burst of 10)
    const big = path.join(dir, 'public-big.json')
    writeFileSync(big, `{"name":"${'x'.repeat(20 * 1024)}"}`)
    expect((await call(`${site}/api/v1/public/bookings`, ['-X', 'POST', '--data-binary', `@${big}`, '-H', 'content-type: application/json'])).status).toBe(413)
    const answers: number[] = []
    for (let i = 0; i < 14; i++) answers.push((await call(`${site}/api/v1/public/otp`, ['-X', 'POST', '-d', '{}', '-H', 'content-type: application/json'])).status)
    expect(answers.filter((x) => x === 200).length).toBeLessThanOrEqual(11)
    expect(answers.at(-1)).toBe(429)
  }, 60_000)
})
