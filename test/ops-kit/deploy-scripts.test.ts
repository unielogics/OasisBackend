import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { secretKeyProblems } from '../../src/config/secrets-source.js'
import { invalidValues, parseDotenv } from '../../scripts/secrets-push.js'
import { DEPLOY, parseEnvFile, script, sh, tempDir, tree, writeExecutable } from './deploy-helpers.js'
import { useStage } from './deploy-stage.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

const allScripts = (): string[] => [
  ...readdirSync(path.join(DEPLOY, 'scripts')).map((f) => path.join(DEPLOY, 'scripts', f)),
  ...readdirSync(path.join(DEPLOY, 'lib'))
    .filter((f) => f.endsWith('.sh'))
    .map((f) => path.join(DEPLOY, 'lib', f)),
]

describe('shell scripts', () => {
  it('parse with bash -n', async () => {
    for (const f of allScripts()) expect((await sh('bash', ['-n', f])).code, f).toBe(0)
  })

  it('are executable, start with a bash shebang, and the entry points fail on error (set -euo pipefail)', () => {
    for (const f of readdirSync(path.join(DEPLOY, 'scripts')).map((n) => path.join(DEPLOY, 'scripts', n))) {
      const text = readFileSync(f, 'utf8')
      expect(text.startsWith('#!/usr/bin/env bash\n'), f).toBe(true)
      expect(statSync(f).mode & 0o111, `${f} is not executable`).not.toBe(0)
      expect(text, f).toMatch(/^set -euo pipefail$/m)
      expect(text, f).not.toMatch(/\beval\b/)
    }
  })

  it('every entry point answers --help with usage and exit 0, without needing root or a system', async () => {
    for (const name of readdirSync(path.join(DEPLOY, 'scripts'))) {
      if (name === 'gen-secrets.sh' || name === 'bootstrap-admin.sh' || name === 'reset-password.sh') continue
      const r = await sh(script(name), ['--help'], { TAILSCALE_BIN: 'true' })
      expect(r.code, `${name}: ${r.out}`).toBe(0)
      expect(r.stdout.length, name).toBeGreaterThan(80)
    }
  })

  // Runs when shellcheck is on the PATH or named in SHELLCHECK; otherwise it is skipped (not installed system-wide on the build host).
  const shellcheck = [process.env.SHELLCHECK, '/usr/bin/shellcheck', '/usr/local/bin/shellcheck'].find(
    (p) => !!p && existsSync(p),
  )
  it.skipIf(!shellcheck)(
    'pass shellcheck at warning level (skipped when shellcheck is not installed)',
    async () => {
      const r = await sh(shellcheck!, ['-x', '-P', 'SCRIPTDIR', '-S', 'warning', ...allScripts()])
      expect(r.out).toBe('')
    },
    120_000,
  )
})

