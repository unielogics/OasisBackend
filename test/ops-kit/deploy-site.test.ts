// The public website on the same host (ADR 0145): what install.sh --site-domain renders (nginx servers, site.env, the placeholder
// release), the rendered site in a real nginx when one is installed, site-deploy.sh end to end against a real bare mirror with
// stand-ins for pnpm, the health check and chown, and the website probes of healthcheck.sh.
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  expandIncludes,
  find,
  locationsOf,
  matchLocation,
  parseEnvFile,
  parseNginx,
  readText,
  script,
  sh,
  tempDir,
  tree,
  writeExecutable,
  type Directive,
  type Loc,
} from './deploy-helpers.js'
import { useStage } from './deploy-stage.js'

const SITE = 'example.com'
const SITE_CERT = '/etc/ssl/site/fullchain.pem'
const SITE_KEY = '/etc/ssl/site/privkey.pem'
const SITE_ARGS = ['--site-domain', SITE, '--site-tls-cert', SITE_CERT, '--site-tls-key', SITE_KEY]
const BASE_ARGS = [
  '--domain',
  'oasis.example.com',
  '--tls',
  'files',
  '--tls-cert',
  '/etc/ssl/oasis/fullchain.pem',
  '--tls-key',
  '/etc/ssl/oasis/privkey.pem',
  '--no-system',
]

const stage = useStage(SITE_ARGS)
const read = (rel: string): string => readText(path.join(stage.root, rel))
const reader = (p: string): string => readText(path.join(stage.root, p))
const conf = (rel: string): Directive[] => parseNginx(read(`etc/nginx/${rel}`))

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

/** Every location of a server, nested ones included. */
const allLocations = (locs: Loc[]): Loc[] =>
  locs.flatMap((l) => [l, ...allLocations(locationsOf({ name: 'location', args: [], block: l.body }))])

