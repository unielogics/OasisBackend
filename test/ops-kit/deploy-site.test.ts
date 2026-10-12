// The public website on the same host (ADR 0145): what install.sh --site-domain renders (nginx servers, site.env, the placeholder
// release), the rendered site in a real nginx when one is installed, site-deploy.sh end to end against a real bare mirror with
// stand-ins for pnpm, the health check and chown, and the website probes of healthcheck.sh.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  chmodSync,
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

/** The website's default policy with Square's Web Payments SDK hosts (ADR 0171 D12): production, and the sandbox (--square-env). */
const squareCsp = (web: string, connect: string): string =>
  `default-src 'none'; script-src 'self' ${web}; style-src 'self' 'unsafe-inline' ${web}; img-src 'self' data:; font-src 'self' https://square-fonts-production-f.squarecdn.com https://d1g145x70srn7h.cloudfront.net; connect-src 'self' ${connect}; frame-src ${web}; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; upgrade-insecure-requests`
const SQUARE_CSP = {
  production: squareCsp('https://web.squarecdn.com', 'https://web.squarecdn.com https://pci-connect.squareup.com https://o160250.ingest.sentry.io'),
  sandbox: squareCsp('https://sandbox.web.squarecdn.com', 'https://sandbox.web.squarecdn.com https://pci-connect.squareupsandbox.com https://o160250.ingest.sentry.io'),
}

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