describe('install.sh', () => {
  it('--dry-run plans every step and changes nothing', async () => {
    const t = tempDir('oasis-dry-')
    cleanups.push(t.cleanup)
    const r = await sh(
      script('install.sh'),
      [
        '--domain',
        'oasis.example.com',
        '--email',
        'ops@example.com',
        '--dry-run',
        '--local-db',
        '--drill-role',
        '--install-packages',
        '--install-postgres',
        '--gen-deploy-keys',
        '--backend-repo',
        'git@example.test:o/b.git',
      ],
      { OASIS_ROOT_PREFIX: t.dir },
    )
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('[dry run]')
    expect(r.out).toMatch(/\+ dnf install -y nginx/)
    expect(r.out).toMatch(/plan\s+would write .*oasis-api\.service/)
    expect(r.out).toMatch(/plan\s+would write .*conf\.d\/oasis\.conf/)
    // the timers are started, not only enabled (enabled alone they wait for the next boot), and so is the metadata guard
    expect(r.out).toContain('+ systemctl enable --now oasis-backup.timer oasis-healthcheck.timer\n')
    expect(r.out).toContain('+ systemctl enable --now oasis-restore-drill.timer\n')
    expect(r.out).toContain('+ systemctl enable --now oasis-imds-guard.service\n')
    expect(r.out).toContain('+ systemctl enable oasis.target oasis-api.service oasis-worker.service oasis-web.service\n')
    expect(r.out).toMatch(/would run the health check once: systemctl start oasis-healthcheck\.service/)
    // /opt/oasis and its releases belong to root; only the clones are the service user's; the kit goes to its root-owned place
    expect(r.out).toContain(`+ chown root:root ${t.dir}/opt/oasis\n`)
    expect(r.out).toContain(`+ chown root:root ${t.dir}/opt/oasis/releases\n`)
    expect(r.out).toContain(`+ chown oasis:oasis ${t.dir}/opt/oasis/src\n`)
    expect(r.out).toMatch(/would install the deploy kit from \S+\/deploy into \S+\/usr\/local\/lib\/oasis\/deploy \(root:root, read-only for everyone else\)/)
    // ... after nginx, so the check can go through the public URL
    expect(r.out.indexOf('would run the health check once')).toBeGreaterThan(r.out.indexOf('nginx -t'))
    expect(tree(t.dir).filter((l) => !l.startsWith('etc dir') && !l.startsWith('var dir'))).toEqual([])
    expect(readdirSync(t.dir)).toEqual([])
  })

  it('is idempotent: a second run changes no file and regenerates no secret', async () => {
    const t = tempDir('oasis-idem-')
    cleanups.push(t.cleanup)
    const args = [
      '--domain',
      'oasis.example.com',
      '--tls',
      'files',
      '--tls-cert',
      '/c.pem',
      '--tls-key',
      '/k.pem',
      '--no-system',
    ]
    const env = { OASIS_ROOT_PREFIX: t.dir }
    const fingerprint = (): string[] => {
      const out: string[] = []
      const walk = (d: string): void => {
        for (const n of readdirSync(d).sort()) {
          const p = path.join(d, n)
          if (statSync(p).isDirectory()) walk(p)
          else
            out.push(
              `${path.relative(t.dir, p)} ${createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)} ${(statSync(p).mode & 0o777).toString(8)}`,
            )
        }
      }
      walk(t.dir)
      return out
    }
    expect((await sh(script('install.sh'), args, env)).code).toBe(0)
    const first = fingerprint()
    const second = await sh(script('install.sh'), args, env)
    expect(second.code, second.out).toBe(0)
    expect(second.out).not.toMatch(/\bdone\s+wrote\b/)
    expect(fingerprint()).toEqual(first)
    // a changed option changes only the files it touches
    const csp = await sh(script('install.sh'), [...args, '--csp', 'enforce'], env)
    expect(csp.out.match(/done\s+wrote .*/g)).toEqual([expect.stringContaining('security-headers.conf')])
  })

  it('copies the kit into its root-owned place, and a run from that copy uses it as it is', async () => {
    const t = tempDir('oasis-kit-')
    cleanups.push(t.cleanup)
    const args = ['--domain', 'oasis.example.com', '--tls', 'files', '--tls-cert', '/c.pem', '--tls-key', '/k.pem', '--no-system']
    const env = { OASIS_ROOT_PREFIX: t.dir }
    const first = await sh(script('install.sh'), args, env)
    expect(first.code, first.out).toBe(0)
    const kit = path.join(t.dir, 'usr/local/lib/oasis/deploy')
    expect((await sh('diff', ['-r', DEPLOY, kit])).code).toBe(0)
    const writable = tree(kit).filter((l) => (parseInt(l.split(' ').at(-1)!, 8) & 0o022) !== 0)
    expect(writable).toEqual([])
    // the units name the kit, not a release
    expect(readFileSync(path.join(t.dir, 'etc/systemd/system/oasis-backup.service'), 'utf8')).toContain(
      'ExecStart=/usr/local/lib/oasis/deploy/scripts/backup.sh --label nightly',
    )
    const again = await sh(path.join(kit, 'scripts/install.sh'), args, env)
    expect(again.code, again.out).toBe(0)
    expect(again.out).toMatch(/ok\s+the deploy kit runs from \S+\/usr\/local\/lib\/oasis\/deploy/)
    expect(again.out).not.toMatch(/\bdone\s+wrote\b/)
    expect(first.out).toContain('Deploy, as root, always from the root-owned kit:   /usr/local/lib/oasis/deploy/scripts/deploy.sh')
  })

  it('rejects unusable input before touching anything', async () => {
    const t = tempDir('oasis-bad-')
    cleanups.push(t.cleanup)
    const env = { OASIS_ROOT_PREFIX: t.dir }
    expect((await sh(script('install.sh'), ['--no-system'], env)).out).toMatch(/--domain is required/)
    expect((await sh(script('install.sh'), ['--domain', 'bad host!', '--no-system'], env)).out).toMatch(
      /is not a host name/,
    )
    expect(
      (await sh(script('install.sh'), ['--domain', 'a.example.com', '--tls', 'files', '--no-system'], env))
        .out,
    ).toMatch(/--tls files needs --tls-cert and --tls-key/)
    expect(
      (await sh(script('install.sh'), ['--domain', 'a.example.com', '--csp', 'maybe', '--no-system'], env))
        .out,
    ).toMatch(/--csp must be/)
    expect(readdirSync(t.dir)).toEqual([])
  })

  it('refuses to run as a normal user unless it is a dry run or a staging directory', async () => {
    if (process.getuid?.() === 0) return
    const r = await sh(script('install.sh'), ['--domain', 'a.example.com'], {})
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/run as root/)
  })
})