describe('install.sh --site-domain: the rendered website', () => {
  const servers = (): Directive[] => find(conf('conf.d/oasis-site.conf'), 'server')
  const byName = (name: string, port: string): Directive =>
    servers().find(
      (s) =>
        find(s.block!, 'server_name')[0]!.args[0] === name &&
        find(s.block!, 'listen').some((l) => l.args[0] === port),
    )!
  const apex = (): Directive => byName(SITE, '443')
  const apexLocs = (): Loc[] => locationsOf({ ...apex(), block: expandIncludes(apex().block!, reader) })
  const text = (): string =>
    [
      'conf.d/oasis-site.conf',
      'conf.d/oasis.conf',
      'conf.d/00-oasis-zones.conf',
      'oasis/site-headers.conf',
      'oasis/tls.conf',
      'oasis/proxy.conf',
    ]
      .map((f) => read(`etc/nginx/${f}`))
      .join('\n')

  it('writes exactly the three site files into conf.d, with no placeholder left and balanced braces', () => {
    expect(readdirSync(path.join(stage.nginx, 'conf.d')).sort()).toEqual([
      '00-oasis-zones.conf',
      'oasis-site.conf',
      'oasis.conf',
    ])
    expect(readdirSync(path.join(stage.nginx, 'oasis')).sort()).toEqual([
      'proxy.conf',
      'security-headers.conf',
      'site-headers.conf',
      'tls.conf',
    ])
    expect(text()).not.toMatch(/@[A-Z][A-Z0-9_]*@/)
    expect(() =>
      ['conf.d/oasis-site.conf', 'oasis/site-headers.conf', 'oasis/tls.conf'].forEach(conf),
    ).not.toThrow()
  })

  it('has three named servers and no default server: 80 for both names, 443 for www, 443 for the apex', () => {
    expect(servers()).toHaveLength(3)
    for (const s of servers()) {
      expect(find(s.block!, 'server_name')).toHaveLength(1)
      expect(find(s.block!, 'listen').some((l) => l.args.includes('default_server'))).toBe(false)
    }
    const plain = servers().find((s) => find(s.block!, 'listen').some((l) => l.args[0] === '80'))!
    expect(find(plain.block!, 'server_name')[0]!.args).toEqual([SITE, `www.${SITE}`])
    expect(find(plain.block!, 'listen').map((l) => l.args)).toEqual([['80'], ['[::]:80']])
    const locs = locationsOf(plain)
    expect(locs.find((l) => l.pattern === '/.well-known/acme-challenge/')?.modifier).toBe('^~')
    expect(find(locs.find((l) => l.pattern === '/')!.body, 'return')[0]!.args).toEqual([
      '301',
      `https://${SITE}$request_uri`,
    ])
    const www = byName(`www.${SITE}`, '443')
    expect(find(www.block!, 'return')[0]!.args).toEqual(['301', `https://${SITE}$request_uri`])
    expect(find(www.block!, 'location')).toEqual([])
    expect(find(www.block!, 'ssl_certificate')[0]!.args).toEqual([SITE_CERT])
    expect(find(www.block!, 'ssl_certificate_key')[0]!.args).toEqual([SITE_KEY])
    expect(find(www.block!, 'http2')[0]!.args).toEqual(['on'])
    expect(find(apex().block!, 'listen').map((l) => l.args)).toEqual([
      ['443', 'ssl'],
      ['[::]:443', 'ssl'],
    ])
    expect(find(apex().block!, 'ssl_certificate')[0]!.args).toEqual([SITE_CERT])
  })

  it('serves the current release of /var/www/site statically, small bodies only, compressed, with a 404 page', () => {
    const s = apex().block!
    const d = (n: string): string[] => find(s, n)[0]?.args ?? []
    expect(d('root')).toEqual(['/var/www/site/current'])
    expect(d('index')).toEqual(['index.html'])
    expect(d('charset')).toEqual(['utf-8'])
    expect(d('client_max_body_size')).toEqual(['16k'])
    expect(d('limit_conn')[0]).toBe('oasis_conn')
    expect(d('gzip')).toEqual(['on'])
    expect(d('gzip_static')).toEqual(['on'])
    expect(d('error_page')).toEqual(['404', '/404.html'])
    expect(find(s, 'proxy_pass')).toEqual([]) // nothing proxied at the server level
  })

  it('routes real paths the way the design says (nginx location rules applied)', () => {
    const locs = apexLocs()
    const at = (uri: string): Loc => matchLocation(locs, uri)!
    const proxied = (uri: string): string | undefined => find(at(uri).body, 'proxy_pass')[0]?.args[0]
    const cache = (uri: string): string | undefined =>
      find(at(uri).body, 'add_header').find((h) => h.args[0] === 'Cache-Control')?.args[1]
    // (the include lines themselves, before expansion)
    const headersIncluded = (uri: string): boolean =>
      find(matchLocation(locationsOf(apex()), uri)!.body, 'include').some(
        (i) => i.args[0] === '/etc/nginx/oasis/site-headers.conf',
      )

    // the three read-only API answers: exact locations, GET only, proxied with the shared proxy settings, the API rate zone, the
    // cache, and no cookie either way
    for (const name of ['hours', 'availability', 'catalog']) {
      const uri = `/api/v1/public/${name}`
      const l = at(uri)
      expect(`${l.modifier} ${l.pattern}`, uri).toBe(`= ${uri}`)
      expect(proxied(uri), uri).toBe('http://oasis_api')
      const raw = locationsOf(apex()).find((x) => x.pattern === uri)!
      expect(find(raw.body, 'include').map((i) => i.args[0]), uri).toEqual(['/etc/nginx/oasis/proxy.conf'])
      expect(find(l.body, 'limit_except')[0]!.args, uri).toEqual(['GET'])
      expect(find(find(l.body, 'limit_except')[0]!.block!, 'deny')[0]!.args, uri).toEqual(['all'])
      expect(find(l.body, 'limit_req')[0]!.args, uri).toEqual(['zone=oasis_api', 'burst=20', 'nodelay'])
      expect(find(l.body, 'proxy_cache')[0]!.args, uri).toEqual(['oasis_public'])
      expect(find(l.body, 'proxy_cache_valid')[0]!.args, uri).toEqual(['200', '60s'])
      // the key is fixed (review 2026-10-10): an extra or junk parameter is the same entry, never a miss the API must compute
      expect(find(l.body, 'proxy_cache_key')[0]!.args, uri).toEqual([
        name === 'availability' ? '$scheme$host$uri?days=$arg_days&service=$arg_service' : '$scheme$host$uri',
      ])
      expect(find(l.body, 'proxy_cache_lock')[0]!.args, uri).toEqual(['on'])
      expect(find(l.body, 'proxy_cache_use_stale')[0]!.args, uri).toEqual(
        expect.arrayContaining(['error', 'timeout', 'updating', 'http_502', 'http_503']),
      )
      expect(find(l.body, 'proxy_set_header').map((h) => h.args.join(' ')), uri).toContain('Cookie ')
      expect(find(l.body, 'proxy_hide_header').map((h) => h.args[0]), uri).toContain('Set-Cookie')
      expect(find(l.body, 'proxy_ignore_headers')[0]!.args, uri).toEqual(['Set-Cookie'])
      expect(find(l.body, 'proxy_set_header').map((h) => h.args.join(' ')), uri).toContain(
        'X-Forwarded-For $remote_addr',
      )
    }

    // the rest of the public prefix (the POSTs: codes, bookings, joins): proxied as it is, never cached, the stricter zone, no cookie
    for (const uri of ['/api/v1/public/otp', '/api/v1/public/otp/verify', '/api/v1/public/bookings', '/api/v1/public/memberships', '/api/v1/public/hours/']) {
      const l = at(uri)
      expect(`${l.modifier} ${l.pattern}`, uri).toBe('^~ /api/v1/public/')
      expect(proxied(uri), uri).toBe('http://oasis_api')
      expect(find(l.body, 'proxy_cache'), uri).toEqual([])
      expect(find(l.body, 'proxy_cache_valid'), uri).toEqual([])
      expect(find(l.body, 'limit_except'), uri).toEqual([])
      expect(find(l.body, 'limit_req')[0]!.args, uri).toEqual(['zone=oasis_public_post', 'burst=10', 'nodelay'])
      expect(find(l.body, 'proxy_set_header').map((h) => h.args.join(' ')), uri).toContain('Cookie ')
      expect(find(l.body, 'proxy_hide_header').map((h) => h.args[0]), uri).toContain('Set-Cookie')
      expect(find(l.body, 'proxy_ignore_headers')[0]!.args, uri).toEqual(['Set-Cookie'])
    }
    const post = locationsOf(apex()).find((x) => x.pattern === '/api/v1/public/' && x.modifier === '^~')!
    expect(find(post.body, 'include').map((i) => i.args[0])).toEqual(['/etc/nginx/oasis/proxy.conf'])

    // everything else of the API, the hooks and the dev store, in any letter case: 404 from nginx, never proxied
    for (const uri of [
      '/api/v1/customers',
      '/api/v1/public',
      '/api/v1/publicity',
      '/api',
      '/API/x',
      '/Api/v1/public/hours',
      '/API/v1/public/bookings',
      '/hooks/x',
      '/hooks/smsgate/x',
      '/dev-storage/files/x',
      '/DEV-STORAGE',
    ]) {
      expect(proxied(uri), uri).toBeUndefined()
      expect(find(at(uri).body, 'return')[0]!.args[0], uri).toBe('404')
      expect(find(at(uri).body, 'default_type')[0]!.args, uri).toEqual(['application/json'])
    }
    // dotfiles (except .well-known) and the release record: 404
    for (const uri of ['/.git/config', '/.env', '/x/.hidden', '/assets/.secret', '/REVISION']) {
      expect(proxied(uri), uri).toBeUndefined()
      expect(find(at(uri).body, 'return')[0]!.args, uri).toEqual(['404'])
    }
    expect(find(at('/.well-known/security.txt').body, 'return')).toEqual([])
    // content-hashed assets a year, other static files a day, pages and the 404 page never cached, each with the headers file
    expect(cache('/assets/app.0123abcd.js')).toBe('public, max-age=31536000, immutable')
    expect(cache('/assets/fonts/x.woff2')).toBe('public, max-age=31536000, immutable')
    expect(cache('/favicon.ico')).toBe('public, max-age=86400')
    expect(cache('/robots.txt')).toBe('public, max-age=86400')
    expect(cache('/sitemap.xml')).toBe('public, max-age=86400')
    for (const uri of ['/', '/about', '/about/', '/404.html', '/services/detailing']) {
      expect(`${at(uri).modifier} ${at(uri).pattern}`.trim(), uri).toBe('/')
      expect(cache(uri), uri).toBe('no-cache')
      expect(headersIncluded(uri), uri).toBe(true)
    }
    expect(find(at('/about').body, 'try_files')[0]!.args).toEqual([
      '$uri',
      '$uri.html',
      '$uri/index.html',
      '=404',
    ])
    for (const uri of ['/assets/app.0123abcd.js', '/favicon.ico'])
      expect(headersIncluded(uri), uri).toBe(true)
    // the dashboard is never reached from the website's host
    expect(
      read('etc/nginx/conf.d/oasis-site.conf')
        .split('\n')
        .filter((l) => /proxy_pass/.test(l) && !/^#/.test(l.trim()))
        .filter((l) => /oasis_web/.test(l)),
    ).toEqual([])
    expect(
      find(
        apexLocs().flatMap((l) => l.body),
        'proxy_pass',
      ).map((p) => p.args[0]),
    ).toEqual(['http://oasis_api', 'http://oasis_api', 'http://oasis_api', 'http://oasis_api'])
  })

  it('shares the TLS file with the dashboard, defines the cache and zones it uses, and every include exists', () => {
    const tlsIncludes = (file: string): string[] =>
      find(parseNginx(read(`etc/nginx/conf.d/${file}`)), 'server')
        .filter((s) =>
          find(s.block!, 'listen').some((l) => l.args[0] === '443' && !l.args.includes('default_server')),
        )
        .map(
          (s) =>
            find(s.block!, 'include')
              .map((i) => i.args[0] ?? '')
              .find((p) => /tls\.conf$/.test(p)) ?? 'none',
        )
    expect(tlsIncludes('oasis-site.conf')).toEqual(['/etc/nginx/oasis/tls.conf', '/etc/nginx/oasis/tls.conf'])
    expect(tlsIncludes('oasis.conf')).toEqual(['/etc/nginx/oasis/tls.conf'])
    const tls = conf('oasis/tls.conf')
    expect(find(tls, 'ssl_session_cache')).toHaveLength(1)
    expect(find(tls, 'ssl_session_cache')[0]!.args).toEqual(['shared:oasis_ssl:10m'])
    expect((text().match(/ssl_session_cache/g) ?? []).length).toBe(1)
    for (const s of [apex(), byName(`www.${SITE}`, '443')]) {
      expect(find(s.block!, 'ssl_protocols')).toEqual([])
      expect(find(expandIncludes(s.block!, reader), 'ssl_protocols')[0]!.args).toEqual(['TLSv1.2', 'TLSv1.3'])
    }
    const zones = conf('conf.d/00-oasis-zones.conf')
    const cachePath = find(zones, 'proxy_cache_path')[0]!
    expect(cachePath.args[0]).toBe('/var/cache/nginx/oasis_public')
    expect(cachePath.args).toContain('keys_zone=oasis_public:1m')
    const zoneNames = find(zones, 'limit_req_zone').map((z) => /zone=(\w+):/.exec(z.args[1]!)![1])
    for (const z of [...read('etc/nginx/conf.d/oasis-site.conf').matchAll(/limit_req zone=(\w+)/g)].map(
      (m) => m[1],
    ))
      expect(zoneNames).toContain(z)
    expect(find(zones, 'limit_conn_zone')[0]!.args[1]).toBe('zone=oasis_conn:10m')
    for (const inc of text().matchAll(/include ([^;]+);/g))
      expect(existsSync(path.join(stage.root, inc[1]!)), inc[1]).toBe(true)
  })

  it('HSTS and nosniff are on every answer of the website exactly once, with always, and the headers file carries the policy', () => {
    const server = expandIncludes(apex().block!, reader)
    expect(find(server, 'add_header').map((h) => h.args.join(' '))).toEqual([
      'Strict-Transport-Security max-age=15552000; includeSubDomains always',
      'X-Content-Type-Options nosniff always',
    ])
    const effective = (l: { body: Directive[] }): string[] => {
      const own = find(l.body, 'add_header')
      return (own.length ? own : find(server, 'add_header')).map((h) => h.args[0]!)
    }
    const every = allLocations(locationsOf({ ...apex(), block: server }))
    expect(every.length).toBeGreaterThan(6)
    for (const l of every) {
      const sent = effective(l)
      for (const h of ['Strict-Transport-Security', 'X-Content-Type-Options']) {
        expect(
          sent.filter((x) => x === h),
          `${l.modifier} ${l.pattern} ${h}`,
        ).toHaveLength(1)
        if (find(l.body, 'proxy_pass').length)
          expect(
            find(l.body, 'proxy_hide_header').map((x) => x.args[0]),
            `${l.pattern} hides ${h}`,
          ).toContain(h)
      }
      expect(
        find(l.body, 'add_header').every((h) => h.args.at(-1) === 'always'),
        l.pattern,
      ).toBe(true)
    }
    // the www server answers its 301 with them too
    expect(find(byName(`www.${SITE}`, '443').block!, 'add_header').map((h) => h.args[0])).toEqual([
      'Strict-Transport-Security',
      'X-Content-Type-Options',
    ])
    const headers = Object.fromEntries(
      find(conf('oasis/site-headers.conf'), 'add_header').map((h) => [h.args[0], h.args[1]]),
    )
    expect(headers['Content-Security-Policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; upgrade-insecure-requests",
    )
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['X-Frame-Options']).toBe('DENY')
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin')
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin')
    expect(headers['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    expect(headers['X-Permitted-Cross-Domain-Policies']).toBe('none')
    expect(headers['Strict-Transport-Security']).toBe('max-age=15552000; includeSubDomains')
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
    check(expandIncludes(conf('conf.d/oasis-site.conf'), reader), 'oasis-site.conf')
    check(expandIncludes(conf('conf.d/oasis.conf'), reader), 'oasis.conf')
  })

  it('writes site.env (root, 0644, no secret) and a placeholder release behind current, so the name never answers 404', () => {
    const env = parseEnvFile(read('etc/oasis/site.env'))
    expect(env).toEqual({
      SITE_DOMAIN: SITE,
      SITE_URL: `https://${SITE}`,
      SITE_ROOT: '/var/www/site',
      SITE_MIRROR: '/opt/oasis/git/site.git',
      SITE_BUILD_DIR: 'dist',
      SITE_MARKER: 'Oasis Auto Spa',
      SITE_KEEP: '4',
    })
    expect((statSync(path.join(stage.etc, 'site.env')).mode & 0o777).toString(8)).toBe('644')
    expect(read('etc/oasis/site.env')).toContain('SITE_MARKER="Oasis Auto Spa"') // quoted: the value has spaces
    const root = path.join(stage.root, 'var/www/site')
    expect(lstatSync(path.join(root, 'current')).isSymbolicLink()).toBe(true)
    expect(realpathSync(path.join(root, 'current'))).toBe(path.join(root, 'releases/bootstrap'))
    // nginx creates the proxy_cache_path directory itself but not its parent, and nginx -t fails without it
    expect(statSync(path.join(stage.root, 'var/cache/nginx')).isDirectory()).toBe(true)
    expect(readdirSync(path.join(root, 'releases/bootstrap')).sort()).toEqual([
      '404.html',
      'REVISION',
      'index.html',
    ])
    const index = readText(path.join(root, 'releases/bootstrap/index.html'))
    expect(index).toContain('Oasis Auto Spa — coming soon')
    expect(index).toMatch(/^<!doctype html>/)
    expect(index).toContain('<meta charset="utf-8">')
    expect(readText(path.join(root, 'releases/bootstrap/REVISION'))).toMatch(/^site=bootstrap\n/)
    for (const f of ['index.html', '404.html', 'REVISION'])
      expect((statSync(path.join(root, 'releases/bootstrap', f)).mode & 0o777).toString(8), f).toBe('644')
  })

  it('--site-csp and --site-marker change only what they name; a re-run leaves a deployed current alone', async () => {
    const t = tempDir('oasis-site-opts-')
    cleanups.push(t.cleanup)
    const env = { OASIS_ROOT_PREFIX: t.dir }
    const args = [
      ...BASE_ARGS,
      ...SITE_ARGS,
      '--site-csp',
      "default-src 'self'; img-src *",
      '--site-marker',
      'Shine & Co',
      '--site-root',
      '/srv/www/shine',
    ]
    const r = await sh(script('install.sh'), args, env)
    expect(r.code, r.out).toBe(0)
    const headers = Object.fromEntries(
      find(parseNginx(readText(path.join(t.dir, 'etc/nginx/oasis/site-headers.conf'))), 'add_header').map(
        (h) => [h.args[0], h.args[1]],
      ),
    )
    expect(headers['Content-Security-Policy']).toBe("default-src 'self'; img-src *")
    expect(headers['X-Frame-Options']).toBe('DENY')
    const env2 = parseEnvFile(readText(path.join(t.dir, 'etc/oasis/site.env')))
    expect(env2.SITE_MARKER).toBe('Shine & Co')
    expect(env2.SITE_ROOT).toBe('/srv/www/shine')
    expect(readText(path.join(t.dir, 'srv/www/shine/releases/bootstrap/index.html'))).toContain(
      'Shine & Co — coming soon',
    )
    expect(
      find(parseNginx(readText(path.join(t.dir, 'etc/nginx/conf.d/oasis-site.conf'))), 'server')
        .map((s) => find(s.block!, 'root')[0]?.args[0])
        .filter(Boolean),
    ).toEqual(['/srv/www/shine/current'])
    // a deployed release behind current survives a re-run (only the options' files are rewritten)
    const rel = path.join(t.dir, 'srv/www/shine/releases/20260101T000000Z-s1234567')
    mkdirSync(rel)
    writeFileSync(path.join(rel, 'index.html'), 'deployed')
    rmSync(path.join(t.dir, 'srv/www/shine/current'))
    symlinkSync(rel, path.join(t.dir, 'srv/www/shine/current'))
    const again = await sh(script('install.sh'), args, env)
    expect(again.code, again.out).toBe(0)
    expect(again.out).toMatch(/current exists \(left alone: 20260101T000000Z-s1234567\)/)
    expect(again.out).not.toMatch(/\bdone\s+wrote\b/)
    expect(realpathSync(path.join(t.dir, 'srv/www/shine/current'))).toBe(rel)
    // ... and a run without --site-domain keeps the website's files and says so
    const without = await sh(script('install.sh'), BASE_ARGS, env)
    expect(without.code, without.out).toBe(0)
    expect(without.out).toMatch(/site\.env exists but this run has no --site-domain/)
    expect(existsSync(path.join(t.dir, 'etc/nginx/conf.d/oasis-site.conf'))).toBe(true)
  })

  it('rejects a www name, the dashboard name, a missing certificate pair, and a dry run creates nothing', async () => {
    const t = tempDir('oasis-site-bad-')
    cleanups.push(t.cleanup)
    const env = { OASIS_ROOT_PREFIX: t.dir }
    expect(
      (await sh(script('install.sh'), [...BASE_ARGS, '--site-domain', 'www.example.com'], env)).out,
    ).toMatch(/--site-domain is the bare domain/)
    expect(
      (await sh(script('install.sh'), [...BASE_ARGS, '--site-domain', 'oasis.example.com'], env)).out,
    ).toMatch(/--site-domain must differ from --domain/)
    expect((await sh(script('install.sh'), [...BASE_ARGS, '--site-domain', 'example.com'], env)).out).toMatch(
      /needs --site-tls-cert and --site-tls-key/,
    )
    expect((await sh(script('install.sh'), [...BASE_ARGS, '--site-tls-cert', '/x.pem'], env)).out).toMatch(
      /need --site-domain/,
    )
    expect((await sh(script('install.sh'), [...BASE_ARGS, '--site-domain', 'bad host!'], env)).out).toMatch(
      /is not a host name/,
    )
    expect(
      (await sh(script('install.sh'), [...BASE_ARGS, ...SITE_ARGS, '--site-marker', 'say "hi"'], env)).out,
    ).toMatch(/--site-marker must be plain text/)
    expect(readdirSync(t.dir)).toEqual([])
    const dry = await sh(
      script('install.sh'),
      ['--domain', 'oasis.example.com', '--site-domain', SITE, '--dry-run'],
      env,
    )
    expect(dry.code, dry.out).toBe(0)
    expect(dry.out).toMatch(/plan\s+would write .*etc\/oasis\/site\.env/)
    expect(dry.out).toMatch(/plan\s+would write .*conf\.d\/oasis-site\.conf/)
    expect(dry.out).toMatch(/plan\s+would write .*releases\/bootstrap\/index\.html/)
    expect(dry.out).toMatch(
      /\+ ln -sfn \S+\/var\/www\/site\/releases\/bootstrap \S+\/var\/www\/site\/current\.new/,
    )
    expect(tree(t.dir).filter((l) => !l.startsWith('etc dir') && !l.startsWith('var dir'))).toEqual([])
    expect(readdirSync(t.dir)).toEqual([])
  })
})

// The website and the dashboard in one real nginx (when the binary is installed): the files as rendered, every path moved into a
// temporary prefix, listening on loopback ports, with a stub API that records what reaches it.
const NGINX = ['/usr/sbin/nginx', '/usr/bin/nginx'].find((p) => existsSync(p))
describe.skipIf(!NGINX)('the website in a real nginx', () => {
  const P80 = 4689
  const P443 = 4690
  const API = 4691
  let dir = ''
  let nginx: ChildProcess | undefined
  let api: Server | undefined
  const hits: string[] = []
  const t = tempDir('oasis-site-nginx-')

  beforeAll(async () => {
    dir = t.dir
    for (const d of [
      'conf.d',
      'oasis',
      'log',
      'tmp',
      'cache',
      'certbot/.well-known/acme-challenge',
      'site/rel/assets',
      'site/rel/about',
    ])
      mkdirSync(path.join(dir, d), { recursive: true })
    const gen = await sh('openssl', [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '2',
      '-subj',
      `/CN=${SITE}`,
      '-addext',
      `subjectAltName=DNS:${SITE},DNS:www.${SITE},DNS:oasis.example.com`,
      '-keyout',
      path.join(dir, 'key.pem'),
      '-out',
      path.join(dir, 'cert.pem'),
    ])
    if (gen.code !== 0) throw new Error(gen.out)
    // the fixture release behind current
    const rel = path.join(dir, 'site/rel')
    writeFileSync(
      path.join(rel, 'index.html'),
      `<!doctype html><html><body><h1>Oasis Auto Spa</h1>${'x'.repeat(1500)}</body></html>`,
    )
    writeFileSync(
      path.join(rel, '404.html'),
      '<!doctype html><html><body><h1>Page not found</h1></body></html>',
    )
    writeFileSync(path.join(rel, 'about/index.html'), 'about page')
    writeFileSync(path.join(rel, 'contact.html'), 'contact page')
    writeFileSync(path.join(rel, 'assets/app.0123abcd.js'), 'console.log(1)')
    writeFileSync(path.join(rel, 'robots.txt'), 'User-agent: *\n')
    writeFileSync(path.join(rel, 'REVISION'), 'site=abc\n')
    writeFileSync(path.join(rel, '.hidden'), 'secret')
    symlinkSync(rel, path.join(dir, 'site/current'))
    writeFileSync(path.join(dir, 'certbot/.well-known/acme-challenge/token1'), 'challenge-body')
    const move = (text: string): string =>
      text
        .replaceAll('/etc/nginx/oasis/', `${dir}/oasis/`)
        .replaceAll('/var/log/nginx/', `${dir}/log/`)
        .replaceAll('/var/cache/nginx/', `${dir}/cache/`)
        .replaceAll('/var/www/certbot', `${dir}/certbot`)
        .replaceAll('/var/www/site', `${dir}/site`)
        .replaceAll(stage.cert, `${dir}/cert.pem`)
        .replaceAll(stage.key, `${dir}/key.pem`)
        .replaceAll(SITE_CERT, `${dir}/cert.pem`)
        .replaceAll(SITE_KEY, `${dir}/key.pem`)
        .replace(/listen \[::\]:(80|443)[^;]*;\n/g, '')
        .replace(/listen 80( default_server)?;/g, `listen 127.0.0.1:${P80}$1;`)
        .replace(/listen 443 ssl( default_server)?;/g, `listen 127.0.0.1:${P443} ssl$1;`)
        .replace('server 127.0.0.1:4000;', `server 127.0.0.1:${API};`)
    for (const f of [
      'conf.d/oasis.conf',
      'conf.d/oasis-site.conf',
      'conf.d/00-oasis-zones.conf',
      'oasis/proxy.conf',
      'oasis/security-headers.conf',
      'oasis/site-headers.conf',
      'oasis/tls.conf',
    ])
      writeFileSync(path.join(dir, f), move(read(`etc/nginx/${f}`)))
    const tmp = path.join(dir, 'tmp')
    writeFileSync(
      path.join(dir, 'nginx.conf'),
      `pid ${dir}/nginx.pid;\nerror_log stderr warn;\nevents { worker_connections 64; }\nhttp {\n` +
        ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi']
          .map((n) => `  ${n}_temp_path ${tmp}/${n};\n`)
          .join('') +
        `  access_log off;\n  include ${dir}/conf.d/*.conf;\n}\n`,
    )
    // the API: answers the hours like the real one (helmet headers, a cache header) and tries to set a cookie, which must not pass
    await new Promise<void>((resolve) => {
      api = createServer((req, res) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk: string) => (body += chunk))
        req.on('end', () => {
          const idem = req.headers['idempotency-key']
          hits.push(
            `${req.method} ${req.url} cookie=${req.headers.cookie ?? 'none'}` +
              (req.method === 'POST' ? ` idem=${typeof idem === 'string' ? idem : 'none'} body=${body}` : ''),
          )
        })
        req.on('end', () =>
          res
            .writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'public, max-age=60',
              'set-cookie': 'oasis_sid=should-not-pass; Path=/',
              'strict-transport-security': 'max-age=15552000; includeSubDomains',
              'x-content-type-options': 'nosniff',
            })
            .end('{"tz":"America/New_York","today":{"state":"open"}}'),
        )
      })
      api.listen(API, '127.0.0.1', resolve)
    })
  }, 60_000)

  afterAll(async () => {
    if (nginx?.pid) nginx.kill('SIGTERM')
    await new Promise<void>((r) => (api ? api.close(() => r()) : r()))
    t.cleanup()
  })

  const nginxArgs = () => ['-p', dir, '-e', 'stderr', '-c', path.join(dir, 'nginx.conf')]
  const resolve = () =>
    [SITE, `www.${SITE}`, 'other.example.com'].flatMap((h) => ['--resolve', `${h}:${P443}:127.0.0.1`])
  const get = async (url: string, extra: string[] = []) => {
    const r = await sh('curl', ['-sk', '-D', '-', '--max-time', '5', ...resolve(), ...extra, url])
    const [head, ...rest] = r.stdout.split('\r\n\r\n')
    const lines = (head ?? '').split('\r\n')
    const status = Number(/^HTTP\/\S+ (\d+)/.exec(lines[0] ?? '')?.[1] ?? 0)
    const header = (name: string) =>
      lines
        .filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
        .map((l) => l.slice(name.length + 1).trim())
    return { code: r.code, status, header, body: rest.join('\r\n\r\n') }
  }
  const once = (res: Awaited<ReturnType<typeof get>>, what: string) => {
    expect(res.header('strict-transport-security'), what).toEqual(['max-age=15552000; includeSubDomains'])
    expect(res.header('x-content-type-options'), what).toEqual(['nosniff'])
  }

  it('nginx -t accepts the dashboard and the website together without a warning', async () => {
    const r = await sh(NGINX!, ['-t', ...nginxArgs()])
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/syntax is ok/)
    expect(r.out.split('\n').filter((l) => /\[(warn|emerg|alert|crit|error)\]/.test(l))).toEqual([])
  })

  it('serves the release with the headers, clean URLs, the 404 page, cached assets, and refuses strangers', async () => {
    nginx = spawn(NGINX!, [...nginxArgs(), '-g', 'daemon off; master_process off;'], { stdio: 'ignore' })
    for (let i = 0; i < 50; i++) {
      if ((await sh('curl', ['-s', '-o', '/dev/null', `http://127.0.0.1:${P80}/`])).code === 52) break
      await new Promise((r) => setTimeout(r, 100))
    }
    const site = `https://${SITE}:${P443}`

    const home = await get(`${site}/`)
    expect(home.status).toBe(200)
    expect(home.body).toContain('<h1>Oasis Auto Spa</h1>')
    once(home, 'home')
    expect(home.header('content-type')).toEqual(['text/html; charset=utf-8'])
    expect(home.header('cache-control')).toEqual(['no-cache'])
    expect(home.header('content-security-policy')[0]).toMatch(/^default-src 'none'; script-src 'self';/)
    expect(home.header('x-frame-options')).toEqual(['DENY'])
    expect(home.header('referrer-policy')).toEqual(['strict-origin-when-cross-origin'])
    expect(home.header('cross-origin-resource-policy')).toEqual(['same-origin'])
    expect(home.header('server')).toEqual(['nginx']) // server_tokens off: no version
    expect((await get(`${site}/about`)).body).toBe('about page') // a directory with an index: no redirect
    expect((await get(`${site}/about/`)).body).toBe('about page')
    expect((await get(`${site}/contact`)).body).toBe('contact page') // contact.html
    const missing = await get(`${site}/nope`)
    expect(missing.status).toBe(404)
    expect(missing.body).toContain('Page not found') // the site's own page
    expect(missing.header('cache-control')).toEqual(['no-cache'])
    once(missing, '404 page')
    expect((await get(`${site}/404.html`)).status).toBe(200)

    const asset = await get(`${site}/assets/app.0123abcd.js`)
    expect(asset.status).toBe(200)
    expect(asset.header('cache-control')).toEqual(['public, max-age=31536000, immutable'])
    once(asset, 'asset')
    expect((await get(`${site}/robots.txt`)).header('cache-control')).toEqual(['public, max-age=86400'])
    for (const uri of ['/REVISION', '/.hidden', '/.git/config', '/assets/.secret']) {
      const r = await get(`${site}${uri}`)
      expect(r.status, uri).toBe(404)
      expect(r.body, uri).not.toContain('secret')
      once(r, uri)
    }

    // www and plain http go to the apex, with the path and query kept; the ACME challenge is served on port 80 for the site host
    const www = await get(`https://www.${SITE}:${P443}/x?y=1`)
    expect(www.status).toBe(301)
    expect(www.header('location')).toEqual([`https://${SITE}/x?y=1`])
    once(www, 'www 301')
    for (const host of [SITE, `www.${SITE}`]) {
      const http = await get(`http://127.0.0.1:${P80}/p?q=1`, ['-H', `Host: ${host}`])
      expect(http.status, host).toBe(301)
      expect(http.header('location'), host).toEqual([`https://${SITE}/p?q=1`])
      const acme = await get(`http://127.0.0.1:${P80}/.well-known/acme-challenge/token1`, [
        '-H',
        `Host: ${host}`,
      ])
      expect(acme.status, host).toBe(200)
      expect(acme.body, host).toBe('challenge-body')
    }

    // strangers: no handshake on 443 for another name or a bare address, no answer on 80
    expect((await get(`https://127.0.0.1:${P443}/`)).code).toBe(35)
    expect((await get(`https://other.example.com:${P443}/`)).code).toBe(35)
    expect((await get(`http://127.0.0.1:${P80}/`, ['-H', 'Host: other.example.com'])).code).toBe(52)
  }, 60_000)

  it('proxies the public reads once each with the path unchanged and no cookie either way, caches them, passes the writes through uncached, and keeps the rest of the API away', async () => {
    const site = `https://${SITE}:${P443}`
    hits.length = 0
    const first = await get(`${site}/api/v1/public/hours`, ['-H', 'Cookie: oasis_sid=visitor-cookie'])
    expect(first.status).toBe(200)
    expect(first.body).toContain('"tz":"America/New_York"')
    expect(first.header('set-cookie')).toEqual([])
    expect(first.header('x-cache-status')).toEqual(['MISS'])
    expect(first.header('cache-control')).toEqual(['public, max-age=60'])
    expect(first.header('content-type')).toEqual(['application/json; charset=utf-8'])
    once(first, 'hours')
    expect(hits).toEqual(['GET /api/v1/public/hours cookie=none'])
    const second = await get(`${site}/api/v1/public/hours`)
    expect(second.status).toBe(200)
    expect(second.header('x-cache-status')).toEqual(['HIT'])
    expect(second.header('set-cookie')).toEqual([])
    expect(hits).toHaveLength(1)
    // a query string is not part of the hours' cache key: a cache-busting parameter is served from the cache (review 2026-10-10)
    const query = await get(`${site}/api/v1/public/hours?x=1`)
    expect(query.status).toBe(200)
    expect(query.header('x-cache-status')).toEqual(['HIT'])
    expect(hits).toEqual(['GET /api/v1/public/hours cookie=none'])

    // the board and the catalog: the same treatment, cached per URL
    hits.length = 0
    for (const uri of ['/api/v1/public/availability?days=5', '/api/v1/public/catalog']) {
      const miss = await get(`${site}${uri}`, ['-H', 'Cookie: oasis_sid=visitor-cookie'])
      expect(miss.status, uri).toBe(200)
      expect(miss.header('x-cache-status'), uri).toEqual(['MISS'])
      expect(miss.header('set-cookie'), uri).toEqual([])
      once(miss, uri)
      const hit = await get(`${site}${uri}`)
      expect(hit.header('x-cache-status'), uri).toEqual(['HIT'])
    }
    expect(hits).toEqual(['GET /api/v1/public/availability?days=5 cookie=none', 'GET /api/v1/public/catalog cookie=none'])
    // the board's key is its two parameters: add-ons, junk and order do not make a new entry; another day count does
    for (const uri of ['/api/v1/public/availability?days=5&addons=wax%2Cclay', '/api/v1/public/availability?days=5&cb=1', '/api/v1/public/catalog?v=2'])
      expect((await get(`${site}${uri}`)).header('x-cache-status'), uri).toEqual(['HIT'])
    expect((await get(`${site}/api/v1/public/availability?days=6`)).header('x-cache-status')).toEqual(['MISS'])
    expect(hits).toHaveLength(3)
    // the cached routes take no POST
    const postHours = await get(`${site}/api/v1/public/hours`, ['-X', 'POST', '-d', '{}'])
    expect(postHours.status).toBe(403)
    once(postHours, 'POST hours')
    expect(hits).toHaveLength(3)

    // the writes: passed through as they are (method, path, body, Idempotency-Key), never cached, no cookie either way
    hits.length = 0
    const args = ['-X', 'POST', '-H', 'Content-Type: application/json', '-H', 'Idempotency-Key: k-0123456789', '-H', 'Cookie: oasis_sid=visitor-cookie', '-d', '{"phone":"+12015550101"}']
    const booking = await get(`${site}/api/v1/public/bookings`, args)
    expect(booking.status).toBe(200)
    expect(booking.header('x-cache-status')).toEqual([])
    expect(booking.header('set-cookie')).toEqual([])
    once(booking, 'POST bookings')
    const again = await get(`${site}/api/v1/public/bookings`, args)
    expect(again.status).toBe(200)
    expect(hits).toEqual(['POST /api/v1/public/bookings cookie=none idem=k-0123456789 body={"phone":"+12015550101"}', 'POST /api/v1/public/bookings cookie=none idem=k-0123456789 body={"phone":"+12015550101"}'])
    for (const uri of ['/api/v1/public/otp', '/api/v1/public/otp/verify', '/api/v1/public/memberships']) {
      hits.length = 0
      expect((await get(`${site}${uri}`, args)).status, uri).toBe(200)
      expect(hits[0], uri).toMatch(new RegExp(`^POST ${uri.replace(/\//g, '\\/')} cookie=none`))
    }

    hits.length = 0
    for (const uri of [
      '/api/v1/customers',
      '/api/v1/public',
      '/API/v1/public/hours',
      '/API/v1/public/bookings',
      '/hooks/smsgate/x',
      '/dev-storage/files/x',
      '/api',
    ]) {
      const r = await get(`${site}${uri}`)
      expect(r.status, uri).toBe(404)
      expect(r.body, uri).toBe('{"ok":false,"status":"not_found"}')
      expect(r.header('content-type'), uri).toEqual(['application/json'])
      once(r, uri)
    }
    expect(hits).toEqual([])
  }, 60_000)
})