// user namespaces with mounts (unshare -rm), and a file this uid does not own to bind-mount: the foreign-file copy test needs both
const USERNS =
  statSync('/etc/passwd').uid !== process.getuid!() &&
  spawnSync('unshare', ['-rm', 'mount', '--bind', '/etc/passwd', '/etc/passwd']).status === 0

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
    // the catalog by vehicle size (catalog/v2, ADR 0170 wave Q3d) has the same exact location and treatment as v1
    for (const name of ['hours', 'availability', 'catalog', 'catalog/v2']) {
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
      // the hours and the open times are stale only while one request refreshes them, never because the API is down (W2 review
      // leftover: an outage must not freeze yesterday's hours or a board of taken times); the catalog may outlive an outage
      if (name.startsWith('catalog'))
        expect(find(l.body, 'proxy_cache_use_stale')[0]!.args, uri).toEqual(
          expect.arrayContaining(['error', 'timeout', 'updating', 'http_502', 'http_503']),
        )
      else expect(find(l.body, 'proxy_cache_use_stale').map((d) => d.args), uri).toEqual([['updating']])
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
    // the personal-link pages' API (ADR 0160): its own location and zone, never cached, no-store on every answer, no cookies, the
    // page's bearer session (Authorization) passed through untouched
    for (const uri of ['/api/v1/public/links/exchange', '/api/v1/public/links/me', '/api/v1/public/links/pay/start']) {
      const l = at(uri)
      expect(`${l.modifier} ${l.pattern}`, uri).toBe('^~ /api/v1/public/links/')
      expect(proxied(uri), uri).toBe('http://oasis_api')
      expect(find(l.body, 'proxy_cache').map((d) => d.args), uri).toEqual([['off']])
      expect(find(l.body, 'limit_req')[0]!.args, uri).toEqual(['zone=oasis_public_links', 'burst=20', 'nodelay'])
      expect(find(l.body, 'client_max_body_size')[0]!.args, uri).toEqual(['4k'])
      expect(cache(uri), uri).toBe('no-store')
      expect(find(l.body, 'proxy_hide_header').map((h) => h.args[0]), uri).toEqual(expect.arrayContaining(['Set-Cookie', 'Cache-Control']))
      expect(find(l.body, 'proxy_set_header').map((h) => h.args.join(' ')), uri).toContain('Cookie ')
      expect(find(l.body, 'proxy_set_header').map((h) => h.args[0]), uri).not.toContain('Authorization')
    }
    const links = locationsOf(apex()).find((x) => x.pattern === '/api/v1/public/links/' && x.modifier === '^~')!
    expect(find(links.body, 'include').map((i) => i.args[0])).toEqual(['/etc/nginx/oasis/proxy.conf'])
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
      // hours, availability, catalog, catalog/v2 (wave Q3d), links, the rest of the public prefix: all to the API
    ).toEqual(['http://oasis_api', 'http://oasis_api', 'http://oasis_api', 'http://oasis_api', 'http://oasis_api', 'http://oasis_api'])
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
    // self only, no inline script, no framing of the site; plus Square's Web Payments SDK (production hosts) for the card pages
    expect(headers['Content-Security-Policy']).toBe(SQUARE_CSP.production)
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

  it('--square-env sandbox puts Square’s sandbox hosts in the default policy; payment=() stays; a bad value or one with --site-csp is refused', async () => {
    const t = tempDir('oasis-site-square-')
    cleanups.push(t.cleanup)
    const env = { OASIS_ROOT_PREFIX: t.dir }
    const r = await sh(script('install.sh'), [...BASE_ARGS, ...SITE_ARGS, '--square-env', 'sandbox'], env)
    expect(r.code, r.out).toBe(0)
    const headers = Object.fromEntries(
      find(parseNginx(readText(path.join(t.dir, 'etc/nginx/oasis/site-headers.conf'))), 'add_header').map((h) => [h.args[0], h.args[1]]),
    )
    expect(headers['Content-Security-Policy']).toBe(SQUARE_CSP.sandbox)
    expect(headers['Content-Security-Policy']).not.toMatch(/https:\/\/web\.squarecdn\.com|pci-connect\.squareup\.com/)
    expect(headers['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()')
    // production is the default and can be named
    const prod = await sh(script('install.sh'), [...BASE_ARGS, ...SITE_ARGS, '--square-env', 'production'], env)
    expect(prod.code, prod.out).toBe(0)
    expect(readText(path.join(t.dir, 'etc/nginx/oasis/site-headers.conf'))).toContain(SQUARE_CSP.production)
    const bad = await sh(script('install.sh'), [...BASE_ARGS, ...SITE_ARGS, '--square-env', 'staging'], env)
    expect(bad.code).not.toBe(0)
    expect(bad.out).toMatch(/--square-env must be production or sandbox/)
    const both = await sh(script('install.sh'), [...BASE_ARGS, ...SITE_ARGS, '--square-env', 'sandbox', '--site-csp', "default-src 'self'"], env)
    expect(both.code).not.toBe(0)
    expect(both.out).toMatch(/--square-env picks the Square hosts of the default policy/)
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

  it('creates the website build user: its own system user and group, no shell, its own home (0700), never in the oasis group', async () => {
    // the staged run: the home exists, private
    const home = path.join(stage.root, 'var/lib/oasis-site')
    expect(statSync(home).isDirectory()).toBe(true)
    expect((statSync(home).mode & 0o777).toString(8)).toBe('700')
    // a dry run on a host without that user plans exactly this (an id stand-in: the user does not exist; oasis does)
    const t = tempDir('oasis-builduser-')
    cleanups.push(t.cleanup)
    const bin = path.join(t.dir, 'bin')
    writeExecutable(
      path.join(bin, 'id'),
      `#!/usr/bin/env bash\ncase " $* " in *" oasis-site "*) [ -e "$ID_STATE/site" ] || exit 1; [ "$1" = -nG ] && { echo "oasis-site $ID_GROUPS"; exit 0; }; echo 990; exit 0 ;; *" oasis "*) echo 992; exit 0 ;; esac\nexec /usr/bin/id "$@"\n`,
    )
    const env = { OASIS_ROOT_PREFIX: path.join(t.dir, 'root'), PATH: `${bin}:${process.env.PATH}`, ID_STATE: t.dir }
    const args = ['--domain', 'oasis.example.com', '--site-domain', SITE, '--dry-run']
    const dry = await sh(script('install.sh'), args, env)
    expect(dry.code, dry.out).toBe(0)
    expect(dry.out).toContain(
      '+ useradd --system --home-dir /var/lib/oasis-site --shell /sbin/nologin --user-group oasis-site\n',
    )
    expect(dry.out).toContain(`+ chmod 0700 ${env.OASIS_ROOT_PREFIX}/var/lib/oasis-site\n`)
    expect(dry.out).toContain(`+ chown oasis-site:oasis-site ${env.OASIS_ROOT_PREFIX}/var/lib/oasis-site\n`)
    expect(dry.out).not.toMatch(/usermod|gpasswd -a|-G oasis/)
    // idempotent: an existing user is left alone; one that was put into the oasis group is taken out of it
    writeFileSync(path.join(t.dir, 'site'), '')
    const again = await sh(script('install.sh'), args, env)
    expect(again.code, again.out).toBe(0)
    expect(again.out).toMatch(/ok\s+user oasis-site exists/)
    expect(again.out).not.toMatch(/useradd .*oasis-site/)
    const grouped = await sh(script('install.sh'), args, { ...env, ID_GROUPS: 'wheel oasis' })
    expect(grouped.code, grouped.out).toBe(0)
    expect(grouped.out).toContain('+ gpasswd -d oasis-site oasis\n')
    // without --site-domain there is no such user
    const plain = await sh(script('install.sh'), ['--domain', 'oasis.example.com', '--dry-run'], { ...env, ID_STATE: path.join(t.dir, 'none') })
    expect(plain.out).not.toMatch(/oasis-site/)
  })

  it('denies at, batch and cron to oasis and oasis-site: at.deny (and cron.deny) keep their other entries, 0600 root, idempotent', async () => {
    const t = tempDir('oasis-atdeny-')
    cleanups.push(t.cleanup)
    const root = t.dir
    mkdirSync(path.join(root, 'etc'), { recursive: true })
    // the host's own entries stay, in order (a blank line is no entry); oasis is already there once
    writeFileSync(path.join(root, 'etc/at.deny'), '\nguest\noasis\n\nbadbot\n')
    chmodSync(path.join(root, 'etc/at.deny'), 0o644)
    writeFileSync(path.join(root, 'etc/cron.deny'), 'someone\n')
    const install = () => sh(script('install.sh'), [...BASE_ARGS, ...SITE_ARGS], { OASIS_ROOT_PREFIX: root })
    const first = await install()
    expect(first.code, first.out).toBe(0)
    const mode = (f: string) => (statSync(path.join(root, f)).mode & 0o777).toString(8)
    expect(readFileSync(path.join(root, 'etc/at.deny'), 'utf8')).toBe('guest\noasis\nbadbot\noasis-site\n')
    expect(mode('etc/at.deny')).toBe('600')
    expect(readFileSync(path.join(root, 'etc/cron.deny'), 'utf8')).toBe('someone\noasis\noasis-site\n')
    expect(mode('etc/cron.deny')).toBe('600')
    // again: nothing changes
    const second = await install()
    expect(second.code, second.out).toBe(0)
    expect(second.out).toMatch(/ok\s+\S+\/etc\/at\.deny unchanged/)
    expect(second.out).toMatch(/ok\s+\S+\/etc\/cron\.deny unchanged/)
    expect(readFileSync(path.join(root, 'etc/at.deny'), 'utf8')).toBe('guest\noasis\nbadbot\noasis-site\n')
    // the right content with a loose mode: the mode is put back
    chmodSync(path.join(root, 'etc/at.deny'), 0o644)
    const third = await install()
    expect(third.code, third.out).toBe(0)
    expect(mode('etc/at.deny')).toBe('600')
    // an allow file overrides the deny file: one that lets either user in is reported
    writeFileSync(path.join(root, 'etc/at.allow'), 'oasis-site\n')
    const allowed = await install()
    expect(allowed.code, allowed.out).toBe(0)
    expect(allowed.out).toMatch(/ \/etc\/at\.allow exists and lists oasis-site/)
    // without cron.deny and without crontab on this host, no cron.deny is made
    const fresh = tempDir('oasis-atdeny-fresh-')
    cleanups.push(fresh.cleanup)
    const r = await sh(script('install.sh'), [...BASE_ARGS, ...SITE_ARGS], { OASIS_ROOT_PREFIX: fresh.dir })
    expect(r.code, r.out).toBe(0)
    expect(readFileSync(path.join(fresh.dir, 'etc/at.deny'), 'utf8')).toBe('oasis\noasis-site\n')
    const hasCrontab = spawnSync('bash', ['-c', 'command -v crontab']).status === 0
    expect(existsSync(path.join(fresh.dir, 'etc/cron.deny'))).toBe(hasCrontab)
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
              (req.url?.startsWith('/api/v1/public/links/') ? ` auth=${req.headers.authorization ?? 'none'}` : '') +
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
    expect(home.header('content-security-policy')).toEqual([SQUARE_CSP.production])
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
    for (const uri of ['/api/v1/public/availability?days=5', '/api/v1/public/catalog', '/api/v1/public/catalog/v2']) {
      const miss = await get(`${site}${uri}`, ['-H', 'Cookie: oasis_sid=visitor-cookie'])
      expect(miss.status, uri).toBe(200)
      expect(miss.header('x-cache-status'), uri).toEqual(['MISS'])
      expect(miss.header('set-cookie'), uri).toEqual([])
      once(miss, uri)
      const hit = await get(`${site}${uri}`)
      expect(hit.header('x-cache-status'), uri).toEqual(['HIT'])
    }
    expect(hits).toEqual([
      'GET /api/v1/public/availability?days=5 cookie=none',
      'GET /api/v1/public/catalog cookie=none',
      'GET /api/v1/public/catalog/v2 cookie=none',
    ])
    // the board's key is its two parameters: add-ons, junk and order do not make a new entry; another day count does
    for (const uri of [
      '/api/v1/public/availability?days=5&addons=wax%2Cclay',
      '/api/v1/public/availability?days=5&cb=1',
      '/api/v1/public/catalog?v=2',
      '/api/v1/public/catalog/v2?cb=1',
    ])
      expect((await get(`${site}${uri}`)).header('x-cache-status'), uri).toEqual(['HIT'])
    expect((await get(`${site}/api/v1/public/availability?days=6`)).header('x-cache-status')).toEqual(['MISS'])
    expect(hits).toHaveLength(4)
    // the cached routes take no POST
    const postHours = await get(`${site}/api/v1/public/hours`, ['-X', 'POST', '-d', '{}'])
    expect(postHours.status).toBe(403)
    once(postHours, 'POST hours')
    expect(hits).toHaveLength(4)

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

    // the personal-link API: passed through every time with the bearer header, never cached, one no-store, no cookie either way
    hits.length = 0
    const linkArgs = ['-X', 'POST', '-H', 'Content-Type: application/json', '-H', 'Cookie: oasis_sid=visitor-cookie', '-d', '{"token":"t0k3n"}']
    for (let i = 0; i < 2; i++) {
      const ex = await get(`${site}/api/v1/public/links/exchange`, linkArgs)
      expect(ex.status).toBe(200)
      expect(ex.header('cache-control')).toEqual(['no-store'])
      expect(ex.header('x-cache-status')).toEqual([])
      expect(ex.header('set-cookie')).toEqual([])
      once(ex, 'POST links/exchange')
    }
    const me = await get(`${site}/api/v1/public/links/me`, ['-H', 'Authorization: Bearer page-session'])
    expect(me.status).toBe(200)
    expect(me.header('cache-control')).toEqual(['no-store'])
    expect(hits).toEqual([
      'POST /api/v1/public/links/exchange cookie=none auth=none idem=none body={"token":"t0k3n"}',
      'POST /api/v1/public/links/exchange cookie=none auth=none idem=none body={"token":"t0k3n"}',
      'GET /api/v1/public/links/me cookie=none auth=Bearer page-session',
    ])
    const big = await get(`${site}/api/v1/public/links/exchange`, ['-X', 'POST', '-H', 'Content-Type: application/json', '-d', `{"token":"${'x'.repeat(5000)}"}`])
    expect(big.status).toBe(413)
    expect(big.header('cache-control')).toEqual(['no-store'])
    once(big, '413 links')

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
echo "pnpm $* cwd=$(basename "$PWD") uid=$(id -u) HOME=$HOME CI=$CI SITE_URL=\${SITE_URL-unset} SITE_HOURS_JSON=\${SITE_HOURS_JSON-unset} NODE_OPTIONS=\${NODE_OPTIONS-unset} AWS=\${AWS_ACCESS_KEY_ID-unset} SECRET=\${OASIS_SECRET_ID-unset}" >> "$SHIM_LOG"
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
    [ -e "$SHIM_STATE/evil-dirlink" ] && ln -s "$OUTSIDE/certs" dist/assets/certs
    [ -e "$SHIM_STATE/evil-hardlink" ] && ln "$OUTSIDE/notes.txt" dist/assets/notes.txt
    [ -e "$SHIM_STATE/big-file" ] && truncate -s 26M dist/assets/huge.bin
    [ -e "$SHIM_STATE/huge-total" ] && truncate -s 300M dist/assets/sparse.bin
    [ -e "$SHIM_STATE/tiny-total" ] || head -c 65536 /dev/zero > dist/assets/vendor.js
    [ -e "$SHIM_STATE/odd-mode" ] && chmod 0640 dist/assets/vendor.js
    # a dependency that leaves a job behind to run once the build is over (an at or batch job, a crontab)
    [ -e "$SHIM_STATE/queue-at" ] && printf '9\\tSat Oct 10 23:59:00 2026 a oasis-site\\n' >> "$SHIM_STATE/atq"
    [ -e "$SHIM_STATE/queue-cron" ] && echo '* * * * * /var/lib/oasis-site/.cache/x' >> "$SHIM_STATE/crontab"
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
  writeExecutable(path.join(bin, 'reap.sh'), `#!/usr/bin/env bash\necho "reap $*" >> "$SHIM_LOG"\n`)
  // atq (root lists every user's at and batch jobs: number, date, queue, user) and crontab -l -u USER, from files in the state
  writeExecutable(
    path.join(bin, 'atq.sh'),
    `#!/usr/bin/env bash\necho "atq $*" >> "$SHIM_LOG"\ncat "$SHIM_STATE/atq" 2>/dev/null\nexit 0\n`,
  )
  writeExecutable(
    path.join(bin, 'crontab.sh'),
    `#!/usr/bin/env bash
echo "crontab $*" >> "$SHIM_LOG"
[ -s "$SHIM_STATE/crontab" ] || { echo "no crontab for $3" >&2; exit 1; }
cat "$SHIM_STATE/crontab"
`,
  )
  // cp: root's copy of dist/ goes through the real cp; a process racing that copy (what the reaping and the job checks exist to
  // prevent) acts right before it starts or right after it ends. race-link: a directory of dist/ becomes a link to outside the moment
  // the copy starts. race-fifo: a special file appears in the copy. race-foreign: a file root owns (FOREIGN_FILE, bind-mounted inside
  // a user namespace, where it shows as the overflow uid) appears in the copy: what a copy that followed a directory swapped for a link
  // mid-copy yields (review 2026-10-10: a root 0600 privkey.pem landed in the copy as a regular file)
  writeExecutable(
    path.join(bin, 'cp'),
    `#!/usr/bin/env bash
src=\${@: -2:1}
dst=\${@: -1}
racing=no
case "$src" in */src/dist) racing=yes ;; esac
[ $racing = yes ] && echo "cp $*" >> "$SHIM_LOG"
if [ $racing = yes ] && [ -e "$SHIM_STATE/race-link" ]; then
  mv "$src/assets" "$src/assets.real" && ln -s "$OUTSIDE/certs" "$src/assets" && echo "race swapped $src/assets" >> "$SHIM_LOG"
fi
PATH=\${PATH#"$(dirname "$0"):"} command cp "$@" || exit
if [ $racing = yes ] && [ -e "$SHIM_STATE/race-fifo" ]; then
  mkfifo "$dst/assets/pipe" && echo "race planted $dst/assets/pipe" >> "$SHIM_LOG"
fi
if [ $racing = yes ] && [ -e "$SHIM_STATE/race-foreign" ]; then
  : > "$dst/assets/privkey.pem" && mount --bind "$FOREIGN_FILE" "$dst/assets/privkey.pem" && echo "race planted $dst/assets/privkey.pem" >> "$SHIM_LOG"
fi
exit 0
`,
  )

  // The build user's code acting outside the build, the way a compromised dependency could (a process the build left behind). It
  // only touches what that user could: a directory some logged chown handed to a non-root owner (and nothing gave back to root),
  // and everything below it. Everything here runs as one uid, so the chown log stands in for the permissions.
  const outside = path.join(root, 'outside')
  mkdirSync(path.join(outside, 'certs'), { recursive: true })
  for (const [f, body] of [
    ['certs/privkey.pem', 'PRIVATE KEY\n'],
    ['hours-target', 'ROOT FILE\n'],
    ['notes.txt', 'NOTES\n'],
  ] as const) {
    writeFileSync(path.join(outside, f), body)
    chmodSync(path.join(outside, f), 0o600)
  }
  writeExecutable(
    path.join(bin, 'evil.sh'),
    `#!/usr/bin/env bash
# evil.sh early|late: early = while root prepares the build (before the hours snapshot); late = after root verified dist/
builder_owns() {
  local p=$1 verdict=no line a owner
  while read -r line; do
    set -- $line; shift
    while [[ $1 == -* ]]; do shift; done
    owner=$1; shift
    for a in "$@"; do
      if [[ $p == "$a" || $p == "$a"/* ]]; then if [[ $owner == root:* ]]; then verdict=no; else verdict=yes; fi; fi
    done
  done < <(grep '^chown ' "$SHIM_LOG")
  [[ $verdict == yes ]]
}
for part in "$SITE_ROOT"/releases/*.partial; do
  [ -d "$part" ] || continue
  case "$1" in
    early)
      if [ -e "$SHIM_STATE/evil-hours" ] && builder_owns "$part/hours.json"; then
        ln -s "$OUTSIDE/hours-target" "$part/hours.json" && echo "evil planted $part/hours.json" >> "$SHIM_LOG"
      fi ;;
    late)
      d="$part/src/dist"
      [ -d "$d" ] && [ ! -L "$d" ] || continue
      if [ -e "$SHIM_STATE/evil-revision" ] && builder_owns "$d/REVISION"; then
        ln -s "$OUTSIDE/revision-target" "$d/REVISION" && echo "evil planted $d/REVISION" >> "$SHIM_LOG"
      fi
      if [ -e "$SHIM_STATE/evil-swap" ] && builder_owns "$d"; then
        mv "$d" "$part/src/dist.real" && ln -s "$OUTSIDE/certs" "$d" && echo "evil swapped $d" >> "$SHIM_LOG"
      fi ;;
  esac
done
exit 0
`,
  )
  // du: the size root reports once dist/ is verified (du -sh): the moment a left-behind process would strike
  writeExecutable(
    path.join(bin, 'du'),
    `#!/usr/bin/env bash
[ "$1" = -sh ] && "$(dirname "$0")/evil.sh" late
PATH=\${PATH#"$(dirname "$0"):"} exec du "$@"
`,
  )
  // the service-user wrapper: the build user's code also runs whenever root runs something as that user
  writeExecutable(
    path.join(bin, 'runas-site.sh'),
    `#!/usr/bin/env bash\necho "runas-site $1" >> "$SHIM_LOG"\n"$(dirname "$0")/evil.sh" early\nexec "$@"\n`,
  )

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
    OASIS_RUN_AS: path.join(bin, 'runas-site.sh'),
    OASIS_SITE_RUN_AS: path.join(bin, 'runas-site.sh'),
    OASIS_SITE_REAP_CMD: path.join(bin, 'reap.sh'),
    OASIS_SITE_ATQ_CMD: path.join(bin, 'atq.sh'),
    OASIS_SITE_CRONTAB_CMD: path.join(bin, 'crontab.sh'),
    OASIS_SITE_BUILD_ENV_PASS: 'SHIM_LOG SHIM_STATE OUTSIDE',
    OUTSIDE: outside,
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
  it('sends kill -1 only through runuser as the unprivileged build user (as root it would signal every process on the host)', () => {
    const src = readFileSync(script('site-deploy.sh'), 'utf8')
    const kills = src.split('\n').filter((l) => /\bkill\b[^#]*-1\b/.test(l) && !l.trim().startsWith('#'))
    expect(kills).toEqual(['      $OASIS_SITE_RUN_AS kill -s KILL -1 2>/dev/null || true'])
    expect(src).toMatch(/if \[\[ -n "\$OASIS_SITE_RUN_AS" && "\$SITE_USER" != root && "\$\(id -u "\$SITE_USER" 2>\/dev\/null\)" =~ \^\[1-9\]\[0-9\]\*\$ \]\]; then\n\s+# shellcheck disable=SC2086\n\s+\$OASIS_SITE_RUN_AS kill -s KILL -1/)
  })

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
      /cwd=src uid=\d+ HOME=\S+\/var\/lib\/oasis-site CI=1 SITE_URL=https:\/\/example\.com SITE_HOURS_JSON=\S+\.partial\/hours\.json NODE_OPTIONS=--max-old-space-size=2048/,
    )
    expect(w.log().filter((l) => l.startsWith('pnpm'))).toEqual([
      expect.stringMatching(/^pnpm install --frozen-lockfile cwd=src/),
      build,
    ])
    // the accepted copy becomes root's before REVISION and the modes, while still inside the root-only .partial
    expect(w.log()).toContain(`chown -h -R root:root ${rel}.partial/release`)
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
      ['symlink', /the copy of dist\/ holds what the build user oasis-site did not make[^]*assets\/passwd \(symbolic link, owner uid \d+\)/],
      ['big-file', /file over 25 MB: \S+huge\.bin/],
      ['tiny-total', /total size \d+ bytes is below 50 KB/],
      ['huge-total', /total size \d+ bytes is above 200 MB/],
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
    // an output over the size bound is refused before root copies it (a sparse file counts in full: the copy cannot fill the disk)
    for (const f of w.releases().filter((r) => r.endsWith('.failed')))
      expect(existsSync(path.join(w.siteRoot, 'releases', f, 'release/assets/sparse.bin')), f).toBe(false)
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
    // a dry run only asks (whether the build user has work scheduled); it builds and changes nothing
    expect(w.log()).toEqual(['atq ', 'crontab -l -u oasis-site'])
    const dryBack = await w.deploy('--rollback', '--dry-run')
    expect(dryBack.code, dryBack.out).toBe(0)
    expect(dryBack.out).toMatch(/\+ ln -sfn/)
    expect(tree(w.siteRoot)).toEqual(before)
  }, 90_000)

  it('the export and the build run as the website build user (not oasis), with its own home and only the build environment', async () => {
    const w = await makeSiteWorld()
    const runasOasis = path.join(w.root, 'shims/runas-oasis.sh')
    writeExecutable(runasOasis, `#!/usr/bin/env bash\necho "runas-oasis $1" >> "$SHIM_LOG"\nexec "$@"\n`)
    // what root's environment holds never reaches the build (the AWS identity, the secret's name)
    const r = await sh(script('site-deploy.sh'), [], {
      ...w.env,
      OASIS_RUN_AS: runasOasis,
      AWS_ACCESS_KEY_ID: 'AKIAROOTSKEY',
      OASIS_SECRET_ID: 'oasis/prod/app',
    })
    expect(r.code, r.out).toBe(0)
    expect(w.log().filter((l) => l.startsWith('runas-oasis'))).toEqual([])
    expect(w.log().filter((l) => l.startsWith('runas-site'))).toEqual(['runas-site tar', 'runas-site env'])
    const build = w.log().find((l) => l.startsWith('pnpm build'))!
    expect(build).toMatch(/HOME=\S+\/var\/lib\/oasis-site CI=1 /)
    expect(build).toMatch(/ AWS=unset SECRET=unset/)
    // only the build directory is handed to that user; the leftovers of the build are stopped before root takes the output
    expect(w.log().filter((l) => l.startsWith('chown') && !/ root:root /.test(l))).toEqual([
      expect.stringMatching(/^chown -h oasis-site:oasis-site \S+\.partial\/src$/),
    ])
    const order = w.log().map((l) => l.split(' ')[0])
    // anything left of the build user goes before the build, and the build's own leftovers before root takes the output
    expect(order.indexOf('reap')).toBeLessThan(order.indexOf('pnpm'))
    expect(order.lastIndexOf('reap')).toBeGreaterThan(order.lastIndexOf('pnpm'))
    // before the build, after it, and once more after the check for scheduled work
    expect(w.log().filter((l) => l.startsWith('reap'))).toEqual(['reap oasis-site', 'reap oasis-site', 'reap oasis-site'])
    expect(order.lastIndexOf('reap')).toBeLessThan(order.indexOf('site-health'))
    expect(r.out).toMatch(/building the website as oasis-site/)
    // a failed build is reaped too
    w.clearLog()
    w.flag('fail-build')
    expect((await w.deploy('--force')).code).toBe(1)
    expect(w.log().filter((l) => l.startsWith('reap'))).toEqual(['reap oasis-site', 'reap oasis-site'])
    w.flag('fail-build', false)
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
  }, 90_000)

  it('refuses to build when the build user can read the configuration or the state (the isolation check)', async () => {
    const w = await makeSiteWorld()
    // here the "build user" is this uid, which owns the staged /etc/oasis: exactly what the check exists to catch
    const r = await sh(script('site-deploy.sh'), [], { ...w.env, OASIS_SITE_CHECK_ISOLATION: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/the website build user oasis-site can read \(or enter\) .*\/etc\/oasis\/common\.env.*\/var\/lib\/oasis .*\/var\/backups\/oasis and must not/)
    expect(r.out).toMatch(/install\.sh --site-domain/)
    expect(w.log().filter((l) => l.startsWith('pnpm'))).toEqual([])
    expect(w.current()).toBe('bootstrap')
  }, 60_000)

  it('a build that plants links or swaps paths, during the build or after verification, never makes root write, chmod or serve anything outside the release', async () => {
    const w = await makeSiteWorld()
    const outside = w.env.OUTSIDE!
    const snapshot = (): string[] =>
      tree(outside).map((l) => {
        const f = path.join(outside, l.split(' ')[0]!)
        return statSync(f).isFile() ? `${l} ${readFileSync(f, 'utf8').trim()}` : l
      })
    const before = snapshot()
    expect(before).toContain('certs/privkey.pem 12 600 PRIVATE KEY')
    const releasesDir = path.join(w.siteRoot, 'releases')
    for (const flags of [['evil-hours'], ['evil-revision'], ['evil-swap'], ['evil-hardlink'], ['evil-dirlink']]) {
      w.clearLog()
      for (const f of flags) w.flag(f)
      const r = await w.deploy('--force')
      for (const f of flags) w.flag(f, false)
      expect(snapshot(), `${flags} ${r.out}`).toEqual(before) // nothing outside changed: modes, contents, no new file
      expect(existsSync(path.join(outside, 'revision-target')), `${flags}`).toBe(false)
      expect(existsSync(path.join(outside, 'certs/REVISION')), `${flags}`).toBe(false)
      // whatever happened, what nginx serves is a real directory in releases/ without a link in it
      const cur = realpathSync(path.join(w.siteRoot, 'current'))
      expect(path.dirname(cur), `${flags} ${r.out}`).toBe(releasesDir)
      expect(lstatSync(path.join(releasesDir, path.basename(cur))).isDirectory()).toBe(true)
      expect((await sh('find', [cur, '-type', 'l'])).stdout, `${flags}`).toBe('')
      expect(readFileSync(path.join(cur, 'index.html'), 'utf8'), `${flags}`).toContain('Oasis Auto Spa')
      expect(
        w.releases().filter((x) => x.endsWith('.partial')),
        `${flags}`,
      ).toEqual([])
      if (flags[0] === 'evil-hardlink') {
        expect(r.code, r.out).toBe(1)
        expect(r.out).toMatch(/hard link in the output: \S+notes\.txt/)
      }
      if (flags[0] === 'evil-dirlink') {
        expect(r.code, r.out).toBe(1)
        expect(r.out).toMatch(/the copy of dist\/ holds what[^]*assets\/certs \(symbolic link, owner uid \d+\)/)
      }
      // the attack ran: the swap and the planted REVISION happened (in the build tree, after root took its copy); the hours file
      // could not be planted at all, since the directory root writes it into is not the build user's
      if (flags[0] === 'evil-swap') expect(w.log().some((l) => /^evil swapped \S+\.partial\/src\/dist$/.test(l))).toBe(true)
      if (flags[0] === 'evil-revision')
        expect(w.log().some((l) => /^evil planted \S+\.partial\/src\/dist\/REVISION$/.test(l))).toBe(true)
      if (flags[0] === 'evil-hours') expect(w.log().filter((l) => l.startsWith('evil'))).toEqual([])
      if (flags[0] === 'evil-swap' || flags[0] === 'evil-revision' || flags[0] === 'evil-hours') {
        expect(r.code, `${flags} ${r.out}`).toBe(0)
        // the release is the build's own output, and root's REVISION is a file in it
        expect(lstatSync(path.join(cur, 'REVISION')).isFile()).toBe(true)
        expect(revision(w).site).toMatch(/^[0-9a-f]{40}$/)
      }
    }
  }, 180_000)

  it('a job the build user left to run later (at, batch, cron, a lingering user manager) refuses the deploy: before the build, and after it before anything is copied', async () => {
    const w = await makeSiteWorld()
    expect((await w.deploy()).code).toBe(0)
    const atq = path.join(w.state, 'atq')
    const crontab = path.join(w.state, 'crontab')
    // other users' jobs are not the build user's (root sees everyone's queue)
    writeFileSync(atq, '3\tSat Oct 10 23:00:00 2026 a root\n4\tSat Oct 10 23:00:00 2026 b oasis-siteX\n')
    w.clearLog()
    const others = await w.deploy('--force')
    expect(others.code, others.out).toBe(0)
    const good = w.current()
    // asked before the build and again after it (before the copy)
    expect(w.log().filter((l) => /^(atq|crontab) /.test(l))).toEqual([
      'atq ',
      'crontab -l -u oasis-site',
      'atq ',
      'crontab -l -u oasis-site',
    ])
    const order = w.log().map((l) => l.split(' ')[0])
    expect(order.indexOf('atq')).toBeLessThan(order.indexOf('pnpm'))
    const reapAfterBuild = order.findIndex((x, i) => x === 'reap' && i > order.lastIndexOf('pnpm'))
    expect(order.lastIndexOf('atq')).toBeGreaterThan(reapAfterBuild)
    expect(order.lastIndexOf('atq')).toBeLessThan(order.indexOf('cp'))
    rmSync(atq)
    const linger = path.join(w.root, 'var/lib/systemd/linger/oasis-site')
    const before: [string, () => void, RegExp][] = [
      ['an at job', () => writeFileSync(atq, '7\tSat Oct 10 23:59:00 2026 a oasis-site\n'), /at or batch job 7 .*sudo atrm 7/],
      ['a batch job', () => writeFileSync(atq, '8\tSat Oct 10 23:59:00 2026 b oasis-site\n'), /at or batch job 8 /],
      ['a running job', () => writeFileSync(atq, '6\tSat Oct 10 23:59:00 2026 = oasis-site\n'), /at or batch job 6 /],
      ['a crontab', () => writeFileSync(crontab, '@reboot /var/lib/oasis-site/x\n'), /a crontab .*sudo crontab -r -u oasis-site/],
      [
        'lingering',
        () => {
          mkdirSync(path.dirname(linger), { recursive: true })
          writeFileSync(linger, '')
        },
        /lingering .*sudo loginctl disable-linger oasis-site/,
      ],
    ]
    for (const [name, setup, message] of before) {
      const releases = w.releases()
      setup()
      w.clearLog()
      const r = await w.deploy('--force')
      rmSync(atq, { force: true })
      rmSync(crontab, { force: true })
      rmSync(linger, { force: true })
      expect(r.code, `${name} ${r.out}`).toBe(1)
      expect(r.out, name).toMatch(/oasis-site has work scheduled to run later, which no deploy may race:/)
      expect(r.out, name).toMatch(message)
      expect(r.out, name).toMatch(/Nothing was built and nothing changed/)
      expect(w.log().filter((l) => l.startsWith('pnpm')), name).toEqual([])
      expect(w.releases(), name).toEqual(releases) // not even a .failed: nothing started
      expect(w.current(), name).toBe(good)
    }
    // queued by the build itself: refused after the build, before root copies anything out of it
    for (const flag of ['queue-at', 'queue-cron']) {
      w.flag(flag)
      w.clearLog()
      const r = await w.deploy('--force')
      w.flag(flag, false)
      rmSync(atq, { force: true })
      rmSync(crontab, { force: true })
      expect(r.code, `${flag} ${r.out}`).toBe(1)
      expect(r.out, flag).toMatch(/oasis-site has work scheduled to run later, which no deploy may race:/)
      expect(r.out, flag).toMatch(/the build is kept in \S+\.failed/)
      expect(w.log().filter((l) => l.startsWith('pnpm build')), flag).toHaveLength(1)
      expect(w.log().filter((l) => l.startsWith('cp ')), flag).toEqual([])
      const failed = w.releases().filter((x) => x.endsWith('.failed')).sort().at(-1)!
      expect(existsSync(path.join(w.siteRoot, 'releases', failed, 'release')), flag).toBe(false)
      expect(w.current(), flag).toBe(good)
    }
    // with nothing left scheduled it deploys again
    const again = await w.deploy('--force')
    expect(again.code, again.out).toBe(0)
  }, 180_000)

  it('root copies dist/ with owner, mode and times kept, and rejects a copy holding a link or special file before REVISION or any mode change', async () => {
    const w = await makeSiteWorld()
    w.flag('odd-mode')
    const first = await w.deploy()
    expect(first.code, first.out).toBe(0)
    expect(w.log()).toContainEqual(
      expect.stringMatching(/^cp -R -P --preserve=mode,ownership,timestamps -- \S+\.partial\/src\/dist \S+\.partial\/release$/),
    )
    // the modes are root's to set, once the copy is accepted
    const good = w.current()
    expect((statSync(path.join(w.siteRoot, 'current/assets/vendor.js')).mode & 0o777).toString(8)).toBe('644')
    const outside = w.env.OUTSIDE!
    for (const [flag, entry] of [
      ['race-fifo', /assets\/pipe \(fifo, owner uid \d+\)/],
      ['race-link', /assets \(symbolic link, owner uid \d+\)/],
    ] as const) {
      w.flag(flag)
      w.clearLog()
      const r = await w.deploy('--force')
      w.flag(flag, false)
      expect(r.code, `${flag} ${r.out}`).toBe(1)
      expect(w.log().some((l) => l.startsWith('race ')), flag).toBe(true)
      expect(r.out, flag).toMatch(/the copy of dist\/ holds what the build user oasis-site did not make/)
      expect(r.out, flag).toMatch(entry)
      expect(r.out, flag).toMatch(/kept in \S+\.failed/)
      // rejected as copied: no REVISION written, no mode changed, nothing chowned, never served
      const failed = w.releases().filter((x) => x.endsWith('.failed')).sort().at(-1)!
      const copy = path.join(w.siteRoot, 'releases', failed, 'release')
      expect(existsSync(path.join(copy, 'REVISION')), flag).toBe(false)
      if (flag === 'race-fifo') expect((statSync(path.join(copy, 'assets/vendor.js')).mode & 0o777).toString(8)).toBe('640')
      expect(w.log().filter((l) => l.startsWith('chown') && /\.partial\/release$/.test(l)), flag).toEqual([])
      expect(w.log().filter((l) => l.startsWith('site-health')), flag).toEqual([])
      expect(w.current(), flag).toBe(good)
    }
    expect(tree(outside)).toContain('certs/privkey.pem 12 600')
  }, 120_000)

  // A copy that followed a directory swapped for a link mid-copy holds the files of whoever owns the target (root's private key in the
  // review). Only root can make a file another user owns, so this runs inside a user namespace (this uid is root there, and a file the
  // real root owns shows as the overflow uid) with such a file bind-mounted into the copy. Skipped where user namespaces are off.
  it.skipIf(!USERNS)(
    'a copy holding a file the build user does not own is rejected before REVISION, chown or any mode change (user namespace)',
    async () => {
      const w = await makeSiteWorld()
      const ns = (...args: string[]) =>
        sh('unshare', ['-rm', script('site-deploy.sh'), ...args], {
          ...w.env,
          OASIS_KIT_TRUST_UID: '0',
          FOREIGN_FILE: '/etc/passwd',
        })
      // the control: the same run without the planted file deploys
      const ok = await ns()
      expect(ok.code, ok.out).toBe(0)
      const good = w.current()
      w.flag('race-foreign')
      w.flag('odd-mode')
      w.clearLog()
      const r = await ns('--force')
      w.flag('race-foreign', false)
      expect(r.code, r.out).toBe(1)
      expect(w.log().some((l) => /^race planted \S+\/release\/assets\/privkey\.pem$/.test(l))).toBe(true)
      expect(r.out).toMatch(/the copy of dist\/ holds what the build user oasis-site did not make/)
      expect(r.out).toMatch(/assets\/privkey\.pem \(file, owner uid \d+\)/)
      const failed = w.releases().filter((x) => x.endsWith('.failed')).sort().at(-1)!
      const copy = path.join(w.siteRoot, 'releases', failed, 'release')
      expect(existsSync(path.join(copy, 'REVISION'))).toBe(false)
      expect((statSync(path.join(copy, 'assets/vendor.js')).mode & 0o777).toString(8)).toBe('640')
      expect(w.log().filter((l) => l.startsWith('chown') && /\.partial\/release$/.test(l))).toEqual([])
      expect(w.current()).toBe(good)
    },
    120_000,
  )

  it('a failed deploy keeps previous on the release before it, so --rollback still goes back; --list shows both tags when they meet', async () => {
    const w = await makeSiteWorld()
    const ids: string[] = []
    for (const v of ['v2', 'v3']) {
      await w.commit({ VERSION: `${v}\n` })
      const r = await w.deploy()
      expect(r.code, r.out).toBe(0)
      ids.push(w.current())
    }
    const [a, b] = ids as [string, string]
    expect([w.current(), w.previous()]).toEqual([b, a])
    // a new release that nginx does not serve healthily: switched back, and previous is still a
    w.flag('bad')
    const failed = await w.deploy('--force')
    w.flag('bad', false)
    expect(failed.code).toBe(1)
    expect([w.current(), w.previous()]).toEqual([b, a])
    const list = await w.deploy('--list')
    expect(list.stdout.trim().split('\n')).toEqual([
      'bootstrap bootstrap',
      expect.stringMatching(new RegExp(`^${a} \\w{12} <- previous$`)),
      expect.stringMatching(new RegExp(`^${b} \\w{12} <- current$`)),
    ])
    // the one-command rollback works: back to a, and forward again
    const back = await w.deploy('--rollback')
    expect(back.code, back.out).toBe(0)
    expect([w.current(), w.previous()]).toEqual([a, b])
    const forward = await w.deploy('--rollback')
    expect(forward.code, forward.out).toBe(0)
    expect([w.current(), w.previous()]).toEqual([b, a])
    // a verification failure changes neither link either
    w.flag('no-404')
    expect((await w.deploy('--force')).code).toBe(1)
    w.flag('no-404', false)
    expect([w.current(), w.previous()]).toEqual([b, a])
    // a host whose links already meet (left so by an older kit): --list says so instead of hiding current
    symlinkSync(path.join(w.siteRoot, 'releases', b), path.join(w.siteRoot, 'previous.tmp'))
    await sh('mv', ['-T', path.join(w.siteRoot, 'previous.tmp'), path.join(w.siteRoot, 'previous')])
    const met = await w.deploy('--list')
    expect(met.stdout).toMatch(new RegExp(`^${b} \\w{12} <- current, previous$`, 'm'))
    expect((await w.deploy('--rollback')).out).toMatch(/is already the current release \(try --list, then --rollback --to <id>\)/)
  }, 120_000)

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