describe('gen-secrets.sh', () => {
  it('prints strong, distinct secrets of the documented sizes', async () => {
    const a = parseEnvFile((await sh(script('gen-secrets.sh'), [])).stdout)
    const b = parseEnvFile((await sh(script('gen-secrets.sh'), [])).stdout)
    expect(Buffer.from(a.SESSION_SECRET!, 'base64')).toHaveLength(48)
    expect(Buffer.from(a.SECRETS_KEY!, 'base64')).toHaveLength(32)
    expect(Buffer.from(a.BACKUP_ENCRYPTION_KEY!, 'base64')).toHaveLength(32)
    expect(a.SMSGATE_WEBHOOK_SECRET).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(a.DB_PASSWORD).toMatch(/^[0-9a-f]{48}$/)
    expect(a.STORAGE_SIGNING_SECRET).toMatch(/^[0-9a-f]{64}$/)
    expect(a.BOOTSTRAP_ADMIN_PASSWORD!.length).toBeGreaterThanOrEqual(24)
    for (const k of Object.keys(a)) expect(a[k], k).not.toBe(b[k])
    expect((await sh(script('gen-secrets.sh'), ['SECRETS_KEY'])).stdout.trim().split('\n')).toHaveLength(1)
    expect((await sh(script('gen-secrets.sh'), ['NOPE'])).code).not.toBe(0)
  })

  it('--secret prints exactly the file for the environment secret, which pnpm secrets:push accepts as it is', async () => {
    const out = (await sh(script('gen-secrets.sh'), ['--secret'])).stdout
    const a = parseEnvFile(out)
    expect(Object.keys(a)).toEqual(['DATABASE_URL', 'SESSION_SECRET', 'SECRETS_KEY', 'STORAGE_SIGNING_SECRET'])
    expect(a.DATABASE_URL).toMatch(/^postgres:\/\/oasis:[0-9a-f]{48}@127\.0\.0\.1:5432\/oasis$/)
    expect(Buffer.from(a.SECRETS_KEY!, 'base64')).toHaveLength(32)
    const values = parseDotenv(out, 'gen-secrets')
    expect(secretKeyProblems(values.keys())).toEqual({ forbidden: [], unknown: [] })
    expect(invalidValues(values)).toEqual([])
    expect(parseEnvFile((await sh(script('gen-secrets.sh'), ['--secret'])).stdout).SECRETS_KEY).not.toBe(a.SECRETS_KEY)
    expect((await sh(script('gen-secrets.sh'), ['--secret', 'SECRETS_KEY'])).code).toBe(2)
  })
})

describe('bootstrap-admin.sh (a host without the secret: api.env)', () => {
  const stage = useStage(['--secrets-in-files'])
  const run = (...args: string[]) =>
    sh(script('bootstrap-admin.sh'), args, { ...stage.env, OASIS_ALLOW_NONROOT: '1' })
  const apiEnv = (): string => readFileSync(path.join(stage.etc, 'api.env'), 'utf8')

  it('set writes a generated password once, in a form the app accepts, and clear removes both lines', async () => {
    const before = parseEnvFile(readFileSync(path.join(stage.etc, 'common.env'), 'utf8'))
    const set = await run('set', 'owner@example.com')
    expect(set.code, set.out).toBe(0)
    const password = /Password:\s+(\S+)/.exec(set.stdout)![1]!
    expect(password.length).toBeGreaterThanOrEqual(24)
    const env = parseEnvFile(apiEnv())
    expect(env.BOOTSTRAP_ADMIN_EMAIL).toBe('owner@example.com')
    expect(env.BOOTSTRAP_ADMIN_PASSWORD).toBe(password)
    expect(statSync(path.join(stage.etc, 'api.env')).mode & 0o777).toBe(0o640)
    expect(readdirSync(stage.etc).some((f) => f.startsWith('api.env.bak-'))).toBe(true)
    const merged = {
      ...before,
      ...parseEnvFile(readFileSync(path.join(stage.etc, 'common.env'), 'utf8')),
      ...env,
      NODE_ENV: 'production',
    }
    expect(loadEnv(merged).BOOTSTRAP_ADMIN_EMAIL).toBe('owner@example.com')
    expect((await run('status')).stdout).toMatch(/BOOTSTRAP_ADMIN_PASSWORD: \(set\)/)

    const clear = await run('clear')
    expect(clear.code, clear.out).toBe(0)
    expect(apiEnv()).not.toMatch(/^BOOTSTRAP_ADMIN_(EMAIL|PASSWORD)=/m)
    expect(() =>
      loadEnv({
        ...merged,
        ...Object.fromEntries(Object.entries(parseEnvFile(apiEnv()))),
        BOOTSTRAP_ADMIN_EMAIL: undefined,
        BOOTSTRAP_ADMIN_PASSWORD: undefined,
      }),
    ).not.toThrow()
    expect(apiEnv()).not.toContain(password)
  })

  it('rejects a bad address and unknown commands', async () => {
    expect((await run('set', 'not-an-email')).code).not.toBe(0)
    expect((await run('frobnicate')).code).toBe(2)
  })
})