// site-deploy.sh end to end: a real bare mirror, git archive, the release directories and links, the lock and the pruning are the
// real code; pnpm, the health check and chown are recording stand-ins.
interface SiteWorld {
  root: string
  siteRoot: string
  state: string
  env: Record<string, string>
  mirror: string
  work: string
  commit(files: Record<string, string>): Promise<string>
  deploy(...args: string[]): ReturnType<typeof sh>
  log(): string[]
  clearLog(): void
  releases(): string[]
  current(): string
  previous(): string | undefined
  flag(name: string, on?: boolean): void
}

const git = (cwd: string, ...args: string[]) =>
  sh(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args],
    {},
    undefined,
    cwd,
  )

async function makeSiteWorld(): Promise<SiteWorld> {
  const t = tempDir('oasis-site-flow-')
  cleanups.push(t.cleanup)
  const root = t.dir
  const inst = await sh(script('install.sh'), [...BASE_ARGS, ...SITE_ARGS], { OASIS_ROOT_PREFIX: root })
  if (inst.code !== 0) throw new Error(inst.out)
  const siteRoot = path.join(root, 'var/www/site')
  const state = path.join(root, 'shim-state')
  mkdirSync(state)
  const bin = path.join(root, 'shims')
  const logFile = path.join(state, 'calls.log')
  writeFileSync(logFile, '')
  writeFileSync(path.join(state, 'hours.json'), '{"tz":"America/New_York","today":{"state":"open"}}')

  // pnpm: install does nothing; build writes dist/ the way the site's build does, and misbehaves on request
  writeExecutable(
    path.join(bin, 'pnpm'),
    `#!/usr/bin/env bash
echo "pnpm $* cwd=$(basename "$PWD") uid=$(id -u) HOME=$HOME CI=$CI SITE_URL=\${SITE_URL-unset} SITE_HOURS_JSON=\${SITE_HOURS_JSON-unset} NODE_OPTIONS=\${NODE_OPTIONS-unset}" >> "$SHIM_LOG"
case "$*" in
  "install --frozen-lockfile") ;;
  "build")
    [ -e "$SHIM_STATE/fail-build" ] && { echo "build broke" >&2; exit 1; }
    mkdir -p dist/assets
    marker="Oasis Auto Spa"; [ -e "$SHIM_STATE/no-marker" ] && marker="Some Other Shop"
    body="<p>$marker</p>$(head -c 1500 /dev/zero | tr '\\0' x)"; [ -e "$SHIM_STATE/small-index" ] && body="<p>$marker</p>"
    [ -e "$SHIM_STATE/localhost" ] && body="$body<a href=\\"http://localhost:4321/x\\">dev</a>"
    [ -e "$SHIM_STATE/inline-script" ] && body="$body<script>alert(1)</script>"
    [ -e "$SHIM_STATE/jsonld" ] && body="$body<script type=\\"application/ld+json\\">{}</script>"
    [ -e "$SHIM_STATE/bad" ] && body="$body BAD"
    printf '<!doctype html><html><head><script src="/assets/app.js"></script></head><body>%s<p>%s</p></body></html>' "$body" "$(cat "\${SITE_HOURS_JSON:-/dev/null}" 2>/dev/null)" > dist/index.html
    [ -e "$SHIM_STATE/no-404" ] || echo '<p>not found</p>' > dist/404.html
    echo 'console.log(1)' > dist/assets/app.js
    [ -e "$SHIM_STATE/dev-port" ] && echo 'fetch("http://127.0.0.1:4000/api/v1/public/hours")' > dist/assets/app.js
    [ -e "$SHIM_STATE/symlink" ] && ln -s /etc/passwd dist/assets/passwd
    [ -e "$SHIM_STATE/big-file" ] && truncate -s 26M dist/assets/huge.bin
    [ -e "$SHIM_STATE/tiny-total" ] || head -c 65536 /dev/zero > dist/assets/vendor.js
    echo "built $(git -C . rev-parse --short HEAD 2>/dev/null || cat VERSION)" > dist/assets/build.txt
    ;;
  *) echo "unexpected pnpm $*" >&2; exit 1 ;;
esac
`,
  )
  writeExecutable(
    path.join(bin, 'site-health.sh'),
    `#!/usr/bin/env bash
cur=$(readlink -f "$SITE_ROOT/current" 2>/dev/null)
echo "site-health domain=$1 marker=$2 current=$(basename "\${cur:-none}")" >> "$SHIM_LOG"
[ -e "$SHIM_STATE/unhealthy" ] && { echo "UNHEALTHY (stand-in, flag)" >&2; exit 1; }
grep -q BAD "$cur/index.html" 2>/dev/null && { echo "UNHEALTHY (stand-in, BAD page)" >&2; exit 1; }
exit 0
`,
  )
  writeExecutable(path.join(bin, 'chown'), `#!/usr/bin/env bash\necho "chown $*" >> "$SHIM_LOG"\n`)

  // the mirror: a bare repository only "root" (this uid) can write, fed from a working copy
  const work = path.join(root, 'work')
  const mirror = path.join(root, 'opt/oasis/git/site.git')
  mkdirSync(work, { recursive: true })
  mkdirSync(path.dirname(mirror), { recursive: true })
  await git(work, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(work, 'package.json'), '{"name":"fake-site"}\n')
  writeFileSync(path.join(work, 'VERSION'), 'v1\n')
  await git(work, 'add', '-A')
  await git(work, 'commit', '-q', '-m', 'v1')
  const init = await git(root, 'init', '-q', '--bare', mirror)
  if (init.code !== 0) throw new Error(init.out)
  const publish = async () => {
    const p = await git(work, 'push', '-q', mirror, '+main:main')
    if (p.code !== 0) throw new Error(p.out)
    await sh('chmod', ['-R', 'go-w', path.join(root, 'opt/oasis/git')])
  }
  await publish()

  const env = {
    OASIS_ROOT_PREFIX: root,
    OASIS_ALLOW_NONROOT: '1',
    OASIS_RUN_AS: '',
    OASIS_CHOWN: path.join(bin, 'chown'),
    OASIS_KIT_TRUST_UID: String(process.getuid!()),
    SITE_HEALTH_CMD: path.join(bin, 'site-health.sh'),
    SITE_HOURS_URL: `file://${path.join(state, 'hours.json')}`,
    SITE_ROOT: siteRoot,
    PATH: `${bin}:${process.env.PATH}`,
    SHIM_LOG: logFile,
    SHIM_STATE: state,
  }
  const releasesDir = path.join(siteRoot, 'releases')
  return {
    root,
    siteRoot,
    state,
    env,
    mirror,
    work,
    async commit(files) {
      for (const [f, body] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(work, f)), { recursive: true })
        writeFileSync(path.join(work, f), body)
      }
      await git(work, 'add', '-A')
      await git(work, 'commit', '-q', '-m', `change ${Object.keys(files).join(',')}`)
      await publish()
      return (await git(work, 'rev-parse', 'HEAD')).stdout.trim()
    },
    deploy: (...args) => sh(script('site-deploy.sh'), args, env),
    log: () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean),
    clearLog: () => writeFileSync(logFile, ''),
    releases: () => readdirSync(releasesDir).sort(),
    current: () => path.basename(realpathSync(path.join(siteRoot, 'current'))),
    previous: () =>
      existsSync(path.join(siteRoot, 'previous'))
        ? path.basename(realpathSync(path.join(siteRoot, 'previous')))
        : undefined,
    flag(name, on = true) {
      const f = path.join(state, name)
      if (on) writeFileSync(f, '')
      else rmSync(f, { force: true })
    },
  }
}

