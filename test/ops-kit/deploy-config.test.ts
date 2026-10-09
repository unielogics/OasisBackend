// The files install.sh writes (env, systemd, nginx), read back the way systemd and nginx would read them.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { envSchema, loadEnv } from '../../src/config/env.js'
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

  it('install.sh fills the secrets and URLs, with correct sizes, and keeps the files at 0640', () => {
    const common = parseEnvFile(read('etc/oasis/common.env'))
    expect(Buffer.from(common.SECRETS_KEY!, 'base64')).toHaveLength(32)
    expect(Buffer.from(common.SESSION_SECRET!, 'base64').length).toBeGreaterThanOrEqual(32)
    expect(common.PUBLIC_API_URL).toBe('https://oasis.example.com')
    expect(common.PUBLIC_DASHBOARD_URL).toBe('https://oasis.example.com')
    expect(common.DATABASE_URL).toMatch(/^postgres:\/\/oasis:[0-9a-f]{48}@127\.0\.0\.1:5432\/oasis$/)
    for (const n of ['common', 'api', 'worker', 'web'])
      expect((statSync(path.join(stage.etc, `${n}.env`)).mode & 0o777).toString(8)).toBe('640')
  })

  it('the production environment (common + api) passes the app own validation, and is safe', () => {
    const merged = {
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

  it('run the three services as the oasis user with restart policy, ordering after Postgres and a graceful stop', () => {
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
      expect(unit(`${n}.service`).Unit!.After![0], n).toContain('postgresql.service')
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
      expect(start).toMatch(/NEXT_PUBLIC_VARIANT=live DIST_DIR=(?:\.next-live|\$\{LIVE_DIST_DIR:-\.next-live\}) next start/)
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

  it('back up nightly in shop time and drill monthly, both with persistent timers', () => {
    expect(unit('oasis-backup.timer').Timer!.OnCalendar![0]).toMatch(/^\*-\*-\* 03:15:00 America\/New_York$/)
    expect(unit('oasis-backup.timer').Timer!.Persistent).toEqual(['true'])
    expect(unit('oasis-restore-drill.timer').Timer!.OnCalendar![0]).toMatch(/^\*-\*-02 /)
    expect(unit('oasis-backup.service').Service!.ExecStart![0]).toBe(
      '/opt/oasis/current/backend/deploy/scripts/backup.sh --label nightly',
    )
    expect(unit('oasis-restore-drill.service').Service!.ExecStart![0]).toBe(
      '/opt/oasis/current/backend/deploy/scripts/restore-drill.sh --latest',
    )
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
            read(`etc/systemd/system/${name}`).replaceAll('/opt/oasis/current/backend', REPO),
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

describe('nginx site', () => {
  const conf = (rel: string): Directive[] => parseNginx(read(`etc/nginx/${rel}`))
  const reader = (p: string): string => readText(path.join(stage.root, p))
  const servers = (): Directive[] => find(find(conf('conf.d/oasis.conf'), 'server'), 'server')
  const https = (): Directive =>
    servers().find((s) => find(s.block!, 'listen').some((l) => l.args[0] === '443'))!
  const httpsLocs = () => locationsOf({ ...https(), block: expandIncludes(https().block!, reader) })
  const text = (): string =>
    ['conf.d/oasis.conf', 'conf.d/00-oasis-zones.conf', 'oasis/proxy.conf', 'oasis/security-headers.conf']
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
    const [plain] = servers()
    const locs = locationsOf(plain!)
    expect(find(plain!.block!, 'server_name')[0]!.args).toEqual(['oasis.example.com'])
    expect(locs.find((l) => l.pattern === '/.well-known/acme-challenge/')).toBeDefined()
    expect(find(locs.find((l) => l.pattern === '/')!.body, 'return')[0]!.args).toEqual([
      '301',
      'https://oasis.example.com$request_uri',
    ])
    const s = https().block!
    expect(find(s, 'ssl_certificate')[0]!.args[0]).toBe(stage.cert)
    expect(find(s, 'ssl_certificate_key')[0]!.args[0]).toBe(stage.key)
    expect(find(s, 'ssl_protocols')[0]!.args).toEqual(['TLSv1.2', 'TLSv1.3'])
    expect(find(s, 'ssl_session_tickets')[0]!.args).toEqual(['off'])
    expect(find(s, 'http2')[0]!.args).toEqual(['on'])
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
    expect(where('/api/v1/auth/logout')).toBe('/api/')
    expect(where('/hooks/squarespace')).toBe('= /hooks/squarespace')
    expect(proxied('/hooks/squarespace')).toBe('http://oasis_api')
    expect(where('/hooks/ses')).toBe('= /hooks/ses')
    expect(where('/healthz')).toBe('= /healthz')
    expect(where('/readyz')).toBe('= /readyz')
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
    // every proxied location includes the shared proxy settings
    for (const l of locationsOf(https())) {
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
    const csp = headers['Content-Security-Policy-Report-Only']!
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("connect-src 'self' https://*.amazonaws.com")
    // the dashboard location includes them; the API locations do not (helmet already sets them, a second copy would duplicate)
    const locs = httpsLocs()
    expect(find(matchLocation(locationsOf(https()), '/')!.body, 'include').map((i) => i.args[0])).toContain(
      '/etc/nginx/oasis/security-headers.conf',
    )
    expect(find(matchLocation(locs, '/api/v1/customers')!.body, 'add_header')).toEqual([])
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

  it('the include files it references exist, and --csp changes only the header name', async () => {
    for (const inc of text().matchAll(/include ([^;]+);/g))
      expect(existsSync(path.join(stage.root, inc[1]!)), inc[1]).toBe(true)
    const t = tempDir('oasis-csp-')
    try {
      for (const [mode, header] of [
        ['enforce', 'Content-Security-Policy'],
        ['off', 'X-Oasis-Csp-Disabled'],
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
        expect(h.map((d) => d.args[0])).toContain(header)
      }
    } finally {
      t.cleanup()
    }
  })
})