describe('healthcheck.sh', () => {
  async function stub(routes: Record<string, [number, string]>, port: number): Promise<Server> {
    const server = createServer((req, res) => {
      const hit = routes[req.url ?? '']
      if (!hit) return void res.writeHead(404).end('{}')
      res.writeHead(hit[0], { 'content-type': 'application/json' }).end(hit[1])
    })
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())))
    return server
  }
  const ready = '{"status":"ready","checks":{}}'
  const args = ['--api', 'http://127.0.0.1:4595', '--web', 'http://127.0.0.1:4594']
  // hermetic: a systemctl stand-in (WORKER_STATE, default active) and no public URL unless a test gives one
  const fakes = tempDir('oasis-hc-bin-')
  afterAll(fakes.cleanup)
  const systemctl = path.join(fakes.dir, 'systemctl')
  writeExecutable(systemctl, '#!/usr/bin/env bash\necho "$*" >> "${SYSTEMCTL_LOG:-/dev/null}"\nst=${WORKER_STATE:-active}; echo "$st"; [ "$st" = active ]\n')
  const hc = (extra: string[] = [], env: Record<string, string | undefined> = {}) =>
    sh(script('healthcheck.sh'), [...args, ...extra], { SYSTEMCTL: systemctl, PUBLIC_DASHBOARD_URL: '', SITE_URL: '', ...env })

  it('passes when the API is ready and the dashboard answers', async () => {
    await stub({ '/healthz': [200, '{"status":"ok"}'], '/readyz': [200, ready] }, 4595)
    await stub({ '/login': [200, '<html>'] }, 4594)
    const r = await hc()
    expect(r.code, r.out).toBe(0)
    expect(r.stdout).toMatch(/^healthy:/)
  })

  it('finds the ports in the environment files, so a changed PORT cannot send a deploy to the wrong address', async () => {
    const t = tempDir('oasis-hc-')
    cleanups.push(t.cleanup)
    mkdirSync(path.join(t.dir, 'etc'), { recursive: true })
    writeFileSync(path.join(t.dir, 'etc/api.env'), '# the API port\nHOST=127.0.0.1\nPORT=4595\n')
    writeFileSync(path.join(t.dir, 'etc/web.env'), "WEB_HOST=127.0.0.1\nWEB_PORT='4594'\n")
    await stub({ '/healthz': [200, '{}'], '/readyz': [200, ready] }, 4595)
    await stub({ '/login': [200, ''] }, 4594)
    const r = await sh(script('healthcheck.sh'), [], { OASIS_ETC: path.join(t.dir, 'etc'), SYSTEMCTL: systemctl })
    expect(r.code, r.out).toBe(0)
    expect(r.stdout).toContain('api http://127.0.0.1:4595, dashboard http://127.0.0.1:4594')
  })

  it('fails and names each problem: database down, dashboard down', async () => {
    await stub(
      {
        '/healthz': [200, '{"status":"ok"}'],
        '/readyz': [503, '{"status":"degraded","checks":{"db":{"ok":false,"detail":"connection refused"}}}'],
      },
      4595,
    )
    const r = await hc()
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/UNHEALTHY/)
    expect(r.stderr).toMatch(/api readiness: .*\/readyz answered HTTP 503, expected 200.*connection refused/)
    expect(r.stderr).toMatch(/dashboard: .*\/login answered HTTP 000/)
  })

  it('a 200 from /readyz that does not say ready is still a failure', async () => {
    await stub({ '/healthz': [200, '{}'], '/readyz': [200, '{"status":"degraded"}'] }, 4595)
    await stub({ '/login': [200, ''] }, 4594)
    const r = await hc()
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/does not match/)
  })

  it('--wait retries until the stack comes up', async () => {
    const t0 = Date.now()
    const server = await stub({ '/healthz': [200, '{}'], '/readyz': [503, '{}'] }, 4595)
    await stub({ '/login': [200, ''] }, 4594)
    setTimeout(() => {
      server.removeAllListeners('request')
      server.on('request', (_q, res) => res.writeHead(200).end(ready))
    }, 1500)
    const r = await hc(['--wait', '10'])
    expect(r.code, r.out).toBe(0)
    expect(Date.now() - t0).toBeGreaterThan(1200)
  })

  it('--public also proves the SMS hook is not reachable from outside', async () => {
    await stub(
      {
        '/healthz': [200, '{}'],
        '/readyz': [200, ready],
        '/hooks/smsgate/healthcheck': [200, '{"ok":true}'],
      },
      4595,
    )
    await stub({ '/login': [200, ''] }, 4594)
    const r = await hc(['--public', 'http://127.0.0.1:4595'])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/public sms hook hidden: .* answered HTTP 200, expected 404/)
  })

  it('checks through the public URL that a signed-out visit goes to that URL /login, never to localhost or another host', async () => {
    await stub({ '/healthz': [200, '{}'], '/readyz': [200, ready] }, 4595)
    await stub({ '/login': [200, ''] }, 4594)
    let reply: [number, string | undefined] = [307, 'http://127.0.0.1:4681/login?next=%2F']
    const pub = createServer((req, res) => {
      if (req.url !== '/' || req.headers.cookie) return void res.writeHead(500).end()
      res.writeHead(reply[0], reply[1] ? { location: reply[1] } : {}).end()
    })
    await new Promise<void>((r) => pub.listen(4681, '127.0.0.1', r))
    cleanups.push(() => new Promise<void>((r) => pub.close(() => r())))
    const PUBLIC = { PUBLIC_DASHBOARD_URL: 'http://127.0.0.1:4681' }

    const good = await hc([], PUBLIC)
    expect(good.code, good.out).toBe(0)
    expect(good.stdout).toContain('sign-in redirect http://127.0.0.1:4681/login, worker active')
    reply = [307, '/login?next=%2F'] // a relative Location stays on the origin the visitor used
    expect((await hc([], PUBLIC)).code).toBe(0)
    for (const bad of [
      'https://localhost:3200/login?next=%2F', // Next building it from its own listen address (the launch-day bug)
      'https://evil.example/login',
      'http://127.0.0.1:4681.evil.example/login',
      '//evil.example/login',
      'http://127.0.0.1:4681/elsewhere',
    ]) {
      reply = [307, bad]
      const r = await hc([], PUBLIC)
      expect(r.code, bad).toBe(1)
      expect(r.stderr, bad).toContain(`public sign-in redirect: http://127.0.0.1:4681/ sends a signed-out visitor to '${bad}'`)
    }
    reply = [200, undefined]
    expect((await hc([], PUBLIC)).stderr).toMatch(/public sign-in redirect: .* answered HTTP 200, expected 307/)
    expect((await hc(['--skip-public'], PUBLIC)).code).toBe(0)

    // without the variable, the URL comes from common.env (the timer's unit does not load it)
    reply = [307, 'https://localhost:3200/login']
    const etc = tempDir('oasis-hc-etc-')
    cleanups.push(etc.cleanup)
    writeFileSync(path.join(etc.dir, 'common.env'), '# public\nPUBLIC_DASHBOARD_URL=http://127.0.0.1:4681\n')
    const fromFile = await hc([], { PUBLIC_DASHBOARD_URL: undefined, OASIS_ETC: etc.dir })
    expect(fromFile.code).toBe(1)
    expect(fromFile.stderr).toContain("sends a signed-out visitor to 'https://localhost:3200/login'")
  })

  describe('the public website', () => {
    const page = '<!doctype html><html><body><h1>Oasis Auto Spa</h1><p>Hand car wash</p></body></html>'
    const upstreams = async () => {
      await stub({ '/healthz': [200, '{}'], '/readyz': [200, ready] }, 4595)
      await stub({ '/login': [200, ''] }, 4594)
    }
    // the www host: a redirect (or not) to wherever the test says
    const www = async (status: number, location?: string) => {
      const s = createServer((_req, res) => res.writeHead(status, location ? { location } : {}).end())
      await new Promise<void>((r) => s.listen(4597, '127.0.0.1', r))
      cleanups.push(() => new Promise<void>((r) => s.close(() => r())))
    }
    const SITE = { SITE_URL: 'http://127.0.0.1:4596', SITE_MARKER: 'Oasis Auto Spa', SITE_WWW_URL: 'http://127.0.0.1:4597' }

    it('passes when the front page carries the marker and www answers 301 to the apex', async () => {
      await upstreams()
      await stub({ '/': [200, page] }, 4596)
      await www(301, 'http://127.0.0.1:4596/')
      const r = await hc([], SITE)
      expect(r.code, r.out).toBe(0)
      expect(r.stdout).toContain('worker active, website http://127.0.0.1:4596/ (www 301)')
      // --site names the URL; without a www URL only the page is probed
      const only = await hc(['--site', 'http://127.0.0.1:4596'], { SITE_MARKER: 'Oasis Auto Spa' })
      expect(only.code, only.out).toBe(0)
      expect(only.stdout).toMatch(/website http:\/\/127\.0\.0\.1:4596\/$/m)
    })

    it('fails and says why: the marker is missing, www is not a 301 to the apex, the page is down', async () => {
      await upstreams()
      await stub({ '/': [200, '<html><body>Under construction</body></html>'] }, 4596)
      await www(200)
      const r = await hc([], SITE)
      expect(r.code).toBe(1)
      expect(r.stderr).toMatch(/website: http:\/\/127\.0\.0\.1:4596\/ answered 200 but the page does not contain 'Oasis Auto Spa'/)
      expect(r.stderr).toMatch(/website www: http:\/\/127\.0\.0\.1:4597\/ answered HTTP 200, expected 301 to http:\/\/127\.0\.0\.1:4596\//)
      const elsewhere = await hc([], { ...SITE, SITE_WWW_URL: 'http://127.0.0.1:4595' })
      expect(elsewhere.stderr).toMatch(/website www: .* answered HTTP 404, expected 301/)
      const down = await hc([], { ...SITE, SITE_URL: 'http://127.0.0.1:4593', SITE_WWW_URL: '' })
      expect(down.code).toBe(1)
      expect(down.stderr).toMatch(/website: http:\/\/127\.0\.0\.1:4593\/ answered HTTP 000, expected 200/)
    })

    it('a www redirect to another place is a failure; one to the apex without the slash is fine', async () => {
      await upstreams()
      await stub({ '/': [200, page] }, 4596)
      await www(301, 'https://elsewhere.example/')
      const r = await hc([], SITE)
      expect(r.code).toBe(1)
      expect(r.stderr).toMatch(/website www: .* sends visitors to 'https:\/\/elsewhere\.example\/', expected http:\/\/127\.0\.0\.1:4596\//)
    })

    it('--skip-site skips it, an unknown URL is silently skipped, and the values come from site.env like the unit loads them', async () => {
      await upstreams()
      await stub({ '/': [200, page] }, 4596)
      await www(301, 'http://127.0.0.1:4596')
      const skipped = await hc(['--skip-site'], SITE)
      expect(skipped.code, skipped.out).toBe(0)
      expect(skipped.stdout).toContain('website skipped')
      const etc = tempDir('oasis-hc-site-etc-')
      cleanups.push(etc.cleanup)
      const unknown = await hc([], { SITE_URL: undefined, OASIS_ETC: etc.dir })
      expect(unknown.code, unknown.out).toBe(0)
      expect(unknown.stdout).not.toContain('website')
      writeFileSync(
        path.join(etc.dir, 'site.env'),
        '# the website\nSITE_DOMAIN=example.com\nSITE_URL=http://127.0.0.1:4596\nSITE_MARKER="Oasis Auto Spa"\n',
      )
      // (SITE_WWW_URL would be derived as https://www.example.com from SITE_DOMAIN; the test points it at the stub)
      const fromFile = await hc([], { SITE_URL: undefined, OASIS_ETC: etc.dir, SITE_WWW_URL: 'http://127.0.0.1:4597' })
      expect(fromFile.code, fromFile.out).toBe(0)
      expect(fromFile.stdout).toContain('website http://127.0.0.1:4596/ (www 301)')
      writeFileSync(path.join(etc.dir, 'site.env'), 'SITE_DOMAIN=example.com\nSITE_URL=http://127.0.0.1:4596\nSITE_MARKER="Somebody Else"\n')
      const wrong = await hc([], { SITE_URL: undefined, OASIS_ETC: etc.dir, SITE_WWW_URL: 'http://127.0.0.1:4597' })
      expect(wrong.code).toBe(1)
      expect(wrong.stderr).toMatch(/does not contain 'Somebody Else'/)
    })
  })

  it('fails while the worker is not active, and names it', async () => {
    await stub({ '/healthz': [200, '{}'], '/readyz': [200, ready] }, 4595)
    await stub({ '/login': [200, ''] }, 4594)
    const log = path.join(fakes.dir, 'calls.log')
    const r = await hc([], { WORKER_STATE: 'activating', SYSTEMCTL_LOG: log })
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/worker: oasis-worker\.service is activating, expected active/)
    expect(readFileSync(log, 'utf8')).toContain('is-active oasis-worker.service')
    expect((await hc(['--skip-worker'], { WORKER_STATE: 'failed' })).code).toBe(0)
  })
})