const revision = (w: SiteWorld, rel = w.current()): Record<string, string> =>
  Object.fromEntries(
    readFileSync(path.join(w.siteRoot, 'releases', rel, 'REVISION'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => l.split('=') as [string, string]),
  )

describe('site-deploy.sh', () => {
  it('first deploy: exports the commit, fetches the hours, builds as the service user, verifies, switches, and records it', async () => {
    const w = await makeSiteWorld()
    expect(w.current()).toBe('bootstrap')
    const sha = (await git(w.work, 'rev-parse', 'HEAD')).stdout.trim()
    const r = await w.deploy()
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/release \S+ is live at https:\/\/example\.com\//)
    expect(r.out).toMatch(/hours snapshot from file:/)
    expect(r.out).toMatch(/verified dist\//)

    const id = w.current()
    expect(id).toMatch(new RegExp(`^\\d{8}T\\d{6}Z-s${sha.slice(0, 7)}$`))
    expect(w.previous()).toBe('bootstrap')
    expect(w.releases()).toEqual([id, 'bootstrap'].sort()) // the sources and node_modules are gone, nothing .partial is left
    const rel = path.join(w.siteRoot, 'releases', id)
    expect(readdirSync(rel).sort()).toEqual(['404.html', 'REVISION', 'assets', 'index.html'])
    expect(existsSync(path.join(rel, 'package.json'))).toBe(false)
    expect(revision(w)).toMatchObject({ site: sha, hours: 'fetched' })
    expect(revision(w).built).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(readFileSync(path.join(rel, 'index.html'), 'utf8')).toContain('"tz":"America/New_York"') // the snapshot reached the build
    // the build ran in the staging directory as the service user, with the documented environment; the release is root's, read-only
    const build = w.log().find((l) => l.startsWith('pnpm build'))!
    expect(build).toMatch(
      /cwd=src uid=\d+ HOME=\S+\/var\/lib\/oasis CI=1 SITE_URL=https:\/\/example\.com SITE_HOURS_JSON=\S+\.partial\/hours\.json NODE_OPTIONS=--max-old-space-size=2048/,
    )
    expect(w.log().filter((l) => l.startsWith('pnpm'))).toEqual([
      expect.stringMatching(/^pnpm install --frozen-lockfile cwd=src/),
      build,
    ])
    expect(w.log()).toContain(`chown -h -R root:root ${rel}`)
    for (const f of tree(rel)) expect(parseInt(f.split(' ').at(-1)!, 8) & 0o022, f).toBe(0)
    expect(w.log().filter((l) => l.startsWith('site-health'))).toEqual([
      `site-health domain=example.com marker=Oasis Auto Spa current=${id}`,
    ])
    const list = readFileSync(path.join(w.root, 'var/log/oasis/site-deploys.list'), 'utf8')
    expect(list).toMatch(new RegExp(`^\\S+ ${id} ok\\n$`))
    expect(existsSync(path.join(w.root, 'var/log/oasis/site-deploy.log'))).toBe(true)
  }, 60_000)

  it('nothing to do for the same commit; --force rebuilds; a new commit deploys and previous follows', async () => {
    const w = await makeSiteWorld()
    expect((await w.deploy()).code).toBe(0)
    const first = w.current()
    const same = await w.deploy()
    expect(same.code, same.out).toBe(0)
    expect(same.out).toMatch(/nothing to deploy: \S+ already serves commit/)
    expect(w.current()).toBe(first)
    const forced = await w.deploy('--force')
    expect(forced.code, forced.out).toBe(0)
    expect(w.current()).not.toBe(first)
    expect(w.previous()).toBe(first)
    const sha2 = await w.commit({ VERSION: 'v2\n' })
    const next = await w.deploy()
    expect(next.code, next.out).toBe(0)
    expect(w.current()).toMatch(new RegExp(`-s${sha2.slice(0, 7)}$`))
    expect(revision(w).site).toBe(sha2)
    expect(readFileSync(path.join(w.siteRoot, 'current/assets/build.txt'), 'utf8')).toContain('built v2')
    // --ref: a branch or commit of the mirror; an unknown one stops before anything is written
    const bad = await w.deploy('--ref', 'no-such-branch')
    expect(bad.code).toBe(1)
    expect(bad.out).toMatch(/ref no-such-branch does not exist/)
    expect(w.releases().filter((r) => r.endsWith('.partial') || r.endsWith('.failed'))).toEqual([])
  }, 90_000)

  it('each verification failure keeps the current release and leaves the build as .failed', async () => {
    const w = await makeSiteWorld()
    expect((await w.deploy()).code).toBe(0)
    const good = w.current()
    const cases: [string, RegExp][] = [
      ['fail-build', /the website build failed; nothing was changed/],
      ['no-404', /404\.html is missing/],
      ['small-index', /index\.html is smaller than 1 KB/],
      ['no-marker', /index\.html does not contain the marker text 'Oasis Auto Spa'/],
      ['localhost', /development address or port .* in: \S*index\.html/],
      ['dev-port', /development address or port .* in: \S*app\.js/],
      ['inline-script', /inline <script> in the HTML/],
      ['symlink', /symbolic link in the output: \S+passwd/],
      ['big-file', /file over 25 MB: \S+huge\.bin/],
      ['tiny-total', /total size \d+ bytes is below 50 KB/],
    ]
    for (const [flag, message] of cases) {
      w.flag(flag)
      const r = await w.deploy('--force')
      w.flag(flag, false)
      expect(r.code, flag).toBe(1)
      expect(r.out, flag).toMatch(message)
      expect(r.out, flag).toMatch(/kept in \S+\.failed/)
      expect(w.current(), flag).toBe(good)
      expect(
        w.log().filter((l) => l.startsWith('site-health')),
        flag,
      ).toHaveLength(1) // never health-checked
    }
    expect(w.releases().filter((r) => r.endsWith('.failed'))).toHaveLength(cases.length)
    expect(w.releases().filter((r) => r.endsWith('.partial'))).toEqual([])
    // a JSON-LD data block is not an inline script; a deploy that goes live keeps at most two failed builds
    w.flag('jsonld')
    const ok = await w.deploy('--force')
    expect(ok.code, ok.out).toBe(0)
    expect(readFileSync(path.join(w.siteRoot, 'current/index.html'), 'utf8')).toContain('application/ld+json')
    expect(w.releases().filter((r) => r.endsWith('.failed'))).toHaveLength(2)
  }, 120_000)

  it('an unhealthy release is switched back at once and kept as .failed; a failed health check never leaves current dangling', async () => {
    const w = await makeSiteWorld()
    expect((await w.deploy()).code).toBe(0)
    const good = w.current()
    w.clearLog()
    w.flag('bad') // the page says BAD: the health stand-in refuses it
    const r = await w.deploy('--force')
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/the new release is not healthy: switching back/)
    expect(r.out).toMatch(new RegExp(`back on ${good}, which is healthy`))
    expect(w.current()).toBe(good)
    const health = w.log().filter((l) => l.startsWith('site-health'))
    expect(health).toHaveLength(2)
    expect(health[0]).not.toMatch(new RegExp(`current=${good}$`))
    expect(health[1]).toMatch(new RegExp(`current=${good}$`))
    const failed = w.releases().filter((x) => x.endsWith('.failed'))
    expect(failed).toHaveLength(1)
    expect(readFileSync(path.join(w.siteRoot, 'releases', failed[0]!, 'index.html'), 'utf8')).toContain('BAD')
    expect(readFileSync(path.join(w.root, 'var/log/oasis/site-deploys.list'), 'utf8')).toMatch(
      / rolled-back\n$/,
    )
    w.flag('bad', false)
    // the previous release is unhealthy too: said, current stays on it (something answers), exit 1
    w.flag('unhealthy')
    const both = await w.deploy('--force')
    expect(both.code).toBe(1)
    expect(both.out).toMatch(/the previous release is ALSO unhealthy/)
    expect(w.current()).toBe(good)
  }, 90_000)

  it('refuses a mirror that others can write, or that is missing; and runs only one at a time', async () => {
    const w = await makeSiteWorld()
    await sh('chmod', ['g+w', path.join(w.mirror, 'HEAD')])
    const writable = await w.deploy()
    expect(writable.code).toBe(1)
    expect(writable.out).toMatch(/can be changed by users other than root: refusing to build from it/)
    await sh('chmod', ['g-w', path.join(w.mirror, 'HEAD')])
    await sh('chmod', ['o+w', path.dirname(w.mirror)])
    expect((await w.deploy()).out).toMatch(/can be changed by users other than root/)
    await sh('chmod', ['o-w', path.dirname(w.mirror)])
    const missing = await sh(script('site-deploy.sh'), [], {
      ...w.env,
      SITE_MIRROR: path.join(w.root, 'nowhere.git'),
    })
    expect(missing.code).toBe(1)
    expect(missing.out).toMatch(/no mirror at \S+nowhere\.git: publish the site repository there first/)
    expect(w.current()).toBe('bootstrap')
    expect(w.log().filter((l) => l.startsWith('pnpm'))).toEqual([])
    // the lock
    const holder = spawn('flock', [path.join(w.siteRoot, '.deploy.lock'), 'sleep', '20'], { stdio: 'ignore' })
    cleanups.push(() => void holder.kill('SIGTERM'))
    await new Promise((r) => setTimeout(r, 300))
    const locked = await w.deploy()
    expect(locked.code).toBe(1)
    expect(locked.out).toMatch(/another site deploy or rollback is running/)
    holder.kill('SIGTERM')
    expect(w.releases()).toEqual(['bootstrap'])
  }, 60_000)

  it('keeps N releases plus current and previous, lists them, and rolls back and forward with the health check', async () => {
    const w = await makeSiteWorld()
    const ids: string[] = []
    for (const v of ['v2', 'v3', 'v4', 'v5']) {
      await w.commit({ VERSION: `${v}\n` })
      const r = await w.deploy('--keep', '1')
      expect(r.code, r.out).toBe(0)
      ids.push(w.current())
    }
    // keep 1 = the newest; current and previous are always kept; the placeholder went with the others
    expect(w.releases()).toEqual([ids[2], ids[3]].sort())
    expect(w.previous()).toBe(ids[2])
    const list = await w.deploy('--list')
    expect(list.code).toBe(0)
    expect(list.stdout.trim().split('\n')).toEqual([
      `${ids[2]} ${revision(w, ids[2]).site!.slice(0, 12)} <- previous`,
      `${ids[3]} ${revision(w, ids[3]).site!.slice(0, 12)} <- current`,
    ])

    w.clearLog()
    const back = await w.deploy('--rollback')
    expect(back.code, back.out).toBe(0)
    expect(back.out).toMatch(new RegExp(`the website now serves ${ids[2]}`))
    expect(w.current()).toBe(ids[2])
    expect(w.previous()).toBe(ids[3])
    expect(w.log().filter((l) => l.startsWith('site-health'))).toEqual([
      `site-health domain=example.com marker=Oasis Auto Spa current=${ids[2]}`,
    ])
    const forward = await w.deploy('--rollback')
    expect(forward.code, forward.out).toBe(0)
    expect(w.current()).toBe(ids[3])
    const to = await w.deploy('--rollback', '--to', ids[2]!)
    expect(to.code, to.out).toBe(0)
    expect(w.current()).toBe(ids[2])
    expect((await w.deploy('--rollback', '--to', ids[2]!)).out).toMatch(/is already the current release/)
    expect((await w.deploy('--rollback', '--to', 'nope')).out).toMatch(/no release to go back to/)
    expect(
      readFileSync(path.join(w.root, 'var/log/oasis/site-deploys.list'), 'utf8')
        .trim()
        .split('\n')
        .slice(-3)
        .map((l) => l.split(' ')[2]),
    ).toEqual(['rollback-ok', 'rollback-ok', 'rollback-ok'])
    // an unhealthy rollback target is reported with exit 3 (the switch stays, like rollback.sh)
    w.flag('unhealthy')
    const sick = await w.deploy('--rollback')
    expect(sick.code).toBe(3)
    expect(w.current()).toBe(ids[3])
    // nothing was rebuilt by any of it
    expect(w.log().filter((l) => l.startsWith('pnpm'))).toEqual([])
  }, 120_000)

  it('--skip-hours and an API that does not answer build without the snapshot; --dry-run changes nothing', async () => {
    const w = await makeSiteWorld()
    const skipped = await w.deploy('--skip-hours')
    expect(skipped.code, skipped.out).toBe(0)
    expect(skipped.out).toMatch(/hours snapshot skipped/)
    expect(revision(w).hours).toBe('skipped')
    expect(w.log().find((l) => l.startsWith('pnpm build'))).toContain('SITE_HOURS_JSON=unset')
    const down = await sh(script('site-deploy.sh'), ['--force'], {
      ...w.env,
      SITE_HOURS_URL: `file://${w.state}/no-such.json`,
    })
    expect(down.code, down.out).toBe(0)
    expect(down.out).toMatch(/warn no hours snapshot: file:\/\/\S+no-such\.json did not answer/)
    expect(revision(w).hours).toBe('unavailable')
    const before = tree(w.siteRoot)
    w.clearLog()
    await w.commit({ VERSION: 'v9\n' })
    const dry = await w.deploy('--dry-run')
    expect(dry.code, dry.out).toBe(0)
    expect(dry.out).toMatch(
      /would export \w{12} into \S+\.partial\/src, fetch the hours snapshot, build as oasis/,
    )
    expect(tree(w.siteRoot)).toEqual(before)
    expect(w.log()).toEqual([])
    const dryBack = await w.deploy('--rollback', '--dry-run')
    expect(dryBack.code, dryBack.out).toBe(0)
    expect(dryBack.out).toMatch(/\+ ln -sfn/)
    expect(tree(w.siteRoot)).toEqual(before)
  }, 90_000)

  it('the build and the export run through the service-user wrapper, never as the caller', async () => {
    const w = await makeSiteWorld()
    const runas = path.join(w.root, 'shims/runas.sh')
    writeExecutable(runas, `#!/usr/bin/env bash\necho "runas $1" >> "$SHIM_LOG"\nexec "$@"\n`)
    const r = await sh(script('site-deploy.sh'), [], { ...w.env, OASIS_RUN_AS: runas })
    expect(r.code, r.out).toBe(0)
    const wrapped = w.log().filter((l) => l.startsWith('runas '))
    expect(wrapped).toEqual(['runas tar', 'runas env'])
    expect(w.log().filter((l) => l.startsWith('pnpm'))).toHaveLength(2)
    // and it says when it is not the root-owned kit that runs
    expect(r.out).toMatch(
      /not the root-owned kit in \S+: run \/usr\/local\/lib\/oasis\/deploy\/scripts\/site-deploy\.sh/,
    )
    const kit = await sh(
      path.join(w.root, 'usr/local/lib/oasis/deploy/scripts/site-deploy.sh'),
      ['--force'],
      w.env,
    )
    expect(kit.code, kit.out).toBe(0)
    expect(kit.out).not.toMatch(/not the root-owned kit/)
  }, 60_000)

  it('needs site.env, and the --help text describes every step', async () => {
    const t = tempDir('oasis-site-noenv-')
    cleanups.push(t.cleanup)
    const r = await sh(script('site-deploy.sh'), ['--list'], { OASIS_ROOT_PREFIX: t.dir })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/site\.env is missing: run install\.sh --site-domain/)
    const help = await sh(script('site-deploy.sh'), ['--help'])
    expect(help.code).toBe(0)
    for (const word of [
      '--rollback',
      '--list',
      '--skip-hours',
      '--dry-run',
      'git archive',
      'pnpm build',
      '25 MB',
      'REVISION',
      'SITE_KEEP',
    ])
      expect(help.stdout).toContain(word)
  })
})