describe('tailscale-serve.sh', () => {
  const NAME = 'oasis-api.tailnet-1234.ts.net'
  function world() {
    const t = tempDir('oasis-ts-')
    cleanups.push(t.cleanup)
    const state = path.join(t.dir, 'serve.json')
    const log = path.join(t.dir, 'calls.log')
    writeFileSync(log, '')
    const shim = path.join(t.dir, 'tailscale')
    writeExecutable(
      shim,
      `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.TS_LOG, 'tailscale ' + args.join(' ') + '\\n')
const read = () => (fs.existsSync(process.env.TS_STATE) ? fs.readFileSync(process.env.TS_STATE, 'utf8') : '{}')
if (args[0] === 'status') {
  if (process.env.TS_LOGGED_OUT) { console.error('Logged out.'); process.exit(1) }
  console.log(args.includes('--json') ? JSON.stringify({ Self: { DNSName: '${NAME}.' } }) : '100.64.0.1 oasis-api')
} else if (args[0] === 'serve' && args[1] === 'status') console.log(read())
else if (args[0] === 'serve' && args[1] === 'reset') fs.writeFileSync(process.env.TS_STATE, '{}')
else if (args[0] === 'serve' && args.includes('off')) fs.writeFileSync(process.env.TS_STATE, '{}')
else if (args[0] === 'serve') {
  const port = (args.find((a) => a.startsWith('--https=')) || '').slice(8)
  const p = (args.find((a) => a.startsWith('--set-path=')) || '').slice(11)
  const target = args[args.length - 1]
  fs.writeFileSync(process.env.TS_STATE, JSON.stringify({ TCP: { [port]: { HTTPS: true } }, Web: { ['${NAME}:' + port]: { Handlers: { [p]: { Proxy: target } } } } }))
} else process.exit(2)
`,
    )
    const env = { TAILSCALE_BIN: shim, TS_STATE: state, TS_LOG: log, OASIS_ROOT_PREFIX: t.dir }
    return {
      env,
      state,
      log,
      run: (...a: string[]) => sh(script('tailscale-serve.sh'), a, env),
      calls: () =>
        readFileSync(log, 'utf8')
          .split('\n')
          .filter((l) => l.startsWith('tailscale serve')),
    }
  }
  const exact = (port = 8443) => ({
    TCP: { [port]: { HTTPS: true } },
    Web: {
      [`${NAME}:${port}`]: {
        Handlers: { '/hooks/smsgate': { Proxy: 'http://127.0.0.1:3002/hooks/smsgate' } },
      },
    },
  })

  it('exposes only the SMS Gate mount, to the hooks listener with the full path, and prints the URL to configure', async () => {
    const w = world()
    const r = await w.run()
    expect(r.code, r.out).toBe(0)
    expect(w.calls().filter((c) => !c.includes('status'))).toEqual([
      'tailscale serve --bg --yes --https=8443 --set-path=/hooks/smsgate http://127.0.0.1:3002/hooks/smsgate',
    ])
    expect(JSON.parse(readFileSync(w.state, 'utf8'))).toEqual(exact())
    expect(r.stdout).toContain(`SMSGATE_WEBHOOK_PUBLIC_URL=https://${NAME}:8443/hooks/smsgate`)
    expect((await w.run('--status')).code).toBe(0)
  })

  it('is idempotent', async () => {
    const w = world()
    await w.run()
    const applied = (): number => w.calls().filter((c) => c.startsWith('tailscale serve --bg')).length
    expect(applied()).toBe(1)
    const again = await w.run()
    expect(again.code, again.out).toBe(0)
    expect(again.out).toMatch(/already serving exactly/)
    expect(applied()).toBe(1)
  })

  it('honours another port and listener port', async () => {
    const w = world()
    const r = await w.run('--https-port', '10000', '--hooks-port', '3012')
    expect(r.code, r.out).toBe(0)
    expect(JSON.parse(readFileSync(w.state, 'utf8'))).toEqual({
      TCP: { 10000: { HTTPS: true } },
      Web: {
        [`${NAME}:10000`]: {
          Handlers: { '/hooks/smsgate': { Proxy: 'http://127.0.0.1:3012/hooks/smsgate' } },
        },
      },
    })
  })

  it('refuses a node that already serves something else, and replaces it only with --reset', async () => {
    const w = world()
    writeFileSync(
      w.state,
      JSON.stringify({
        ...exact(),
        Web: {
          [`${NAME}:8443`]: {
            Handlers: {
              '/hooks/smsgate': { Proxy: 'http://127.0.0.1:3002/hooks/smsgate' },
              '/admin': { Proxy: 'http://127.0.0.1:9000' },
            },
          },
        },
      }),
    )
    const refused = await w.run()
    expect(refused.code).not.toBe(0)
    expect(refused.out).toMatch(/already serves something else/)
    expect(refused.out).toMatch(/has 2 paths/)
    expect(w.calls().some((c) => c.startsWith('tailscale serve --bg'))).toBe(false)
    const reset = await w.run('--reset')
    expect(reset.code, reset.out).toBe(0)
    expect(JSON.parse(readFileSync(w.state, 'utf8'))).toEqual(exact())
  })

  it('treats Funnel (the public internet) as foreign and never enables it', async () => {
    const w = world()
    writeFileSync(w.state, JSON.stringify({ ...exact(), AllowFunnel: { [`${NAME}:8443`]: true } }))
    const status = await w.run('--status')
    expect(status.code).toBe(1)
    expect(status.out).toMatch(/Funnel exposes/)
    expect((await w.run()).code).not.toBe(0)
    expect(w.calls().some((c) => /funnel/.test(c))).toBe(false)
  })

  it('--off removes the mount, --dry-run changes nothing, and a logged-out node gets instructions', async () => {
    const w = world()
    await w.run()
    expect((await w.run('--off')).code).toBe(0)
    expect(JSON.parse(readFileSync(w.state, 'utf8'))).toEqual({})
    const dry = await w.run('--dry-run')
    expect(dry.code, dry.out).toBe(0)
    expect(dry.out).toMatch(/\+ \S*tailscale serve --bg --yes --https=8443/)
    expect(JSON.parse(readFileSync(w.state, 'utf8'))).toEqual({})
    const out = world()
    const r = await sh(script('tailscale-serve.sh'), [], { ...out.env, TS_LOGGED_OUT: '1' })
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/not logged in to Tailscale/)
  })

  it('serve-check classifies the shapes it must tell apart', async () => {
    const check = async (cfg: unknown, extra: string[] = []) =>
      sh(
        'node',
        [
          path.join(DEPLOY, 'lib/serve-check.mjs'),
          '--port',
          '8443',
          '--path',
          '/hooks/smsgate',
          '--target',
          'http://127.0.0.1:3002/hooks/smsgate',
          ...extra,
        ],
        {},
        JSON.stringify(cfg),
      )
    expect((await check({})).stdout.trim()).toBe('empty')
    expect((await check(exact())).stdout.trim()).toBe('exact')
    const wrongTarget = exact()
    wrongTarget.Web[`${NAME}:8443`]!.Handlers['/hooks/smsgate'] = { Proxy: 'http://127.0.0.1:3002/hooks' }
    expect((await check(wrongTarget)).stdout).toMatch(
      /other: .*proxies to http:\/\/127\.0\.0\.1:3002\/hooks, expected/,
    )
    expect(
      (await check({ ...exact(), TCP: { 8443: { HTTPS: true }, 22: { TCPForward: '127.0.0.1:22' } } }))
        .stdout,
    ).toMatch(/TCP port 22 is forwarded/)
    expect((await check({ ...exact(), Services: { 'svc:web': {} } })).stdout).toMatch(/Tailscale Services/)
    expect((await check({ ...exact(), Foreground: { abc: {} } })).stdout).toMatch(/foreground/)
    expect((await check(exact(443))).stdout).toMatch(/not on port 8443|TCP port 443/)
    expect(
      (
        await check({
          TCP: { 8443: { HTTPS: true } },
          Web: { [`${NAME}:8443`]: { Handlers: { '/hooks/smsgate': { Text: 'hi' } } } },
        })
      ).stdout,
    ).toMatch(/other:/)
    expect(
      (
        await sh(
          'node',
          [
            path.join(DEPLOY, 'lib/serve-check.mjs'),
            '--port',
            '8443',
            '--path',
            '/p',
            '--target',
            'http://x',
          ],
          {},
          'not json',
        )
      ).code,
    ).toBe(1)
  })
})
